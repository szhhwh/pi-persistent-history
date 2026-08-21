/**
 * Reverse-i-search style prompt history search.
 *
 * Opened with Ctrl+R (wired in index.ts) or via the `/history` command. Renders a
 * small modal overlay with a live-filtering text box over the persisted prompt
 * history. The matched substring is highlighted; Up/Down (or pressing Ctrl+R
 * again) move through the hits, Enter fills the editor, Esc closes.
 *
 * Rendered with ctx.ui.custom() as a capturing overlay, the same mechanism the
 * config panel uses. The Input box is kept focused (focused = true) so the
 * hardware cursor shows while typing.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	Input,
	parseKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { getAllHistoryEntries, getHistoryEntries } from "./index";

const MAX_LIST = 10;

/** Collapse whitespace so multi-line prompts display on a single row. */
function flatten(entry: string): string {
	return entry.replace(/\s+/g, " ");
}

/** Escape regex metacharacters so a literal query matches verbatim. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap every case-insensitive match of `q` in `fn`, leaving the rest intact.
 * Uses a regex with the `gi` flags (global is required: exec() must advance
 * lastIndex or the loop below never terminates — an infinite loop that froze
 * the TUI) so multi-character case folds (e.g. ß→ss) are highlighted across
 * their full extent rather than sliced by length. */
function highlight(text: string, q: string, fn: (s: string) => string): string {
	if (!q) return text;
	const re = new RegExp(escapeRegExp(q), "gi");
	let out = "";
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const idx = m.index;
		const match = m[0];
		out += text.slice(last, idx);
		out += fn(match);
		last = idx + match.length;
		if (match.length === 0) re.lastIndex++; // avoid zero-width infinite loop
	}
	out += text.slice(last);
	return out;
}

/**
 * Open the search popup. Returns when the popup is closed (Enter, Esc, or the
 * overlay is dismissed).
 */
export async function openSearch(ui: ExtensionUIContext, cwd: string): Promise<void> {
	await ui.custom<void>((tui: TUI, theme: Theme, kb, done) => {

		// Search scope: "project" = the current scope's history; "all" = global
		// file + every project file, merged and de-duplicated.
		let scope: "project" | "all" = "project";
		const loadEntries = (): string[] => {
			const raw = scope === "all" ? getAllHistoryEntries() : getHistoryEntries(cwd);
			const seen = new Set<string>();
			const list: string[] = [];
			for (const e of raw) {
				if (seen.has(e)) continue;
				seen.add(e);
				list.push(e);
			}
			return list;
		};
		let entries = loadEntries();

		const input = new Input();
		input.setValue("");
		input.focused = true; // show the hardware cursor in the search box

		let query = "";
		let filtered: string[] = entries;
		let selected = 0;

		const recompute = () => {
			const q = query.toLowerCase();
			filtered = q ? entries.filter((e) => flatten(e).toLowerCase().includes(q)) : entries;
			if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
		};

		const move = (dir: number) => {
			if (filtered.length === 0) return;
			selected = (selected + dir + filtered.length) % filtered.length;
			tui.requestRender();
		};

		const accept = () => {
			const entry = filtered[selected];
			if (entry !== undefined) ui.setEditorText(entry);
			done();
		};

		const toggleScope = () => {
			scope = scope === "project" ? "all" : "project";
			entries = loadEntries();
			recompute();
			selected = 0;
			tui.requestRender();
		};

		const title = theme.fg("accent", theme.bold("Search prompt history"));
		const b = (s: string) => theme.fg("border", s);
		const dim = (s: string) => theme.fg("dim", s);
		const padLine = (line: string, w: number): string => {
			const t = truncateToWidth(line, w, "");
			return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
		};
		const center = (line: string, w: number): string => {
			const t = truncateToWidth(line, w, "");
			const vis = visibleWidth(t);
			const left = Math.max(0, Math.floor((w - vis) / 2));
			return " ".repeat(left) + t + " ".repeat(Math.max(0, w - vis - left));
		};

		return {
			render: (w: number) => {
				const inner = Math.max(1, w - 2);
				const header = [center(title, inner), dim("─".repeat(inner)), ""];
				const searchRow = padLine(input.render(inner)[0] ?? "", inner);
				const sep = dim("─".repeat(inner));

				const listLines: string[] = [];
				if (filtered.length === 0) {
					listLines.push("  " + dim("(no matches)"));
				} else {
					const start = Math.max(
						0,
						Math.min(selected - Math.floor(MAX_LIST / 2), filtered.length - MAX_LIST),
					);
					const end = Math.min(start + MAX_LIST, filtered.length);
					for (let i = start; i < end; i++) {
						const flat = flatten(filtered[i]);
						const plain = truncateToWidth(flat, inner - 2, "");
						const text = highlight(plain, query, (m) => theme.fg("accent", m));
						const prefix = i === selected ? theme.fg("accent", "→ ") : "  ";
						const line = prefix + text;
					listLines.push(
						i === selected
							? theme.bg("selectedBg", padLine(line, inner))
							: padLine(line, inner),
					);
					}
					if (filtered.length > MAX_LIST) {
						listLines.push("  " + dim(`${selected + 1}/${filtered.length}`));
					}
				}

				const content = [
					...header,
					searchRow,
					sep,
					dim(
						`  scope: ${scope === "all" ? "all (global + projects)" : "project"}   ·   Tab toggles scope`,
					),
					...listLines,
					dim("  Tab: scope · ↑↓: move · Enter: use · Esc: close"),
				];
				const rule = "─".repeat(Math.max(0, w - 2));
				const top = b(`┌${rule}┐`);
				const bottom = b(`└${rule}┘`);
				return [top, ...content.map((line) => b("│") + padLine(line, inner) + b("│")), bottom];
			},
			handleInput: (data: string) => {
				if (parseKey(data) === "ctrl+r") {
					move(1); // Ctrl+R again jumps to the next hit (bash-style)
					return;
				}
				if (parseKey(data) === "tab") {
					toggleScope();
					return;
				}
				if (kb.matches(data, "tui.select.up")) {
					move(-1);
					return;
				}
				if (kb.matches(data, "tui.select.down")) {
					move(1);
					return;
				}
				if (kb.matches(data, "tui.select.confirm")) {
					accept();
					return;
				}
				if (kb.matches(data, "tui.select.cancel")) {
					done();
					return;
				}
				const before = input.getValue();
				input.handleInput(data);
				const after = input.getValue();
				if (before !== after) {
					query = after;
					recompute();
					selected = 0;
				}
				tui.requestRender();
			},
			invalidate: () => input.invalidate(),
		};
	}, {
		overlay: true,
		overlayOptions: { width: "65%", maxHeight: "85%", anchor: "center", margin: 2 },
	});
}

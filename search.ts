/**
 * Docked reverse-i-search prompt history.
 *
 * Rendered as an aboveEditor extension widget — the same dock style as the
 * pi-processes dock: a full-width panel flush above the input editor with a
 * dim "── Search prompt history ──" title bar, one space of side padding, no
 * side borders and no bottom border, so it opens straight into the editor
 * below. While open, raw keystrokes are intercepted via ui.onTerminalInput
 * and routed to the search state machine; the editor never sees them.
 *
 * Opened with Ctrl+R (wired in index.ts) or via the `/history` command.
 * Keys: type to filter · ↑↓/Ctrl+R move · Tab toggles scope · Enter fills
 * the editor · Esc (or Ctrl+C) closes.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Input, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { getAllHistoryEntries, getHistoryEntries } from "./index";

const SEARCH_WIDGET_KEY = "prompt-history-search";
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

/** Live state of an open search dock. Exactly one instance at a time. */
interface SearchSession {
	ui: ExtensionUIContext;
	cwd: string;
	tui: TUI | null;
	theme: Theme | null;
	input: Input;
	scope: "project" | "all";
	entries: string[];
	query: string;
	filtered: string[];
	selected: number;
	close: () => void;
}

let session: SearchSession | null = null;

/** Load the current scope's entries, de-duplicated, newest first. */
function loadEntries(s: SearchSession): string[] {
	const raw = s.scope === "all" ? getAllHistoryEntries() : getHistoryEntries(s.cwd);
	const seen = new Set<string>();
	const list: string[] = [];
	for (const e of raw) {
		if (seen.has(e)) continue;
		seen.add(e);
		list.push(e);
	}
	return list;
}

function recompute(s: SearchSession): void {
	const q = s.query.toLowerCase();
	s.filtered = q ? s.entries.filter((e) => flatten(e).toLowerCase().includes(q)) : s.entries;
	if (s.selected >= s.filtered.length) s.selected = Math.max(0, s.filtered.length - 1);
}

function move(s: SearchSession, dir: number): void {
	if (s.filtered.length === 0) return;
	s.selected = (s.selected + dir + s.filtered.length) % s.filtered.length;
	s.tui?.requestRender();
}

function accept(s: SearchSession): void {
	const entry = s.filtered[s.selected];
	if (entry !== undefined) s.ui.setEditorText(entry);
	s.close();
}

function toggleScope(s: SearchSession): void {
	s.scope = s.scope === "project" ? "all" : "project";
	s.entries = loadEntries(s);
	recompute(s);
	s.selected = 0;
	s.tui?.requestRender();
}

/** Route one raw keystroke to the search; called only while the dock is open. */
function handleKey(s: SearchSession, data: string): void {
	const key = parseKey(data);
	switch (key) {
		case "ctrl+r": // next hit, bash-style
			move(s, 1);
			return;
		case "tab":
			toggleScope(s);
			return;
		case "up":
			move(s, -1);
			return;
		case "down":
			move(s, 1);
			return;
		case "enter":
			accept(s);
			return;
		case "escape":
		case "ctrl+c":
			s.close();
			return;
	}
	// Everything else (printable text, backspace, in-query cursor moves,
	// paste) goes to the Input component.
	const before = s.input.getValue();
	s.input.handleInput(data);
	const after = s.input.getValue();
	if (before !== after) {
		s.query = after;
		recompute(s);
		s.selected = 0;
	}
	s.tui?.requestRender();
}

/**
 * Render the dock in the pi-processes minimal-box style: a dim full-width
 * title bar, body rows with one space of side padding, a full-width rule
 * under the query row, and NO side/bottom borders — the dock opens straight
 * into the editor below.
 */
function renderDock(s: SearchSession, width: number): string[] {
	const theme = s.theme;
	if (!theme || width <= 0) return [];
	const dim = (t: string) => theme.fg("dim", t);

	const lines: string[] = [];

	// Title bar: "── Search prompt history ─────" (full width, no padding).
	const title = s.scope === "all" ? "Search prompt history (all)" : "Search prompt history";
	const label = `── ${title} `;
	const labelWidth = visibleWidth(label);
	lines.push(
		labelWidth >= width
			? dim("─".repeat(width))
			: dim(label) + dim("─".repeat(width - labelWidth)),
	);

	// Body rows: one space of side padding, blank-padded to full width.
	const inner = Math.max(0, width - 2);
	const row = (content: string): string => {
		const t = truncateToWidth(content, inner, "");
		return ` ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} `;
	};

	// Query row (Input renders its own "> " prompt and fake cursor).
	lines.push(row(s.input.render(inner)[0] ?? ""));

	// Full-width rule between the query and the results (dock divider).
	lines.push(dim("─".repeat(width)));

	// Scope line.
	lines.push(
		row(
			dim(
				`scope: ${s.scope === "all" ? "all (global + projects)" : "project"}   ·   Tab toggles scope`,
			),
		),
	);

	// Result rows.
	if (s.filtered.length === 0) {
		lines.push(row(dim("(no matches)")));
	} else {
		const start = Math.max(
			0,
			Math.min(s.selected - Math.floor(MAX_LIST / 2), s.filtered.length - MAX_LIST),
		);
		const end = Math.min(start + MAX_LIST, s.filtered.length);
		for (let i = start; i < end; i++) {
			const flat = flatten(s.filtered[i]);
			const plain = truncateToWidth(flat, inner - 4, "");
			const text = highlight(plain, s.query, (m) => theme.fg("accent", m));
			const prefix = i === s.selected ? theme.fg("accent", "→ ") : "  ";
			const content = `${prefix}${text}`;
			lines.push(
				i === s.selected ? theme.bg("selectedBg", row(content)) : row(content),
			);
		}
		if (s.filtered.length > MAX_LIST) {
			lines.push(row(dim(`${s.selected + 1}/${s.filtered.length}`)));
		}
	}

	// Hint footer.
	lines.push(row(dim("Tab: scope · ↑↓: move · Enter: use · Esc: close")));
	return lines;
}

/**
 * Open the docked search above the input editor. The returned promise
 * resolves when the search closes (Enter, Esc, Ctrl+C, or closeSearch()).
 * A second call while open resolves immediately.
 */
export function openSearch(ui: ExtensionUIContext, cwd: string): Promise<void> {
	if (session) return Promise.resolve();
	return new Promise((resolve) => {
		const s: SearchSession = {
			ui,
			cwd,
			tui: null,
			theme: null,
			input: new Input(),
			scope: "project",
			entries: [],
			query: "",
			filtered: [],
			selected: 0,
			close: () => undefined,
		};
		s.input.setValue("");
		s.input.focused = true; // render the fake cursor in the query box
		s.entries = loadEntries(s);
		s.filtered = s.entries;

		const component = {
			render: (w: number) => renderDock(s, w),
			invalidate: () => undefined,
		};
		// The factory runs synchronously inside setWidget, so tui/theme are
		// captured before the first render.
		ui.setWidget(
			SEARCH_WIDGET_KEY,
			(tui: TUI, theme: Theme) => {
				s.tui = tui;
				s.theme = theme;
				return component;
			},
			{ placement: "aboveEditor" },
		);

		const unsubscribe = ui.onTerminalInput((data) => {
			if (!session) return;
			handleKey(session, data);
			return { consume: true };
		});

		s.close = () => {
			if (session !== s) return;
			session = null;
			unsubscribe();
			ui.setWidget(SEARCH_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			resolve();
		};

		session = s;
		s.tui?.requestRender();
	});
}

/** Force-close an open search (e.g. session shutdown / extension teardown). */
export function closeSearch(): void {
	session?.close();
}

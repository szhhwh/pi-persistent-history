/**
 * Docked reverse-i-search prompt history.
 *
 * Implemented as a focusable TUI component (extends Container, exposes a
 * `focused` setter + `handleInput`) and opened via `ui.custom()`, so the dock
 * receives keystrokes through the TUI's focused-component input path — the
 * same path the main editor uses. That path already filters Kitty keyboard
 * protocol key-release events (tui.js: isKeyRelease guard) and handles all
 * legacy/CSI-u decoding, so this component does NOT need to do any of that
 * itself. In particular, a plain printable keypress is no longer inserted
 * twice (once for the press text and once for the release CSI-u, which
 * Input.handleInput's decodeKittyPrintable would otherwise turn back into a
 * character).
 *
 * Opened with Ctrl+R (wired in index.ts) or via the `/history` command.
 * While open the dock replaces the editor (ui.custom inline mode); choosing
 * an entry fills the editor, Esc/Ctrl+C restores the prior editor text.
 * Keys: type to filter · ↑↓/Ctrl+R move · Tab toggles scope · Enter fills the
 * editor · Esc (or Ctrl+C) closes.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Container, Input, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { config, getAllHistoryEntries, getHistoryEntries } from "./index";

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

/** Load a scope's entries, de-duplicated, newest first. */
function loadEntries(scope: "project" | "all", cwd: string): string[] {
	const raw = scope === "all" ? getAllHistoryEntries() : getHistoryEntries(cwd);
	const seen = new Set<string>();
	const list: string[] = [];
	for (const e of raw) {
		if (seen.has(e)) continue;
		seen.add(e);
		list.push(e);
	}
	return list;
}

/**
 * Focusable reverse-i-search dock. Rendered as a full-width panel with a dim
 * "── Search prompt history ──" title bar, one space of side padding, no side
 * borders. Fixed height: the result list always renders exactly
 * config.searchRows rows (blank-padded when fewer), so the layout never jumps
 * while typing.
 */
class SearchDockComponent extends Container {
	private cwd: string;
	private tui: TUI;
	private theme: Theme;
	private onSelect: (entry: string | undefined) => void;
	readonly input = new Input();
	scope: "project" | "all" = "project";
	entries: string[] = [];
	query = "";
	filtered: string[] = [];
	selected = 0;
	private _focused = false;

	constructor(opts: {
		cwd: string;
		tui: TUI;
		theme: Theme;
		onSelect: (entry: string | undefined) => void;
	}) {
		super();
		this.cwd = opts.cwd;
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.onSelect = opts.onSelect;
		this.input.setValue("");
		this.input.focused = true; // render the fake cursor in the query box
		this.entries = loadEntries(this.scope, this.cwd);
		this.filtered = this.entries;
	}

	// --- Focusable interface -------------------------------------------------

	/** isFocusable() checks for the presence of `focused`; propagate to Input
	 * so its fake cursor renders while the dock holds focus. */
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	// Component does not opt into Kitty key-release events; the TUI drops them
	// before calling handleInput (tui.js: isKeyRelease guard), so release CSI-u
	// sequences never reach Input.handleInput and thus cannot be double-inserted.
	// (Declaring `wantsKeyRelease = false` is implicit — omitted for brevity.)

	/** Route one keystroke to the search. Release events are already filtered
	 * upstream by the focused-component path. */
	handleInput(data: string): void {
		const key = parseKey(data);
		switch (key) {
			case "ctrl+r": // next hit, bash-style
				this.move(1);
				return;
			case "tab":
				this.toggleScope();
				return;
			case "up":
				this.move(-1);
				return;
			case "down":
				this.move(1);
				return;
			case "enter":
				this.accept();
				return;
			case "escape":
			case "ctrl+c":
				this.cancel();
				return;
		}
		// Everything else (printable text, backspace, in-query cursor moves,
		// paste) goes to the Input component.
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (before !== after) {
			this.query = after;
			this.recompute();
			this.selected = 0;
		}
		this.tui.requestRender();
	}

	// --- Search state machine ------------------------------------------------

	private recompute(): void {
		const q = this.query.toLowerCase();
		this.filtered = q
			? this.entries.filter((e) => flatten(e).toLowerCase().includes(q))
			: this.entries;
		if (this.selected >= this.filtered.length)
			this.selected = Math.max(0, this.filtered.length - 1);
	}

	private move(dir: number): void {
		if (this.filtered.length === 0) return;
		this.selected = (this.selected + dir + this.filtered.length) % this.filtered.length;
		this.tui.requestRender();
	}

	private accept(): void {
		const entry = this.filtered[this.selected];
		this.onSelect(entry);
	}

	private cancel(): void {
		this.onSelect(undefined);
	}

	private toggleScope(): void {
		this.scope = this.scope === "project" ? "all" : "project";
		this.entries = loadEntries(this.scope, this.cwd);
		this.recompute();
		this.selected = 0;
		this.tui.requestRender();
	}

	// --- Rendering -----------------------------------------------------------

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme || width <= 0) return [];
		const dim = (t: string) => theme.fg("dim", t);

		const lines: string[] = [];

		// Title bar: "── Search prompt history ─────" (full width, no padding).
		const title =
			this.scope === "all" ? "Search prompt history (all)" : "Search prompt history";
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
		lines.push(row(this.input.render(inner)[0] ?? ""));

		// Full-width rule between the query and the results (dock divider).
		lines.push(dim("─".repeat(width)));

		// Scope line.
		lines.push(
			row(
				dim(
					`scope: ${this.scope === "all" ? "all (all projects)" : "project"}   ·   Tab toggles scope`,
				),
			),
		);

		// Result rows: fixed height — exactly `rows` lines whether matched, fewer,
		// or none, so the dock never jumps while typing.
		const rows = Math.max(1, config.searchRows);
		if (this.filtered.length === 0) {
			// A genuinely empty project view is worth explaining: the per-project
			// history only starts accruing from now on, and the rest of the old
			// history is still reachable under the "all" scope.
			const empty =
				this.scope === "project" && this.entries.length === 0
					? "(no history for this project yet — Tab to search all)"
					: "(no matches)";
			lines.push(row(dim(empty)));
			for (let i = 1; i < rows; i++) lines.push(row(""));
		} else {
			const start = Math.max(
				0,
				Math.min(this.selected - Math.floor(rows / 2), this.filtered.length - rows),
			);
			const end = Math.min(start + rows, this.filtered.length);
			for (let i = start; i < end; i++) {
				const flat = flatten(this.filtered[i]);
				const plain = truncateToWidth(flat, inner - 4, "");
				const text = highlight(plain, this.query, (m) => theme.fg("accent", m));
				const prefix = i === this.selected ? theme.fg("accent", "→ ") : "  ";
				const content = `${prefix}${text}`;
				lines.push(
					i === this.selected ? theme.bg("selectedBg", row(content)) : row(content),
				);
			}
			// Blank-pad to the fixed height.
			for (let i = end - start; i < rows; i++) lines.push(row(""));
		}

		// Hint footer with the position counter folded in (still exactly one row).
		const counter =
			this.filtered.length > rows ? `${this.selected + 1}/${this.filtered.length} · ` : "";
		lines.push(row(dim(`${counter}Tab: scope · ↑↓: move · Enter: use · Esc: close`)));
		return lines;
	}
}

/**
 * The close callback of the currently-open dock, so closeSearch() can tear it
 * down on session shutdown. Null when no dock is open.
 */
let currentClose: ((result?: unknown) => void) | null = null;

/**
 * Open the reverse-i-search as a focused component (ui.custom inline mode,
 * which temporarily replaces the editor). The returned promise resolves when
 * the search closes (Enter, Esc, Ctrl+C, or closeSearch()). A second call
 * while open resolves immediately.
 */
export function openSearch(ui: ExtensionUIContext, cwd: string): Promise<void> {
	if (currentClose) return Promise.resolve();
	return ui
		.custom((tui: TUI, theme: Theme, _keybindings, close) => {
			const dock = new SearchDockComponent({
				cwd,
				tui,
				theme,
				onSelect: (entry) => {
					// Order matters. pi's close() synchronously restores the editor's
					// pre-open text (savedText) and focus, and the Enter keystroke that
					// led here schedules an immediate repaint via process.nextTick.
					// Setting the chosen entry must therefore happen synchronously
					// AFTER close(), so that very frame already paints the entry.
					// Doing it in a .then() on the ui.custom() promise is too late:
					// showExtensionCustom is async, so the promise resolution lags the
					// repaint by two microtask hops, and setText() itself requests no
					// render — the first Ctrl+R run painted a stale (empty) editor and
					// the entry only appeared after the next unrelated repaint.
					close(entry);
					if (typeof entry === "string") ui.setEditorText(entry);
				},
			});
			currentClose = close;
			return dock;
		})
		.then(() => {
			// The chosen entry (if any) was already applied synchronously in
			// onSelect above; nothing to do when the promise settles.
		})
		.finally(() => {
			currentClose = null;
		});
}

/** Force-close an open search (e.g. session shutdown / extension teardown). */
export function closeSearch(): void {
	currentClose?.();
	currentClose = null;
}
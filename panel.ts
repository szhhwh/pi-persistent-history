/**
 * Interactive configuration panel for the persistent-history extension.
 *
 * Rendered via ctx.ui.custom() as a modal overlay built on pi-tui's
 * SettingsList. The panel is DOCKED: anchored bottom-center directly above
 * the input editor (fixed width, content-driven height) instead of floating
 * in the middle of the screen. The dock offset is measured live from the
 * TUI layout (editor block + footer) so it tracks editor growth and any
 * extension widgets mounted below the editor.
 *
 * Boolean/enum options cycle on Enter/Space; numeric options open a
 * single-line text-input submenu. Every accepted change is applied live
 * through setOption() (which updates the running editor and persists to
 * disk), and invalid input is reverted with a warning.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	type SettingItem,
	type SettingsListTheme,
	SettingsList,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	VStack,
} from "@earendil-works/pi-tui";

import {
	activeEditor,
	config,
	onOff,
	setOption,
	statusText,
} from "./index";

/** Fallback dock offset: empty editor (border+line+border) + one footer row. */
const DEFAULT_DOCK_MARGIN = 4;

/** Fixed panel width in columns (clamped by the TUI on narrow terminals). */
const PANEL_WIDTH = 72;

/** Whether `node` is, or contains, the live editor instance. */
function containsEditor(node: unknown, editor: object | null, depth = 0): boolean {
	if (node === null || node === undefined || depth > 4) return false;
	if (node === editor) return true;
	const kids = (node as { children?: unknown }).children;
	if (!Array.isArray(kids)) return false;
	return kids.some((k) => containsEditor(k, editor, depth + 1));
}

/**
 * Rows occupied by the bottom-docked stack (the editor container through the
 * last child: editor, widgets-below, footer). The panel's bottom margin is
 * set to this sum, so it hugs the input box regardless of editor height.
 * Note: widgets mounted ABOVE the editor are overlapped, not offset past —
 * the dock hugs the editor block itself.
 */
export function dockedBottomMargin(tui: TUI): number {
	try {
		const width = Math.max(1, tui.terminal.columns);
		const children = tui.children;
		if (!Array.isArray(children) || children.length === 0) return DEFAULT_DOCK_MARGIN;
		let start = children.findIndex((c) => containsEditor(c, activeEditor));
		if (start === -1) {
			// Editor not found (replaced?): assume the standard pi mount order,
			// whose last four children are widgets/editor/widgets/footer.
			start = Math.max(0, children.length - 4);
		}
		let margin = 0;
		for (let i = start; i < children.length; i++) {
			const c = children[i] as { render?: (w: number) => string[] };
			if (typeof c?.render === "function") margin += c.render(width).length;
		}
		return margin > 0 ? margin : DEFAULT_DOCK_MARGIN;
	} catch {
		return DEFAULT_DOCK_MARGIN;
	}
}

/**
 * Open the config panel. In non-TUI contexts (or where the custom overlay is
 * unavailable) it falls back to printing the status text.
 */
export async function openConfigPanel(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify(statusText(activeEditor?.cwd ?? ctx.cwd), "info");
		return;
	}

	// Captured when the factory runs so overlayOptions() (invoked right after)
	// can measure the live layout.
	let tuiRef: TUI | null = null;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		tuiRef = tui;
		const settingsTheme: SettingsListTheme = {
			label: (text, selected) => (selected ? theme.fg("accent", text) : text),
			value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
			description: (text) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text) => theme.fg("dim", text),
		};

		// Track the last accepted value per option so we can revert to it when
		// the user submits an invalid value through a submenu.
		const lastGood = new Map<string, string>();

		// Free-text submenu for the numeric options: a single-line input that
		// commits on Enter and cancels on Esc.
		const numericSubmenu = (
			label: string,
			currentValue: string,
			finish: (value?: string) => void,
		): Component => {
			const input = new Input();
			input.setValue(currentValue);
			input.onSubmit = (value: string) => finish(value.trim());
			input.onEscape = () => finish();
			// Show which option is being edited above the single-line input.
			return new VStack([new Text(label), input]);
		};

		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "Enabled",
				description: "Record prompt history to disk on every submit.",
				currentValue: onOff(config.enabled),
				values: ["on", "off"],
			},
			{
				id: "scope",
				label: "Scope",
				description: "global = one shared history; project = one file per working directory.",
				currentValue: config.scope,
				values: ["global", "project"],
			},
			{
				id: "dedup",
				label: "Deduplicate",
				description: "consecutive = skip repeats while typing; always = no duplicates; off = keep all.",
				currentValue: config.dedup,
				values: ["consecutive", "always", "off"],
			},
			{
				id: "recordCommands",
				label: "Record commands",
				description: 'Persist "/" and "!" inputs into the history file.',
				currentValue: onOff(config.recordCommands),
				values: ["on", "off"],
			},
			{
				id: "maxEntries",
				label: "Max entries",
				description: "Maximum number of entries retained.",
				currentValue: String(config.maxEntries),
				submenu: (v, finish) => numericSubmenu("Max entries", v, finish),
			},
			{
				id: "maxEntryChars",
				label: "Max entry chars",
				description: "Entries longer than this stay in memory only and are never written to disk.",
				currentValue: String(config.maxEntryChars),
				submenu: (v, finish) => numericSubmenu("Max entry chars", v, finish),
			},
			{
				id: "minLength",
				label: "Min length",
				description: "Skip entries shorter than this many characters.",
				currentValue: String(config.minLength),
				submenu: (v, finish) => numericSubmenu("Min length", v, finish),
			},
		];
		for (const it of items) lastGood.set(it.id, it.currentValue);

		const onChange = (id: string, value: string): void => {
			const result = setOption(id, value);
			if (result.ok) {
				lastGood.set(id, value);
			} else {
				// SettingsList already wrote the bad value inline; revert it.
				const prev = lastGood.get(id);
				if (prev !== undefined) list.updateValue(id, prev);
				ctx.ui.notify(result.message, "warning");
			}
			tui.requestRender();
		};

		const list = new SettingsList(items, items.length + 4, settingsTheme, onChange, () => done(), {
			enableSearch: false,
		});

		const title = theme.fg("accent", theme.bold("Prompt History · Settings"));
		const b = (s: string) => theme.fg("border", s);
		const dim = (s: string) => theme.fg("dim", s);
		// Pad a (possibly ANSI-styled) line to exactly `w` visible columns so the
		// right border stays aligned.
		const padLine = (line: string, w: number): string => {
			const t = truncateToWidth(line, w, "");
			return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
		};
		// Center a line within `w` visible columns.
		const center = (line: string, w: number): string => {
			const t = truncateToWidth(line, w, "");
			const vis = visibleWidth(t);
			const left = Math.max(0, Math.floor((w - vis) / 2));
			return " ".repeat(left) + t + " ".repeat(Math.max(0, w - vis - left));
		};

		return {
			render: (w: number) => {
				const inner = Math.max(1, w - 2); // content width between the side borders
				const header = [
					"", // top breathing room
					center(title, inner), // centered title
					dim("─".repeat(inner)), // divider under the title
					"", // gap before the list
				];
				const content = [...header, ...list.render(inner)];
				const rule = "─".repeat(Math.max(0, w - 2));
				const top = b(`┌${rule}┐`);
				const bottom = b(`└${rule}┘`);
				const body = content.map((line) => b("│") + padLine(line, inner) + b("│"));
				return [top, ...body, bottom];
			},
			handleInput: (data: string) => list.handleInput(data),
			invalidate: () => list.invalidate(),
		};
	}, {
		overlay: true,
		overlayOptions: () => ({
			width: PANEL_WIDTH,
			anchor: "bottom-center",
			margin: { bottom: tuiRef ? dockedBottomMargin(tuiRef) : DEFAULT_DOCK_MARGIN },
			maxHeight: "85%", // safety clamp on very short terminals
		}),
	});
}

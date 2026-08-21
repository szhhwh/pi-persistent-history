/**
 * Interactive configuration panel for the persistent-history extension.
 *
 * Rendered via ctx.ui.custom() as a modal overlay built on pi-tui's
 * SettingsList. Boolean/enum options cycle on Enter/Space; numeric options
 * open a single-line text-input submenu. Every accepted change is applied
 * live through setOption() (which updates the running editor and persists to
 * disk), and invalid input is reverted with a warning.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	type SettingItem,
	type SettingsListTheme,
	SettingsList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import {
	activeEditor,
	config,
	onOff,
	setOption,
	statusText,
} from "./index";

/**
 * Open the config panel. In non-TUI contexts (or where the custom overlay is
 * unavailable) it falls back to printing the status text.
 */
export async function openConfigPanel(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify(statusText(activeEditor?.cwd ?? ctx.cwd), "info");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
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
			_label: string,
			currentValue: string,
			finish: (value?: string) => void,
		): Component => {
			const input = new Input();
			input.setValue(currentValue);
			input.onSubmit = (value: string) => finish(value.trim());
			input.onEscape = () => finish();
			return input;
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

		const list = new SettingsList(items, items.length + 4, settingsTheme, onChange, () => done(), {
			enableSearch: false,
		});

		function onChange(id: string, value: string): void {
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
		}

		const title = theme.fg("accent", theme.bold("Prompt History · Settings"));
		const b = (s: string) => theme.fg("border", s);
		// Pad a (possibly ANSI-styled) line to exactly `w` visible columns so the
		// right border stays aligned.
		const padLine = (line: string, w: number): string => {
			const t = truncateToWidth(line, w, "");
			return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
		};

		return {
			render: (w: number) => {
				const inner = Math.max(1, w - 2); // content width between the side borders
				const content = [title, "", ...list.render(inner)];
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
		overlayOptions: { width: "75%", maxHeight: "85%", anchor: "center", margin: 2 },
	});
}

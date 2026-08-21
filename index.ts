/**
 * Persistent prompt history
 *
 * Persists the input editor's prompt history (the buffer browsed with
 * up/down arrows) to disk so it survives restarts of pi.
 *
 * Storage (history content):
 *   - scope "global":  ~/.pi/agent/prompt-history.json            (shared everywhere)
 *   - scope "project": ~/.pi/agent/prompt-histories/<dir>.json    (per working directory)
 *   Config:            ~/.pi/agent/prompt-history.config.json
 * Files are created 0600 (dirs 0700) and existing files are tightened on load.
 *
 * Configure with the /history-settings command, or search with /history:
 *   /history-settings               open the interactive config panel (TUI)
 *   /history                        open the reverse-i-search popup (TUI)
 *   /history show [n]               list recent n entries (default 10)
 *   /history pick                   pick an entry into the editor (TUI)
 *   /history set <key> <value>      change an option (applies live)
 *   /history remove <substr>        delete matching entries
 *   /history clear [--all] [--yes]  wipe stored history
 *   /history reload                 reload history from disk
 *   /history path                   show storage file location
 *
 * Options (via the config panel, or /history set):
 *   enabled        on | off                 record history to disk (default on)
 *   maxEntries     <number>                 history size cap (default 500)
 *   maxEntryChars  <number>                 entries longer than this stay in
 *                                          memory only, never written (default 100000)
 *   scope          global | project         shared or per-directory (default global)
 *   dedup          consecutive | always | off  duplicate handling (default consecutive)
 *   recordCommands on | off                 persist "/" and "!" inputs (default off)
 *   minLength      <number>                 skip entries shorter than this (default 0)
 *
 * Persistence semantics:
 *   - The on-disk file is re-filtered against the current config on every
 *     write; tightening maxEntryChars/minLength/recordCommands purges
 *     non-matching entries on the next submit.
 *   - Writes merge with the on-disk file (exact duplicates collapse,
 *     newest first), so entries added by another pi process survive.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { parseKey } from "@earendil-works/pi-tui";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { openConfigPanel } from "./panel";
import { openSearch } from "./search";

const CONFIG_FILE = join(homedir(), ".pi", "agent", "prompt-history.config.json");
const GLOBAL_HISTORY_FILE = join(homedir(), ".pi", "agent", "prompt-history.json");
const PROJECT_HISTORY_DIR = join(homedir(), ".pi", "agent", "prompt-histories");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
	enabled: boolean;
	maxEntries: number;
	maxEntryChars: number;
	scope: "global" | "project";
	dedup: "consecutive" | "always" | "off";
	recordCommands: boolean;
	minLength: number;
}

const DEFAULT_CONFIG: Config = {
	enabled: true,
	maxEntries: 500,
	maxEntryChars: 100_000,
	scope: "global",
	dedup: "consecutive",
	recordCommands: false,
	minLength: 0,
};

let configWarning: string | null = null;
export let config: Config = loadConfig();
sweepStaleTmp(); // best-effort cleanup of temp files left by crashed sessions

function loadConfig(): Config {
	let rawText: string;
	try {
		rawText = readFileSync(CONFIG_FILE, "utf8");
	} catch {
		return { ...DEFAULT_CONFIG }; // No file yet: plain defaults.
	}
	tightenFile(CONFIG_FILE);
	try {
		return normalizeConfig(JSON.parse(rawText), DEFAULT_CONFIG);
	} catch {
		// Fail safe: an existing-but-unreadable config must not silently
		// re-enable persistence the user had turned off.
		configWarning =
			`prompt-history: ${CONFIG_FILE} is unreadable; persistence disabled. ` +
			"Fix or delete the file, then run /history reload.";
		return { ...DEFAULT_CONFIG, enabled: false };
	}
}

function normalizeConfig(raw: unknown, previous: Config): Config {
	const c = { ...previous };
	if (typeof raw !== "object" || raw === null) return c;
	const r = raw as Record<string, unknown>;
	if (typeof r.enabled === "boolean") c.enabled = r.enabled;
	if (typeof r.maxEntries === "number" && Number.isInteger(r.maxEntries) && r.maxEntries >= 1) {
		c.maxEntries = r.maxEntries;
	}
	if (
		typeof r.maxEntryChars === "number" &&
		Number.isInteger(r.maxEntryChars) &&
		r.maxEntryChars >= 1
	) {
		c.maxEntryChars = r.maxEntryChars;
	}
	if (r.scope === "global" || r.scope === "project") c.scope = r.scope;
	if (r.dedup === "consecutive" || r.dedup === "always" || r.dedup === "off") c.dedup = r.dedup;
	if (typeof r.recordCommands === "boolean") c.recordCommands = r.recordCommands;
	if (typeof r.minLength === "number" && Number.isInteger(r.minLength) && r.minLength >= 0) {
		c.minLength = r.minLength;
	}
	return c;
}

function saveConfig(): void {
	writeAtomic(CONFIG_FILE, JSON.stringify(config, null, "\t") + "\n");
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Strip group/other bits from an existing (regular) file (one-time migration). */
function tightenFile(file: string): void {
	try {
		const st = lstatSync(file);
		if (st.isSymbolicLink()) {
			// A symlink at the config/history path would have chmod applied to its
			// target. Remove it so writeAtomic recreates a safe regular file.
			unlinkSync(file);
			return;
		}
		if (st.mode & 0o077) chmodSync(file, st.mode & 0o700);
	} catch {
		// Missing file: nothing to do.
	}
}

function writeAtomic(file: string, content: string): void {
	try {
		ensurePrivateDirs();
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		// Unpredictable tmp name + O_EXCL: no symlink-planting target, no
		// cross-writer races, and never writes through an existing path.
		const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(tmp, file);
	} catch {
		// Persistence is best-effort; the session keeps working in memory.
	}
}

/** Tighten the two storage directories to 0700 (safe-direction only). */
function ensurePrivateDirs(): void {
	for (const dir of [dirname(CONFIG_FILE), PROJECT_HISTORY_DIR]) {
		try {
			const st = statSync(dir);
			if (st.mode & 0o077) chmodSync(dir, st.mode & 0o700);
		} catch {
			// Directory may not exist yet; mkdirSync above creates it 0700.
		}
	}
}

/**
 * Remove stale temp files left behind if a prior process crashed between the
 * write and the rename. A tmp whose embedded pid is no longer running is orphaned.
 */
function sweepStaleTmp(): void {
	for (const dir of [dirname(CONFIG_FILE), PROJECT_HISTORY_DIR]) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const m = /^(.*)\.(\d+)\.[0-9a-f]+\.tmp$/.exec(name);
			if (!m) continue;
			const pid = Number.parseInt(m[2], 10);
			let alive = false;
			try {
				process.kill(pid, 0);
				alive = true;
			} catch {
				// ESRCH: not running → orphaned.
			}
			if (alive) continue;
			try {
				unlinkSync(join(dir, name));
			} catch {
				// Lost the race or already gone.
			}
		}
	}
}

export function historyFileFor(cwd: string): string {
	if (config.scope === "global") return GLOBAL_HISTORY_FILE;
	const sanitized = cwd.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "root";
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
	return join(PROJECT_HISTORY_DIR, `${sanitized.slice(0, 100)}-${hash}.json`);
}

function loadEntries(file: string): string[] {
	try {
		tightenFile(file); // tighten perms even for non-array / corrupt files
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (Array.isArray(data)) {
			return data.filter((x): x is string => typeof x === "string");
		}
	} catch {
		// Missing or corrupt file: start fresh.
	}
	return [];
}

function saveEntries(file: string, entries: string[]): void {
	// Compact JSON: the history file is rewritten on every submit.
	writeAtomic(file, JSON.stringify(entries));
}

/** Whether an entry may be written to disk under the current config. */
function isPersistable(entry: string): boolean {
	if (entry.length > config.maxEntryChars) return false;
	if (entry.length < config.minLength) return false;
	if (!config.recordCommands && (entry.startsWith("/") || entry.startsWith("!"))) return false;
	return true;
}

/**
 * Merge-flush the live history into the file. Both sides are filtered by the
 * current config, exact duplicates collapse (newest first), so entries added
 * by a concurrent pi process survive.
 */
/** Write an in-memory list to disk, filtered by isPersistable. Used by the
 * destructive commands that must hit disk even when recording is disabled. */
function persistMemory(file: string, entries: string[]): void {
	saveEntries(file, entries.filter(isPersistable).slice(0, config.maxEntries));
}

/**
 * Merge-flush the live history into the file, honoring the dedup setting. The
 * on-disk file is re-read and re-merged on every attempt so an entry added by a
 * concurrent pi process is not lost (best-effort; no file lock).
 */
function persistEntries(file: string, live: string[]): void {
	if (!config.enabled) return;
	const MAX_ATTEMPTS = 3;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const merged = mergeEntries(live, loadEntries(file));
		saveEntries(file, merged);
		const after = loadEntries(file);
		const mergedSet = new Set(merged);
		if (!after.some((e) => !mergedSet.has(e))) return;
	}
}

/** Merge live memory with the on-disk list, honoring the dedup setting. */
function mergeEntries(live: string[], disk: string[]): string[] {
	const persistable = [...live.filter(isPersistable), ...disk.filter(isPersistable)];
	if (config.dedup === "off") {
		return persistable.slice(0, config.maxEntries); // keep all
	}
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const entry of persistable) {
		if (config.dedup === "always" && seen.has(entry)) continue;
		if (config.dedup === "consecutive" && merged.length > 0 && merged[merged.length - 1] === entry) {
			continue;
		}
		seen.add(entry);
		merged.push(entry);
		if (merged.length >= config.maxEntries) break;
	}
	return merged;
}

function listHistoryFiles(): string[] {
	const files: string[] = [];
	try {
		statSync(GLOBAL_HISTORY_FILE);
		files.push(GLOBAL_HISTORY_FILE);
	} catch {
		// No global file.
	}
	try {
		for (const f of readdirSync(PROJECT_HISTORY_DIR)) {
			if (f.endsWith(".json")) files.push(join(PROJECT_HISTORY_DIR, f));
		}
	} catch {
		// No project dir.
	}
	return files;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/**
 * Current history entries (live memory when available, else on-disk), newest
 * first. Used by the search popup so it can scan both the in-memory list and
 * the persisted file.
 */
export function getHistoryEntries(cwd: string): string[] {
	return activeEditor ? activeEditor.memory() : loadEntries(historyFileFor(cwd));
}

/**
 * All history entries across every scope (global file + all project files),
 * merged and de-duplicated, newest occurrence kept. Used by the search popup's
 * "all" mode so a query can span global and per-project histories at once.
 */
export function getAllHistoryEntries(): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const file of listHistoryFiles()) {
		for (const entry of loadEntries(file)) {
			if (seen.has(entry)) continue;
			seen.add(entry);
			merged.push(entry);
		}
	}
	return merged;
}

/**
 * Replaces the stock editor to persist prompt history.
 *
 * Relies on pi-tui Editor's `history`/`historyIndex`/`historyDraft` fields
 * (declared private, plain own-instance fields at runtime). init() feature-
 * detects and degrades to a mirror array (no native ↑/↓ browsing) if a pi-tui
 * upgrade removes them.
 */
class PersistentHistoryEditor extends CustomEditor {
	cwd = "";
	degraded = false;
	private seeded = false;
	private fallbackMemory: string[] = [];

	init(cwd: string): void {
		this.cwd = cwd;
		const host = this.hostHistory();
		if (host) {
			host.history = loadEntries(historyFileFor(cwd));
			host.historyIndex = -1;
			host.historyDraft = null;
		} else {
			this.degraded = true;
			this.fallbackMemory = loadEntries(historyFileFor(cwd));
		}
		this.seeded = true;
	}

	/** Live in-memory history (the array native ↑/↓ browses, when available). */
	memory(): string[] {
		const host = this.hostHistory();
		return host ? host.history : this.fallbackMemory;
	}

	/** Replace in-memory history, resetting any in-progress browse state. */
	setMemory(entries: string[]): void {
		const host = this.hostHistory();
		if (host) {
			host.history = entries;
			host.historyIndex = -1;
			host.historyDraft = null;
		} else {
			this.fallbackMemory = entries;
		}
	}

	reloadFromDisk(): void {
		this.setMemory(loadEntries(historyFileFor(this.cwd)));
	}

	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		const h = this.memory();

		// In-memory recording always happens so native ↑/↓ keeps working;
		// `enabled` only gates disk persistence (persistEntries early-returns),
		// and must not change the dedup behavior chosen by the user.
		if (config.dedup === "always") {
			for (let i = h.length - 1; i >= 0; i--) {
				if (h[i] === trimmed) h.splice(i, 1);
			}
			h.unshift(trimmed);
		} else if (config.dedup === "consecutive") {
			if (h[0] !== trimmed) h.unshift(trimmed);
		} else {
			// off: keep all
			h.unshift(trimmed);
		}

		// Single cap. Non-persisted input must never shrink the persisted
		// history below its size (the stock 100-entry cap applies to native
		// seeding only).
		if (h.length > config.maxEntries) h.length = config.maxEntries;

		if (this.seeded) persistEntries(historyFileFor(this.cwd), h);
	}

	private hostHistory(): { history: string[]; historyIndex: number; historyDraft: unknown } | null {
		const host = this as unknown as Record<string, unknown>;
		if (Array.isArray(host.history)) {
			return host as unknown as {
				history: string[];
				historyIndex: number;
				historyDraft: unknown;
			};
		}
		return null;
	}
}

/** Live editor instance, so /history can apply changes immediately. */
export let activeEditor: PersistentHistoryEditor | null = null;
/** Our registered factory; if another extension replaces the editor, ours is detached. */
type EditorFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];
let myFactory: EditorFactory | null = null;
// Ctrl+R reverse-search popup state.
let searchInputUnsub: (() => void) | null = null;
let searchOpen = false;

// ---------------------------------------------------------------------------
// /history command
// ---------------------------------------------------------------------------

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "show", label: "show", description: "List recent entries" },
	{ value: "pick", label: "pick", description: "Pick an entry into the editor" },
	{ value: "set", label: "set", description: "Change an option" },
	{ value: "remove", label: "remove", description: "Delete matching entries" },
	{ value: "clear", label: "clear", description: "Wipe stored history (--all for every file)" },
	{ value: "reload", label: "reload", description: "Reload history from disk" },
	{ value: "path", label: "path", description: "Show storage file location" },
	{ value: "help", label: "help", description: "Show usage" },
];

const CONFIG_KEYS: Record<string, string[]> = {
	enabled: ["on", "off"],
	maxEntries: [],
	maxEntryChars: [],
	scope: ["global", "project"],
	dedup: ["consecutive", "always", "off"],
	recordCommands: ["on", "off"],
	minLength: [],
};

export function onOff(b: boolean): string {
	return b ? "on" : "off";
}

export function statusText(cwd: string): string {
	const file = activeEditor ? historyFileFor(activeEditor.cwd) : historyFileFor(cwd);
	const diskEntries = loadEntries(file);
	const liveCount = activeEditor ? activeEditor.memory().length : diskEntries.length;
	const lines = [
		"Prompt history",
		`  enabled:          ${onOff(config.enabled)}`,
		`  maxEntries:       ${config.maxEntries}`,
		`  maxEntryChars:    ${config.maxEntryChars}`,
		`  scope:            ${config.scope}`,
		`  dedup:            ${config.dedup}`,
		`  recordCommands:   ${onOff(config.recordCommands)} (/ and ! inputs)`,
		`  minLength:        ${config.minLength}`,
		`  entries (live):   ${liveCount}`,
		`  entries (disk):   ${diskEntries.length}`,
		`  file:             ${file}`,
	];
	if (activeEditor?.degraded) {
		lines.push(
			"  ! native up/down browsing unavailable in this pi-tui version; persistence still active",
		);
	}
	return lines.join("\n");
}

const HELP_TEXT = [
	"Usage: /history [subcommand]   (or /history-settings for the panel)",
	"  (none)               open the reverse-i-search popup (TUI)",
	"  show [n]             list recent n entries (default 10)",
	"  pick                 pick an entry into the editor (TUI)",
	"  set <key> <val>      change an option:",
	"                         enabled on|off",
	"                         maxEntries <number>",
	"                         maxEntryChars <number>",
	"                         scope global|project",
	"                         dedup consecutive|always|off",
	"                         recordCommands on|off",
	"                         minLength <number>",
	"  remove <substr>      delete entries containing <substr>",
	"  clear [--all] [--yes]  wipe current scope's file (--all: every file)",
	"  reload               reload history from disk",
	"  path                 show storage file location",
	"",
	"Notes:",
	"- Open the interactive config panel with /history-settings.",
	"- recordCommands=off keeps / and ! inputs out of the history file.",
	"- The file is re-filtered and merge-flushed on every submit: config",
	"  changes purge non-matching entries, and entries written by another pi",
	"  process survive.",
].join("\n");

function truncateLabel(entry: string): string {
	const oneLine = entry.replace(/\s+/g, " ");
	return oneLine.length > 97 ? `${oneLine.slice(0, 96)}…` : oneLine;
}

/**
 * Open the settings/config panel (the `/history-settings` command). This is
 * the GUI surface for every option; in non-interactive mode it falls back to
 * plain status text.
 */
async function handleSettingsCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	// If another extension replaced our editor (or the default was restored),
	// stop mutating the detached instance.
	if (activeEditor && myFactory && ctx.ui.getEditorComponent() !== myFactory) {
		activeEditor = null;
	}
	if (ctx.mode === "tui" && ctx.hasUI) {
		searchOpen = true;
		try {
			await openConfigPanel(ctx);
		} finally {
			searchOpen = false;
		}
	} else {
		ctx.ui.notify(statusText(ctx.cwd), "info");
	}
}

async function handleHistoryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	// If another extension replaced our editor (or the default was restored),
	// stop mutating the detached instance.
	if (activeEditor && myFactory && ctx.ui.getEditorComponent() !== myFactory) {
		activeEditor = null;
	}

	const parts = args.trim().split(/\s+/).filter(Boolean);
	const [sub, ...rest] = parts;
	const cwd = activeEditor?.cwd ?? ctx.cwd ?? "";

	switch (sub) {
		case undefined:
			// No argument: open the reverse-i-search popup. The settings panel now
			// lives at /history-settings; fall back to a hint where a GUI isn't
			// available.
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(
					"/history opens the search popup (interactive mode only). " +
						"Use /history-settings for the config panel, or /history help.",
					"warning",
				);
				return;
			}
			searchOpen = true;
			try {
				await openSearch(ctx.ui, cwd);
			} finally {
				searchOpen = false;
			}
			return;

		case "help":
			ctx.ui.notify(HELP_TEXT, "info");
			return;

		case "path": {
			ctx.ui.notify(historyFileFor(cwd), "info");
			return;
		}

		case "show": {
			const n = Number.parseInt(rest[0] ?? "10", 10);
			const count = Number.isInteger(n) && n > 0 ? Math.min(n, 50) : 10;
			const entries = activeEditor ? activeEditor.memory() : loadEntries(historyFileFor(cwd));
			if (entries.length === 0) {
				ctx.ui.notify("History is empty.", "info");
				return;
			}
			const shown = entries.slice(0, count).map((e, i) => {
				const label = truncateLabel(e);
				return `${String(i + 1).padStart(2)}. ${label}`;
			});
			ctx.ui.notify(
				[`Recent ${shown.length} of ${entries.length} entries:`, ...shown].join("\n"),
				"info",
			);
			return;
		}

		case "pick": {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/history pick is only available in interactive mode.", "warning");
				return;
			}
			const entries = activeEditor ? activeEditor.memory() : loadEntries(historyFileFor(cwd));
			if (entries.length === 0) {
				ctx.ui.notify("History is empty.", "info");
				return;
			}
			// Labels are unique (duplicates get "(#n)") and map straight back to
			// the full entry, so long or identical-prefix entries pick correctly.
			const labelCount = new Map<string, number>();
			const entryForLabel = new Map<string, string>();
			const options: string[] = [];
			for (const entry of entries.slice(0, 100)) {
				const base = truncateLabel(entry);
				const n = (labelCount.get(base) ?? 0) + 1;
				labelCount.set(base, n);
				const label = n === 1 ? base : `${base} (#${n})`;
				options.push(label);
				entryForLabel.set(label, entry);
			}
			const chosen = await ctx.ui.select("Pick a prompt (most recent first)", options);
			const full = chosen !== undefined ? entryForLabel.get(chosen) : undefined;
			if (full !== undefined) {
				ctx.ui.setEditorText(full);
			}
			return;
		}

		case "set": {
			const [key, value, ...extra] = rest;
			if (!key || value === undefined || extra.length > 0) {
				ctx.ui.notify(
					"Usage: /history set <key> <value>. Keys: " + Object.keys(CONFIG_KEYS).join(", "),
					"warning",
				);
				return;
			}
			const result = setOption(key, value);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			return;
		}

		case "remove": {
			const needle = rest.join(" ");
			if (!needle) {
				ctx.ui.notify("Usage: /history remove <substring>", "warning");
				return;
			}
			const file = historyFileFor(cwd);
			const entries = activeEditor ? activeEditor.memory() : loadEntries(file);
			const kept = entries.filter((e) => !e.includes(needle));
			const removed = entries.length - kept.length;
			activeEditor?.setMemory(kept);
			// Explicit destructive command: always hit disk, even when disabled,
			// and honor isPersistable so / and ! inputs never leak.
			persistMemory(file, kept);
			ctx.ui.notify(
				`Removed ${removed} entr${removed === 1 ? "y" : "ies"} from memory and disk.`,
				"info",
			);
			return;
		}

		case "clear": {
			const all = rest.includes("--all");
			const yes = rest.includes("--yes");
			if (!yes) {
				if (ctx.hasUI) {
					const message = all
						? "Delete ALL stored prompt history (global file and every project file)?"
						: `Delete all entries in ${historyFileFor(cwd)}?`;
					const confirmed = await ctx.ui.confirm("Clear prompt history", message);
					if (!confirmed) return;
				} else {
					ctx.ui.notify(
						"Refusing to clear without confirmation. Use: /history clear --yes",
						"warning",
					);
					return;
				}
			}
			if (all) {
				let removed = 0;
				for (const file of listHistoryFiles()) {
					try {
						unlinkSync(file);
						removed++;
					} catch {
						// Already gone or not writable.
					}
				}
				activeEditor?.setMemory([]);
				ctx.ui.notify(`Deleted ${removed} history file(s).`, "info");
				return;
			}
			const file = historyFileFor(cwd);
			activeEditor?.setMemory([]);
			// Explicit destructive command: always hit disk, even when disabled.
			saveEntries(file, []);
			const remaining = listHistoryFiles().filter((f) => f !== file).length;
			const note =
				remaining > 0
					? ` ${remaining} other history file(s) remain — use /history clear --all to wipe everything.`
					: "";
			ctx.ui.notify(`Cleared ${file}.${note}`, "info");
			return;
		}

		case "reload": {
			if (!activeEditor) {
				ctx.ui.notify("No live editor in this session; nothing to reload.", "warning");
				return;
			}
			activeEditor.reloadFromDisk();
			const n = activeEditor.memory().length;
			ctx.ui.notify(
				config.enabled
					? `Reloaded ${n} entries from disk.`
					: `Reloaded ${n} entries (recording is off — new prompts are not saved).`,
				"info",
			);
			return;
		}

		default:
			ctx.ui.notify(`Unknown subcommand "${sub}". Try /history help`, "error");
	}
}

/**
 * Validate + apply a config change and persist it. Returns a result the caller
 * surfaces to the user; failures do not mutate config. Used by both the
 * interactive config panel and the `set` subcommand.
 */
export function setOption(key: string, value: string): { ok: boolean; message: string } {
	const bool = parseBool(value);
	switch (key) {
		case "enabled": {
			if (bool === undefined) return { ok: false, message: "Invalid value for enabled: use on|off" };
			const wasEnabled = config.enabled;
			config.enabled = bool;
			saveConfig();
			if (!wasEnabled && bool) activeEditor?.reloadFromDisk();
			return { ok: true, message: `Set enabled = ${onOff(bool)}` };
		}
		case "maxEntries": {
			const n = Number.parseInt(value, 10);
			if (!Number.isInteger(n) || n < 1) {
				return { ok: false, message: "Invalid value for maxEntries: use a positive integer" };
			}
			config.maxEntries = n;
			saveConfig();
			if (activeEditor && config.enabled) {
				const h = activeEditor.memory();
				if (h.length > n) {
					h.length = n;
					persistMemory(historyFileFor(activeEditor.cwd), h);
				}
			}
			return { ok: true, message: `Set maxEntries = ${n}` };
		}
		case "maxEntryChars": {
			const n = Number.parseInt(value, 10);
			if (!Number.isInteger(n) || n < 1) {
				return { ok: false, message: "Invalid value for maxEntryChars: use a positive integer" };
			}
			config.maxEntryChars = n;
			saveConfig();
			return { ok: true, message: `Set maxEntryChars = ${n} (existing oversized entries purge on next submit)` };
		}
		case "scope": {
			if (value !== "global" && value !== "project") {
				return { ok: false, message: "Invalid value for scope: use global|project" };
			}
			const old = config.scope;
			config.scope = value;
			saveConfig();
			if (old !== value && config.enabled) {
				// Snapshot the previous scope's history before switching files,
				// then merge it into the new scope so nothing is lost.
				const targetFile = historyFileFor(activeEditor?.cwd ?? "");
				const previous = activeEditor ? activeEditor.memory() : loadEntries(targetFile);
				activeEditor?.reloadFromDisk();
				if (previous.length > 0) {
					persistEntries(targetFile, previous);
					activeEditor?.reloadFromDisk();
				}
			}
			return { ok: true, message: `Set scope = ${value}` };
		}
		case "dedup": {
			if (!["consecutive", "always", "off"].includes(value)) {
				return { ok: false, message: "Invalid value for dedup: use consecutive|always|off" };
			}
			config.dedup = value as Config["dedup"];
			saveConfig();
			return { ok: true, message: `Set dedup = ${value}` };
		}
		case "recordCommands": {
			if (bool === undefined) return { ok: false, message: "Invalid value for recordCommands: use on|off" };
			config.recordCommands = bool;
			saveConfig();
			return { ok: true, message: `Set recordCommands = ${onOff(bool)} (/ and ! inputs)` };
		}
		case "minLength": {
			const n = Number.parseInt(value, 10);
			if (!Number.isInteger(n) || n < 0) {
				return { ok: false, message: "Invalid value for minLength: use a non-negative integer" };
			}
			config.minLength = n;
			saveConfig();
			return { ok: true, message: `Set minLength = ${n}` };
		}
		default:
			return {
				ok: false,
				message: `Unknown option "${key}". Keys: ${Object.keys(CONFIG_KEYS).join(", ")}`,
			};
	}
}

function parseBool(value: string): boolean | undefined {
	if (["on", "true", "1", "yes"].includes(value.toLowerCase())) return true;
	if (["off", "false", "0", "no"].includes(value.toLowerCase())) return false;
	return undefined;
}

/**
 * pi-tui passes the ENTIRE text after "/history " as the prefix and replaces
 * it with item.value on completion, so values must be full argument-text
 * replacements (e.g. "set dedup"), with labels showing just the new token.
 * Returning null hides the popup, which we do on an exact unique match so
 * Enter submits instead of re-applying the completion.
 */
function argumentCompletions(prefix: string): AutocompleteItem[] | null {
	const parts = prefix.split(" ");
	const last = parts[parts.length - 1] ?? "";
	const prior = parts.slice(0, -1).filter(Boolean);
	const level = prior.length;

	const build = (candidate: string, description?: string): AutocompleteItem => ({
		value: [...prior, candidate].join(" "),
		label: candidate,
		...(description ? { description } : {}),
	});
	const hideIfExact = (hits: AutocompleteItem[]): AutocompleteItem[] | null =>
		hits.length === 1 && hits[0].value === prefix ? null : hits.length > 0 ? hits : null;

	if (level === 0) {
		return hideIfExact(SUBCOMMANDS.filter((s) => s.value.startsWith(last)));
	}
	if (prior[0] === "set" && level === 1) {
		const hits = Object.keys(CONFIG_KEYS)
			.filter((k) => k.startsWith(last))
			.map((k) => build(k, `current: ${configValueAsString(k)}`));
		return hideIfExact(hits);
	}
	if (prior[0] === "set" && level === 2) {
		const key = prior[1] ?? "";
		const hits = (CONFIG_KEYS[key] ?? [])
			.filter((v) => v.startsWith(last))
			.map((v) => build(v));
		return hideIfExact(hits);
	}
	return null;
}

function configValueAsString(key: string): string {
	switch (key) {
		case "enabled":
			return onOff(config.enabled);
		case "recordCommands":
			return onOff(config.recordCommands);
		default:
			return String((config as unknown as Record<string, unknown>)[key] ?? "?");
	}
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (configWarning) {
			ctx.ui.notify(configWarning, "warning");
			configWarning = null;
		}
		if (ctx.mode !== "tui") return; // Editor replacement is TUI-only
		// (Re)bind the Ctrl+R reverse-search shortcut for this session.
		searchInputUnsub?.();
		searchInputUnsub = ctx.ui.onTerminalInput((data) => {
			if (searchOpen) return; // popup is open: let it handle the keystroke
			if (parseKey(data) === "ctrl+r") {
				// Ctrl+R
				searchOpen = true;
				void Promise.resolve(openSearch(ctx.ui, ctx.cwd)).finally(() => {
					searchOpen = false;
				});
				return { consume: true };
			}
		});
		const cwd = ctx.cwd;
		const factory = (
			tui: ConstructorParameters<typeof CustomEditor>[0],
			theme: ConstructorParameters<typeof CustomEditor>[1],
			keybindings: ConstructorParameters<typeof CustomEditor>[2],
		) => {
			const editor = new PersistentHistoryEditor(tui, theme, keybindings);
			editor.init(cwd);
			activeEditor = editor;
			return editor;
		};
		myFactory = factory;
		ctx.ui.setEditorComponent(factory);
		if (activeEditor?.degraded) {
			ctx.ui.notify(
				"prompt-history: this pi-tui version no longer exposes editor history internals; " +
					"persistence works but native ↑/↓ browsing is limited to this session's input.",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", () => {
		searchInputUnsub?.();
		searchInputUnsub = null;
		activeEditor = null;
		searchOpen = false; // in case the popup was torn down without done()
	});

	pi.registerCommand("history", {
		description: "Search persistent prompt history (reverse-i-search popup, also Ctrl+R)",
		getArgumentCompletions: argumentCompletions,
		handler: handleHistoryCommand,
	});

	pi.registerCommand("history-settings", {
		description: "Open the persistent prompt history settings panel",
		handler: handleSettingsCommand,
	});
}

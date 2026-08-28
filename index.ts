/**
 * Persistent prompt history
 *
 * Persists the input editor's prompt history (the buffer browsed with
 * up/down arrows) to disk so it survives restarts of pi.
 *
 * Storage (history content):
 *   - scope "global":  ~/.pi/agent/prompt-history.json            (shared everywhere)
 *   - scope "project": ~/.pi/agent/prompt-histories/<dir>.json    (per working directory)
 *   In global scope a per-project copy is ALSO kept under prompt-histories/
 *   (only entries submitted from that directory), so the Ctrl+R dock's
 *   "project" view stays scoped to the current directory instead of showing
 *   the shared cross-project list.
 *   Config:            ~/.pi/agent/prompt-history.config.json
 * Files are created 0600 (dirs 0700) and existing files are tightened on load.
 *
 * Configure with the /history-settings command, or search with /history:
 *   /history-settings               open the interactive config panel (TUI)
 *   /history                        open the docked reverse-i-search above the editor (TUI)
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
 *   searchRows     <number>                 result rows shown in the search
 *                                          dock, fixed height (default 10)
 *
 * Persistence semantics:
 *   - The on-disk file is re-filtered against the current config on every
 *     write; tightening maxEntryChars/minLength/recordCommands purges
 *     non-matching entries on the next submit.
 *   - Writes merge with the on-disk file (exact duplicates collapse,
 *     newest first), so entries added by another pi process survive.
 *   - The read-merge-rewrite critical section is guarded by a per-file lock
 *     (O_EXCL lock file + stale-pid + age probe) so concurrent pi processes
 *     cannot lose each other's entries (TOCTOU). Assumes ~/.pi lives on a local
 *     POSIX fs — the same assumption writeAtomic's rename already makes;
 *     on a non-local fs the lock degrades to today's best-effort behavior.
 *     Wedged locks (crashed/hung owner, PID reuse) are auto-reclaimed once
 *     older than the staleness threshold — no manual intervention needed.
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
import { closeSearch, openSearch } from "./search";

const HISTORY_HOME = process.env.PI_HISTORY_HOME ?? join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(HISTORY_HOME, "prompt-history.config.json");
const GLOBAL_HISTORY_FILE = join(HISTORY_HOME, "prompt-history.json");
const PROJECT_HISTORY_DIR = join(HISTORY_HOME, "prompt-histories");

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
	searchRows: number;
}

const DEFAULT_CONFIG: Config = {
	enabled: true,
	maxEntries: 500,
	maxEntryChars: 100_000,
	scope: "global",
	dedup: "consecutive",
	recordCommands: false,
	minLength: 0,
	searchRows: 10,
};

let configWarning: string | null = null;
export let config: Config = loadConfig();
sweepStaleTmp(); // best-effort cleanup of temp files left by crashed sessions
sweepStaleLocks(); // reclaim lock files whose owner process died

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
	if (
		typeof r.searchRows === "number" &&
		Number.isInteger(r.searchRows) &&
		r.searchRows >= 1 &&
		r.searchRows <= 50
	) {
		c.searchRows = r.searchRows;
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

// ---------------------------------------------------------------------------
// Cross-process lock for the read-merge-rewrite critical section
// ---------------------------------------------------------------------------

/**
 * persistEntries reads, merges, and rewrites the whole history file. Without
 * a lock two pi processes can interleave and one entry is lost (TOCTOU):
 *   A reads [x] -> merge [y,x]; B reads [x] -> merge [z,x];
 *   A writes [y,x]; B writes [z,x]  => A's y is lost.
 *
 * We wrap the critical section in a per-history-file mutex built on a
 * dedicated lock file (NOT the data file: writeAtomic renames the target so
 * its inode changes, and a lock on the old inode would not protect the new
 * file).
 *
 * Primitive: pure-Node O_EXCL (writeFileSync flag "wx") + a stale-PID probe
 * (process.kill(pid, 0)) — the same pid-liveness idea sweepStaleTmp already
 * uses. No flock (Node has no portable built-in; shell flock(1) is Linux-only
 * and breaks macOS), no native deps, no hybrid. The plugin already assumes a
 * local POSIX fs via writeAtomic's rename; on a non-local fs the lock degrades
 * to today's best-effort behavior (never worse than now).
 *
 * Self-repair: a lock is treated as stale (and reclaimed) when its owner pid
 * is dead, the lock file is corrupt/unreadable, OR the lock file is older than
 * LOCK_STALE_AGE_MS. A history write holds the lock for milliseconds at most,
 * so an old lock means the owner crashed or hung — or a reused pid made
 * process.kill(pid,0) falsely report it alive. The age check closes that
 * PID-reuse blind spot without any manual command: wedged locks simply age
 * out and get reclaimed on the next write. sweepStaleLocks() also reclaims
 * stale locks at startup. Reclaiming a stale lock never loses data because a
 * dead/hung owner can no longer write anyway.
 */
const LOCK_RETRY_MAX = 60; // bounded so a wedged lock cannot livelock forever
const LOCK_RETRY_BACKOFF_MS = 5; // short busy-wait when the lock is genuinely held
const LOCK_STALE_AGE_MS = 10_000; // a held lock older than this is wedged → auto-reclaim

function lockFileFor(historyFile: string): string {
	return `${historyFile}.lock`;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false; // ESRCH (not running) or EPERM on some platforms
	}
}

/**
 * A lock is stale (safe to reclaim) when its owner pid is dead, the lock file is
 * corrupt/unreadable, or the lock file is older than LOCK_STALE_AGE_MS. The age
 * check is what makes the lock self-repairing: a prompt-history write holds the
 * lock for milliseconds at most, so an old lock means the owner crashed or
 * hung (or a reused pid made process.kill(pid,0) falsely report it alive).
 * Reclaiming a stale lock never loses data — a dead/hung owner can no longer
 * write anyway.
 */
function isLockStale(file: string, ownerPid: number | undefined): boolean {
	if (ownerPid === undefined || !Number.isInteger(ownerPid)) return true; // corrupt
	if (!isPidAlive(ownerPid)) return true; // owner dead
	try {
		return Date.now() - statSync(file).mtimeMs > LOCK_STALE_AGE_MS; // wedged / PID reuse
	} catch {
		return true; // unreadable / missing
	}
}

/**
 * Best-effort mutex acquisition. On any unexpected error it returns and the
 * caller proceeds without a lock, degrading to the pre-lock behavior (never
 * worse than today). Bounded retries prevent a wedged lock from livelocking.
 */
function acquireHistoryLock(historyFile: string): void {
	const lockFile = lockFileFor(historyFile);
	ensurePrivateDirs();
	try {
		mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
	} catch {
		// Directory already exists.
	}
	for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
		try {
			writeFileSync(lockFile, String(process.pid), {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			return; // acquired
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				// Unexpected error: do not block writes; proceed without a lock
				// (degrades to the old best-effort behavior, never worse).
				return;
			}
			// Lock exists — reclaim it if stale (dead/corrupt owner, or wedged long
			// enough that the holder must have crashed/hung). See isLockStale.
			let ownerPid: number | undefined;
			try {
				ownerPid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
			} catch {
				ownerPid = undefined; // unreadable → isLockStale treats as stale
			}
			if (isLockStale(lockFile, ownerPid)) {
				// Remove and retry the O_EXCL create. If another writer won the
				// race to reclaim, our next O_EXCL gets EEXIST again and we loop
				// — O_EXCL is atomic, so this race is harmless.
				try {
					unlinkSync(lockFile);
				} catch {
					// Someone else already removed it; fine.
				}
				continue;
			}
			// Genuinely held: brief busy-wait backoff, then retry. (Low-frequency
			// write path; holds are normally sub-millisecond.)
			const end = Date.now() + LOCK_RETRY_BACKOFF_MS;
			while (Date.now() < end) {
				// spin briefly
			}
		}
	}
	// Exhausted retries: do not block the write path. Proceed without a lock
	// (best-effort, same as the pre-lock behavior) rather than stalling.
}

/**
 * Release a lock we hold. Unlinks the lock file only if it still records our
 * pid, so we never delete another owner's lock.
 */
function releaseHistoryLock(historyFile: string): void {
	const lockFile = lockFileFor(historyFile);
	try {
		const ownerPid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
		if (ownerPid === process.pid) unlinkSync(lockFile);
	} catch {
		// Lock file gone or unreadable: nothing to release.
	}
}

/**
 * Reclaim one stale lock file if its owner is dead/corrupt/wedged (see isLockStale).
 */
function reclaimStaleLock(file: string): void {
	let ownerPid: number | undefined;
	try {
		ownerPid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
	} catch {
		ownerPid = undefined;
	}
	if (!isLockStale(file, ownerPid)) return;
	try {
		unlinkSync(file);
	} catch {
		// Lost the race or already gone.
	}
}

/**
 * Reclaim stale lock files at startup (self-repair for crashed/hung owners).
 *
 * IMPORTANT: never scan the shared ~/.pi/agent/ directory for "*.lock" — that
 * would delete pi core's or other extensions' legitimate long-held locks. We
 * only touch our own lock files: the single global lock (a named file in the
 * shared dir, checked directly by path) and the project locks in our private
 * prompt-histories/ dir (filtered to *.json.lock, this plugin's lock naming).
 */
function sweepStaleLocks(): void {
	// Global: check only our own named lock file, not the shared directory.
	reclaimStaleLock(lockFileFor(GLOBAL_HISTORY_FILE));
	// Project: our private directory — safe to scan, filtered to our naming.
	let names: string[];
	try {
		names = readdirSync(PROJECT_HISTORY_DIR);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json.lock")) continue;
		reclaimStaleLock(join(PROJECT_HISTORY_DIR, name));
	}
}

/**
 * Per-project history file for a cwd — one file per working directory,
 * independent of config.scope. Written on every submit (both scopes), it is
 * the single source of truth for the Ctrl+R dock's "project" view.
 */
export function projectHistoryFileFor(cwd: string): string {
	const sanitized = cwd.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "root";
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
	return join(PROJECT_HISTORY_DIR, `${sanitized.slice(0, 100)}-${hash}.json`);
}

export function historyFileFor(cwd: string): string {
	if (config.scope === "global") return GLOBAL_HISTORY_FILE;
	return projectHistoryFileFor(cwd);
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

/** Write an in-memory list to disk, filtered by isPersistable. Used by the
 * destructive commands that must hit disk even when recording is disabled. */
function persistMemory(file: string, entries: string[]): void {
	saveEntries(file, entries.filter(isPersistable).slice(0, config.maxEntries));
}

/**
 * Merge-flush the live history into the file, honoring the dedup setting. The
 * on-disk file is re-read and re-merged on every attempt so an entry added by a
 * concurrent pi process is not lost. The whole read-merge-rewrite critical
 * section is guarded by a per-file lock (see acquireHistoryLock) to close the
 * TOCTOU lost-update window between concurrent pi processes.
 */
function persistEntries(file: string, live: string[]): void {
	if (!config.enabled) return;
	const MAX_ATTEMPTS = 3;
	acquireHistoryLock(file);
	try {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const merged = mergeEntries(live, loadEntries(file));
			saveEntries(file, merged);
			const after = loadEntries(file);
			const mergedSet = new Set(merged);
			if (!after.some((e) => !mergedSet.has(e))) return;
		}
	} finally {
		releaseHistoryLock(file);
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

/**
 * Apply in-memory dedup + size cap for one new entry. Pure (no disk, no `this`)
 * so it can be unit-tested directly; `addToHistory` splices the result back into
 * the live array to keep native ↑/↓ browsing working.
 *
 * - `always`: remove any earlier copy, then prepend.
 * - `consecutive`: prepend only if it differs from the current head.
 * - `off`: always prepend.
 * The list is capped to `maxEntries` (truncating the tail). Empty/whitespace
 * `text` is a no-op returning the input unchanged.
 */
function recordEntry(
	history: string[],
	text: string,
	dedup: Config["dedup"],
	maxEntries: number,
): string[] {
	const trimmed = text.trim();
	if (!trimmed) return history;
	let h: string[];
	if (dedup === "always") {
		h = history.filter((e) => e !== trimmed);
		h.unshift(trimmed);
	} else if (dedup === "consecutive") {
		if (history.length > 0 && history[0] === trimmed) {
			h = history.slice(0, maxEntries);
		} else {
			h = [trimmed, ...history];
		}
	} else {
		// off: keep all
		h = [trimmed, ...history];
	}
	if (h.length > maxEntries) h.length = maxEntries;
	return h;
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
 * History entries for one project (cwd), newest first — the Ctrl+R dock's
 * "project" view. Strictly scoped to this cwd:
 *   - project scope: the live editor memory is seeded from — and flushed to —
 *     this project's own file, so it is used directly.
 *   - global scope: the live memory is the shared cross-project list; using
 *     it here would mix other projects into the view, so this reads only the
 *     per-project file for this cwd (addToHistory keeps it up to date).
 */
export function getHistoryEntries(cwd: string): string[] {
	if (config.scope === "project" && activeEditor && activeEditor.cwd === cwd) {
		return activeEditor.memory();
	}
	return loadEntries(projectHistoryFileFor(cwd));
}

/**
 * All history entries across every scope (global file + all project files),
 * merged and de-duplicated, newest occurrence kept. Used by the search dock's
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
		// and must not change the dedup behavior chosen by the user. The dedup +
		// cap logic lives in the pure `recordEntry` helper (also unit-tested).
		const next = recordEntry(h, trimmed, config.dedup, config.maxEntries);
		h.splice(0, h.length, ...next);
		if (this.seeded) {
			persistEntries(historyFileFor(this.cwd), h);
			// Global scope records into the shared file; also credit the entry to
			// this project's own file so the Ctrl+R "project" view (which reads
			// only that file) reflects prompts actually used here. Merging just
			// the new entry — never the whole shared list — is what keeps other
			// projects' prompts out of the per-project file.
			if (config.scope === "global") {
				persistEntries(projectHistoryFileFor(this.cwd), [trimmed]);
			}
		}
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
// Ctrl+R reverse-search dock state.
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
	searchRows: [],
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
		`  searchRows:       ${config.searchRows}`,
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
	"  (none)               open the docked reverse-i-search above the editor (TUI)",
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
	"                         searchRows <number>",
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
			// No argument: open the reverse-i-search dock. The settings panel now
			// lives at /history-settings; fall back to a hint where a GUI isn't
			// available.
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(
					"/history opens the search dock (interactive mode only). " +
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
			let removed = entries.length - kept.length;
			activeEditor?.setMemory(kept);
			// Explicit destructive command: always hit disk, even when disabled,
			// and honor isPersistable so / and ! inputs never leak.
			persistMemory(file, kept);
			// Global scope also keeps a per-project copy (the Ctrl+R "project"
			// view reads it); scrub that file too so removal applies everywhere.
			if (config.scope === "global") {
				const pf = projectHistoryFileFor(cwd);
				const proj = loadEntries(pf);
				const projKept = proj.filter((e) => !e.includes(needle));
				removed += proj.length - projKept.length;
				persistMemory(pf, projKept);
			}
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
				// project→global: fold the project's list into the shared file so
				// native ↑/↓ keeps seeing it after the switch. global→project: just
				// re-seed from this project's own file — carrying the cross-project
				// list over would permanently mix other projects' prompts into the
				// per-project file the Ctrl+R "project" view reads. Nothing is lost
				// either way: entries stay in the files they were recorded in, and
				// the "all" view still spans every file.
				if (value === "global" && activeEditor) {
					const previous = activeEditor.memory();
					if (previous.length > 0) {
						persistEntries(historyFileFor(activeEditor.cwd), previous);
					}
				}
				activeEditor?.reloadFromDisk();
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
		case "searchRows": {
			const n = Number.parseInt(value, 10);
			if (!Number.isInteger(n) || n < 1 || n > 50) {
				return { ok: false, message: "Invalid value for searchRows: use an integer 1–50" };
			}
			config.searchRows = n;
			saveConfig();
			return {
				ok: true,
				message: `Set searchRows = ${n} (applies to an open search dock immediately)`,
			};
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
 * Returning null hides the completion popup, which we do on an exact unique match so
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
			if (searchOpen) return; // search dock is open: its own listener handles the keystroke
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
		closeSearch(); // force-close the dock and drop the widget
		activeEditor = null;
		searchOpen = false; // in case the dock was torn down without close()
	});

	pi.registerCommand("history", {
		description: "Search persistent prompt history (reverse-i-search dock, also Ctrl+R)",
		getArgumentCompletions: argumentCompletions,
		handler: handleHistoryCommand,
	});

	pi.registerCommand("history-settings", {
		description: "Open the persistent prompt history settings panel",
		handler: handleSettingsCommand,
	});
}

// ---------------------------------------------------------------------------
// Test surface (NOT part of the public extension API)
// ---------------------------------------------------------------------------

/**
 * Re-export internal helpers for tests. index.ts is otherwise loaded only for
 * its `default` export and the `/history` commands; this object keeps the real
 * public surface small while letting the test suite reach pure helpers.
 */
export const __internals = {
	DEFAULT_CONFIG,
	HISTORY_HOME,
	CONFIG_FILE,
	GLOBAL_HISTORY_FILE,
	PROJECT_HISTORY_DIR,
	LOCK_RETRY_MAX,
	LOCK_RETRY_BACKOFF_MS,
	LOCK_STALE_AGE_MS,
	loadConfig,
	normalizeConfig,
	saveConfig,
	projectHistoryFileFor,
	tightenFile,
	writeAtomic,
	ensurePrivateDirs,
	sweepStaleTmp,
	loadEntries,
	saveEntries,
	isPersistable,
	persistMemory,
	persistEntries,
	mergeEntries,
	recordEntry,
	listHistoryFiles,
	isPidAlive,
	isLockStale,
	lockFileFor,
	acquireHistoryLock,
	releaseHistoryLock,
	reclaimStaleLock,
	sweepStaleLocks,
	parseBool,
	argumentCompletions,
	configValueAsString,
	handleHistoryCommand,
	handleSettingsCommand,
	PersistentHistoryEditor,
	SUBCOMMANDS,
	CONFIG_KEYS,
	HELP_TEXT,
};

/** Reset the in-memory config to defaults (tests only). Does not touch disk. */
export function __resetConfig(): void {
	Object.assign(config, DEFAULT_CONFIG);
	configWarning = null;
}

/** Set/clear the live editor for tests only. */
export function __setActiveEditor(e: PersistentHistoryEditor | null): void {
	activeEditor = e;
}

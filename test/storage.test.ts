import { describe, it, expect, beforeEach } from "bun:test";
import {
	config,
	__resetConfig,
	__setActiveEditor,
	historyFileFor,
	projectHistoryFileFor,
	getHistoryEntries,
	getAllHistoryEntries,
	__internals,
} from "../index.ts";
import { TEST_HOME, cleanHome, exists } from "./helpers.ts";
import {
	writeFileSync,
	symlinkSync,
	statSync,
	lstatSync,
	mkdirSync,
	chmodSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const {
	GLOBAL_HISTORY_FILE,
	PROJECT_HISTORY_DIR,
	loadHistoryEntries,
	saveHistoryEntries,
	loadProjectTexts,
	loadViewTexts,
	writeAtomic,
	tightenFile,
	isPersistable,
	forceSaveHistoryEntries,
	mergeHistoryEntries,
	persistHistoryEntries,
	listProjectFiles,
	rebuildGlobalIndex,
	loadGlobalIndex,
	projIdFor,
	ensurePrivateDirs,
} = __internals;

beforeEach(() => {
	cleanHome();
	__resetConfig();
	__setActiveEditor(null);
});

/** Build a HistoryEntry (ts descending by list position: newest first). */
const ent = (t: string, ts?: number) => ({ t, ts: ts ?? 0 });

/** Deterministic newest-first seed: texts [a, b, c] → ts 3, 2, 1. */
const seed = (file: string, arr: string[]) =>
	saveHistoryEntries(file, arr.map((t, i) => ({ t, ts: arr.length - i })));

/** Read back just the texts of a history file. */
const texts = (file: string) => loadHistoryEntries(file).map((e) => e.t);

// ---------------------------------------------------------------------------
// historyFileFor
// ---------------------------------------------------------------------------

describe("historyFileFor", () => {
	it("returns GLOBAL_HISTORY_FILE when scope is global", () => {
		config.scope = "global";
		expect(historyFileFor("/a/b")).toBe(GLOBAL_HISTORY_FILE);
	});

	it("returns a project file under PROJECT_HISTORY_DIR when scope is project", () => {
		config.scope = "project";
		const f = historyFileFor("/a/b");
		expect(f.startsWith(PROJECT_HISTORY_DIR + "/")).toBe(true);
		expect(f.endsWith(".json")).toBe(true);
	});

	it("sanitizes /a/b and /a/b/ to the same sanitized name (hash differs by raw cwd)", () => {
		config.scope = "project";
		const f1 = historyFileFor("/a/b");
		const f2 = historyFileFor("/a/b/");
		const base1 = f1.slice(PROJECT_HISTORY_DIR.length + 1);
		const base2 = f2.slice(PROJECT_HISTORY_DIR.length + 1);
		// Sanitized name is identical; the hash is sha1(raw cwd) so it differs
		expect(base1.replace(/-[0-9a-f]{12}\.json$/, "")).toBe("a_b");
		expect(base2.replace(/-[0-9a-f]{12}\.json$/, "")).toBe("a_b");
		expect(base1).not.toBe(base2);
		expect(base1).toMatch(/^a_b-[0-9a-f]{12}\.json$/);
		expect(base2).toMatch(/^a_b-[0-9a-f]{12}\.json$/);
	});

	it("handles spaces and unicode in cwd (non-alnum runs → single _)", () => {
		config.scope = "project";
		const f = historyFileFor("/a b/中文");
		const base = f.slice(PROJECT_HISTORY_DIR.length + 1);
		// /a b/中文 → _a_b_ → trim → a_b
		expect(base).toMatch(/^a_b-[0-9a-f]{12}\.json$/);
	});

	it("uses 'root' for an empty cwd", () => {
		config.scope = "project";
		const f = historyFileFor("");
		const base = f.slice(PROJECT_HISTORY_DIR.length + 1);
		const expectedHash = createHash("sha1").update("").digest("hex").slice(0, 12);
		expect(base).toBe(`root-${expectedHash}.json`);
	});

	it("uses 'root' for a cwd of only non-alnum chars", () => {
		config.scope = "project";
		const f = historyFileFor("///");
		const base = f.slice(PROJECT_HISTORY_DIR.length + 1);
		expect(base.startsWith("root-")).toBe(true);
	});

	it("truncates the sanitized name to 100 chars", () => {
		config.scope = "project";
		const cwd = "/" + "a".repeat(150);
		const f = historyFileFor(cwd);
		const base = f.slice(PROJECT_HISTORY_DIR.length + 1);
		const namePart = base.replace(/-[0-9a-f]{12}\.json$/, "");
		expect(namePart.length).toBe(100);
		expect(namePart).toBe("a".repeat(100));
	});

	it("uses the first 12 hex chars of sha1(cwd) as the hash", () => {
		config.scope = "project";
		const cwd = "/test/path";
		const f = historyFileFor(cwd);
		const expectedHash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
		const base = f.slice(PROJECT_HISTORY_DIR.length + 1);
		expect(base).toBe(`test_path-${expectedHash}.json`);
	});
});

// ---------------------------------------------------------------------------
// projIdFor
// ---------------------------------------------------------------------------

describe("projIdFor", () => {
	it("derives the project id from the project file basename", () => {
		const pf = projectHistoryFileFor("/proj/x");
		expect(projIdFor("/proj/x")).toBe(pf.slice(PROJECT_HISTORY_DIR.length + 1, -".json".length));
	});
});

// ---------------------------------------------------------------------------
// loadHistoryEntries
// ---------------------------------------------------------------------------

describe("loadHistoryEntries", () => {
	it("returns [] for a missing file", () => {
		expect(loadHistoryEntries(join(TEST_HOME, "nope.json"))).toEqual([]);
	});

	it("returns [] for corrupt JSON", () => {
		const f = join(TEST_HOME, "corrupt.json");
		writeFileSync(f, "{ not valid json");
		expect(loadHistoryEntries(f)).toEqual([]);
	});

	it("returns [] for non-array JSON (number / object)", () => {
		const f1 = join(TEST_HOME, "num.json");
		writeFileSync(f1, "5");
		expect(loadHistoryEntries(f1)).toEqual([]);
		const f2 = join(TEST_HOME, "obj.json");
		writeFileSync(f2, "{}");
		expect(loadHistoryEntries(f2)).toEqual([]);
	});

	it("reads legacy plain-string arrays as empty (no migration)", () => {
		const f = join(TEST_HOME, "legacy.json");
		writeFileSync(f, JSON.stringify(["a", "b"]));
		expect(loadHistoryEntries(f)).toEqual([]);
	});

	it("skips malformed items and keeps valid {t, ts} entries", () => {
		const f = join(TEST_HOME, "mixed.json");
		writeFileSync(
			f,
			JSON.stringify([
				{ t: "a", ts: 3 },
				1,
				"x",
				null,
				{ t: "b", ts: 2 },
				{ t: 5, ts: 1 }, // non-string t
				{ ts: 1 }, // missing t
				{ t: "c" }, // missing ts
				{ t: "d", ts: "nope" }, // non-numeric ts
			]),
		);
		expect(loadHistoryEntries(f)).toEqual([
			{ t: "a", ts: 3 },
			{ t: "b", ts: 2 },
		]);
	});

	it("keeps the optional p field when present", () => {
		const f = join(TEST_HOME, "proj.json");
		writeFileSync(f, JSON.stringify([{ t: "a", ts: 1, p: "proj-abc" }]));
		expect(loadHistoryEntries(f)).toEqual([{ t: "a", ts: 1, p: "proj-abc" }]);
	});

	it("returns [] for an empty array", () => {
		const f = join(TEST_HOME, "empty.json");
		writeFileSync(f, "[]");
		expect(loadHistoryEntries(f)).toEqual([]);
	});

	it("tightens file permissions on load", () => {
		const f = join(TEST_HOME, "loose.json");
		writeFileSync(f, JSON.stringify([{ t: "a", ts: 1 }]));
		chmodSync(f, 0o644);
		expect(statSync(f).mode & 0o077).not.toBe(0);
		loadHistoryEntries(f);
		expect(statSync(f).mode & 0o077).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// saveHistoryEntries
// ---------------------------------------------------------------------------

describe("saveHistoryEntries", () => {
	it("writes entries that loadHistoryEntries reads back", () => {
		const f = join(TEST_HOME, "save.json");
		const entries = [ent("x", 3), ent("y", 2), ent("z", 1)];
		saveHistoryEntries(f, entries);
		expect(loadHistoryEntries(f)).toEqual(entries);
	});

	it("creates the file with mode 0600", () => {
		const f = join(TEST_HOME, "save_perms.json");
		saveHistoryEntries(f, [ent("a")]);
		expect(statSync(f).mode & 0o777).toBe(0o600);
	});

	it("creates the parent directory with mode 0700", () => {
		const f = join(TEST_HOME, "subdir", "save.json");
		saveHistoryEntries(f, [ent("a")]);
		expect(statSync(join(TEST_HOME, "subdir")).mode & 0o777).toBe(0o700);
	});
});

// ---------------------------------------------------------------------------
// writeAtomic
// ---------------------------------------------------------------------------

describe("writeAtomic", () => {
	it("creates the file with mode 0600 and the given content", () => {
		const f = join(TEST_HOME, "atomic.json");
		writeAtomic(f, "hello");
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(readFileSync(f, "utf8")).toBe("hello");
	});

	it("replaces a symlink at the path with a regular file", () => {
		const target = join(TEST_HOME, "target.json");
		writeFileSync(target, "target-content");
		const link = join(TEST_HOME, "link.json");
		symlinkSync(target, link);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);

		writeAtomic(link, "new-content");

		expect(lstatSync(link).isSymbolicLink()).toBe(false);
		expect(lstatSync(link).isFile()).toBe(true);
		expect(readFileSync(link, "utf8")).toBe("new-content");
		// The original target must be untouched (write did not go through the symlink)
		expect(readFileSync(target, "utf8")).toBe("target-content");
	});

	it("overwrites an existing file", () => {
		const f = join(TEST_HOME, "overwrite.json");
		writeAtomic(f, "first");
		writeAtomic(f, "second");
		expect(readFileSync(f, "utf8")).toBe("second");
	});
});

// ---------------------------------------------------------------------------
// tightenFile
// ---------------------------------------------------------------------------

describe("tightenFile", () => {
	it("strips group/other bits from a file", () => {
		const f = join(TEST_HOME, "loose.json");
		writeFileSync(f, "data");
		chmodSync(f, 0o644);
		expect(statSync(f).mode & 0o077).not.toBe(0);
		tightenFile(f);
		expect(statSync(f).mode & 0o077).toBe(0);
	});

	it("removes a symlink at the path", () => {
		const target = join(TEST_HOME, "target.json");
		writeFileSync(target, "data");
		const link = join(TEST_HOME, "link.json");
		symlinkSync(target, link);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);

		tightenFile(link);

		// Symlink is gone
		expect(exists(link)).toBe(false);
		// A regular file can now be created at the path
		writeFileSync(link, "new");
		expect(lstatSync(link).isFile()).toBe(true);
	});

	it("is a no-op for a missing file (does not throw)", () => {
		expect(() => tightenFile(join(TEST_HOME, "nope.json"))).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// isPersistable
// ---------------------------------------------------------------------------

describe("isPersistable", () => {
	it("rejects entries longer than maxEntryChars", () => {
		config.maxEntryChars = 5;
		expect(isPersistable("abcde")).toBe(true); // exactly 5
		expect(isPersistable("abcdef")).toBe(false); // 6 > 5
	});

	it("rejects entries shorter than minLength", () => {
		config.minLength = 3;
		expect(isPersistable("ab")).toBe(false); // 2 < 3
		expect(isPersistable("abc")).toBe(true); // exactly 3
	});

	it("rejects / and ! entries when recordCommands is false", () => {
		config.recordCommands = false;
		expect(isPersistable("/cmd")).toBe(false);
		expect(isPersistable("!cmd")).toBe(false);
		expect(isPersistable("hello")).toBe(true);
	});

	it("allows / and ! entries when recordCommands is true", () => {
		config.recordCommands = true;
		expect(isPersistable("/cmd")).toBe(true);
		expect(isPersistable("!cmd")).toBe(true);
	});

	it("accepts normal text within limits under defaults", () => {
		expect(isPersistable("normal text")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// forceSaveHistoryEntries
// ---------------------------------------------------------------------------

describe("forceSaveHistoryEntries", () => {
	it("filters non-persistable entries and applies the maxEntries cap", () => {
		config.maxEntries = 3;
		config.minLength = 2;
		const f = join(TEST_HOME, "persist.json");
		forceSaveHistoryEntries(f, [ent("a"), ent("bb"), ent("cc"), ent("dd"), ent("ee")]);
		// "a" too short (minLength=2), rest OK, capped to 3
		expect(texts(f)).toEqual(["bb", "cc", "dd"]);
	});

	it("writes an empty array when no entries are persistable", () => {
		config.minLength = 10;
		const f = join(TEST_HOME, "empty.json");
		forceSaveHistoryEntries(f, [ent("a"), ent("b"), ent("c")]);
		expect(texts(f)).toEqual([]);
	});

	it("writes all entries when under the cap", () => {
		config.maxEntries = 10;
		const f = join(TEST_HOME, "all.json");
		forceSaveHistoryEntries(f, [ent("a"), ent("b"), ent("c")]);
		expect(texts(f)).toEqual(["a", "b", "c"]);
	});
});

// ---------------------------------------------------------------------------
// mergeHistoryEntries
// ---------------------------------------------------------------------------

describe("mergeHistoryEntries", () => {
	it("places live entries before disk entries (newest-first)", () => {
		config.dedup = "off";
		config.maxEntries = 100;
		expect(mergeHistoryEntries([ent("x"), ent("y")], [ent("z"), ent("w")])).toEqual([
			ent("x"),
			ent("y"),
			ent("z"),
			ent("w"),
		]);
	});

	it("dedup off keeps all entries, sliced to maxEntries", () => {
		config.dedup = "off";
		config.maxEntries = 3;
		expect(mergeHistoryEntries([ent("a"), ent("b")], [ent("c"), ent("d")])).toEqual([
			ent("a"),
			ent("b"),
			ent("c"),
		]);
	});

	it("dedup consecutive collapses only adjacent duplicates (by text)", () => {
		config.dedup = "consecutive";
		config.maxEntries = 100;
		// persistable = [a, a, b, b, c] → a, skip(adj a), b, skip(adj b), c
		expect(mergeHistoryEntries([ent("a"), ent("a"), ent("b")], [ent("b"), ent("c")])).toEqual([
			ent("a"),
			ent("b"),
			ent("c"),
		]);
	});

	it("dedup consecutive keeps non-adjacent duplicates", () => {
		config.dedup = "consecutive";
		config.maxEntries = 100;
		// persistable = [a, b, a, c] → a, b, a(not adjacent to b), c
		expect(mergeHistoryEntries([ent("a"), ent("b")], [ent("a"), ent("c")])).toEqual([
			ent("a"),
			ent("b"),
			ent("a"),
			ent("c"),
		]);
	});

	it("dedup always collapses all duplicates keeping first occurrence", () => {
		config.dedup = "always";
		config.maxEntries = 100;
		// persistable = [a, b, a, c] → a, b, skip(seen a), c
		expect(mergeHistoryEntries([ent("a"), ent("b")], [ent("a"), ent("c")])).toEqual([
			ent("a"),
			ent("b"),
			ent("c"),
		]);
	});

	it("dedup always collapses all-identical input to a single entry", () => {
		config.dedup = "always";
		config.maxEntries = 100;
		expect(mergeHistoryEntries([ent("a"), ent("a"), ent("a")], [ent("a"), ent("a")])).toEqual([
			ent("a"),
		]);
	});

	it("filters both live and disk by isPersistable", () => {
		config.dedup = "off";
		config.maxEntries = 100;
		config.minLength = 3;
		// live=[ab, abc], disk=[de, def] → persistable = [abc, def]
		expect(mergeHistoryEntries([ent("ab"), ent("abc")], [ent("de"), ent("def")])).toEqual([
			ent("abc"),
			ent("def"),
		]);
	});

	it("caps to maxEntries", () => {
		config.dedup = "always";
		config.maxEntries = 2;
		// a, b → break at 2
		expect(mergeHistoryEntries([ent("a"), ent("b")], [ent("c")])).toEqual([ent("a"), ent("b")]);
	});
});

// ---------------------------------------------------------------------------
// persistHistoryEntries
// ---------------------------------------------------------------------------

describe("persistHistoryEntries", () => {
	it("early-returns when disabled", () => {
		config.enabled = false;
		const f = join(TEST_HOME, "off.json");
		seed(f, ["a"]);
		persistHistoryEntries(f, [ent("b", 5)]);
		expect(texts(f)).toEqual(["a"]);
	});

	it("merges live with disk and releases the lock", () => {
		const f = join(TEST_HOME, "merge.json");
		seed(f, ["a"]);
		persistHistoryEntries(f, [ent("b", 9)]);
		expect(texts(f)).toEqual(["b", "a"]);
		expect(exists(`${f}.lock`)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// listProjectFiles / rebuildGlobalIndex / loadGlobalIndex
// ---------------------------------------------------------------------------

describe("listProjectFiles", () => {
	it("returns [] when no project files exist", () => {
		expect(listProjectFiles()).toEqual([]);
	});

	it("returns only project files — never the global view file", () => {
		seed(GLOBAL_HISTORY_FILE, ["a"]);
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["b"]);
		seed(join(PROJECT_HISTORY_DIR, "p2.json"), ["c"]);
		const files = listProjectFiles();
		expect(files).toContain(join(PROJECT_HISTORY_DIR, "p1.json"));
		expect(files).toContain(join(PROJECT_HISTORY_DIR, "p2.json"));
		expect(files).not.toContain(GLOBAL_HISTORY_FILE);
		expect(files.length).toBe(2);
	});

	it("excludes .json.lock files", () => {
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["b"]);
		writeFileSync(join(PROJECT_HISTORY_DIR, "p1.json.lock"), String(process.pid), {
			mode: 0o600,
		});
		expect(listProjectFiles()).toEqual([join(PROJECT_HISTORY_DIR, "p1.json")]);
	});
});

describe("rebuildGlobalIndex", () => {
	it("merges all project files newest-ts-first with per-text dedup", () => {
		saveHistoryEntries(
			join(PROJECT_HISTORY_DIR, "p2.json"),
			["new-shared", "p2-only"].map((t, i) => ({ t, ts: 100 - i })),
		);
		saveHistoryEntries(
			join(PROJECT_HISTORY_DIR, "p1.json"),
			["old-shared", "p1-only"].map((t, i) => ({ t, ts: 50 - i })),
		);
		const rebuilt = rebuildGlobalIndex();
		expect(rebuilt.map((e) => e.t)).toEqual(["new-shared", "p2-only", "old-shared", "p1-only"]);
		// The same text in two files keeps the newest occurrence:
		saveHistoryEntries(
			join(PROJECT_HISTORY_DIR, "p1.json"),
			["new-shared", "p1-only"].map((t, i) => ({ t, ts: 40 - i })),
		);
		const rebuilt2 = rebuildGlobalIndex();
		expect(rebuilt2.map((e) => e.t)).toEqual(["new-shared", "p2-only", "p1-only"]);
		// newest occurrence wins and is attributed to p2 (ts 100)
		expect(rebuilt2.find((e) => e.t === "new-shared")?.p).toBe(
			join(PROJECT_HISTORY_DIR, "p2.json").slice(PROJECT_HISTORY_DIR.length + 1, -".json".length),
		);
	});

	it("writes the rebuilt view to GLOBAL_HISTORY_FILE", () => {
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["a", "b"]);
		expect(exists(GLOBAL_HISTORY_FILE)).toBe(false);
		rebuildGlobalIndex();
		expect(exists(GLOBAL_HISTORY_FILE)).toBe(true);
		expect(loadHistoryEntries(GLOBAL_HISTORY_FILE).map((e) => e.t)).toEqual(["a", "b"]);
	});

	it("applies the maxEntries cap", () => {
		config.maxEntries = 2;
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["a", "b", "c"]);
		expect(rebuildGlobalIndex().map((e) => e.t)).toEqual(["a", "b"]);
	});

	it("applies isPersistable (recordCommands off keeps / and ! out)", () => {
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["/cmd", "!ls", "plain"]);
		expect(rebuildGlobalIndex().map((e) => e.t)).toEqual(["plain"]);
	});
});

describe("loadGlobalIndex", () => {
	it("rebuilds when the global view file is missing", () => {
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["a"]);
		expect(loadGlobalIndex().map((e) => e.t)).toEqual(["a"]);
		expect(exists(GLOBAL_HISTORY_FILE)).toBe(true);
	});

	it("rebuilds when the global view file is corrupt", () => {
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["a"]);
		writeFileSync(GLOBAL_HISTORY_FILE, "{ not json");
		expect(loadGlobalIndex().map((e) => e.t)).toEqual(["a"]);
	});

	it("reads the existing view without rebuilding when valid", () => {
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["from-project"]);
		seed(GLOBAL_HISTORY_FILE, ["view-entry"]);
		// Valid view: no rebuild → the project entry is NOT folded in.
		expect(loadGlobalIndex().map((e) => e.t)).toEqual(["view-entry"]);
	});

	it("treats a valid-but-empty view as current (no rebuild)", () => {
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["from-project"]);
		saveHistoryEntries(GLOBAL_HISTORY_FILE, []);
		expect(loadGlobalIndex()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// View readers
// ---------------------------------------------------------------------------

describe("loadViewTexts", () => {
	it("project scope reads the project file", () => {
		config.scope = "project";
		seed(projectHistoryFileFor("/v/cwd"), ["p1", "p2"]);
		seed(GLOBAL_HISTORY_FILE, ["g1"]);
		expect(loadViewTexts("/v/cwd")).toEqual(["p1", "p2"]);
	});

	it("global scope reads the global view (rebuilding if needed)", () => {
		config.scope = "global";
		seed(projectHistoryFileFor("/v/cwd"), ["p1"]);
		seed(GLOBAL_HISTORY_FILE, ["g1", "g2"]);
		expect(loadViewTexts("/v/cwd")).toEqual(["g1", "g2"]);
	});

	it("global scope with a missing view rebuilds from project files", () => {
		config.scope = "global";
		saveHistoryEntries(
			projectHistoryFileFor("/v/cwd"),
			[{ t: "only", ts: 7 }],
		);
		expect(loadViewTexts("/v/cwd")).toEqual(["only"]);
	});
});

describe("loadProjectTexts", () => {
	it("returns the project file texts newest first", () => {
		seed(projectHistoryFileFor("/t/cwd"), ["new", "old"]);
		expect(loadProjectTexts("/t/cwd")).toEqual(["new", "old"]);
	});

	it("returns [] for a project with no file", () => {
		expect(loadProjectTexts("/never/seeded")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// getAllHistoryEntries
// ---------------------------------------------------------------------------

describe("getAllHistoryEntries", () => {
	it("returns [] when no history exists anywhere", () => {
		expect(getAllHistoryEntries()).toEqual([]);
	});

	it("returns the global merged view texts", () => {
		seed(GLOBAL_HISTORY_FILE, ["a", "b"]);
		seed(join(PROJECT_HISTORY_DIR, "p1.json"), ["c"]);
		// Valid view present: project entries not folded in (they were already
		// merged when the view was written).
		expect(getAllHistoryEntries()).toEqual(["a", "b"]);
	});

	it("auto-rebuilds from project files when the view is missing", () => {
		saveHistoryEntries(join(PROJECT_HISTORY_DIR, "p1.json"), [
			{ t: "old", ts: 10 },
			{ t: "older", ts: 5 },
		]);
		saveHistoryEntries(join(PROJECT_HISTORY_DIR, "p2.json"), [{ t: "new", ts: 20 }]);
		expect(getAllHistoryEntries()).toEqual(["new", "old", "older"]);
		// The view file now exists for next time.
		expect(exists(GLOBAL_HISTORY_FILE)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getHistoryEntries
// ---------------------------------------------------------------------------

describe("getHistoryEntries (no-editor branch)", () => {
	// beforeEach sets __setActiveEditor(null) — exercises the loadProjectTexts fallback.

	it("project view never returns the global view's cross-project list", () => {
		config.scope = "global";
		seed(GLOBAL_HISTORY_FILE, ["from-project-a", "from-project-b"]);
		// The Ctrl+R project view must be scoped to this cwd even when the
		// global view holds every project's prompts.
		expect(getHistoryEntries("/proj-c")).toEqual([]);
	});

	it("returns only the entries recorded for that cwd", () => {
		config.scope = "global";
		seed(projectHistoryFileFor("/proj-c"), ["own-1", "own-2"]);
		seed(projectHistoryFileFor("/other"), ["foreign"]);
		expect(getHistoryEntries("/proj-c")).toEqual(["own-1", "own-2"]);
	});

	it("returns [] when the project file does not exist", () => {
		config.scope = "global";
		expect(getHistoryEntries("/some/cwd")).toEqual([]);
	});

	it("respects project scope (reads the project file for that cwd)", () => {
		config.scope = "project";
		const cwd = "/proj/dir";
		seed(historyFileFor(cwd), ["x", "y"]);
		expect(getHistoryEntries(cwd)).toEqual(["x", "y"]);
	});
});

// ---------------------------------------------------------------------------
// ensurePrivateDirs
// ---------------------------------------------------------------------------

describe("ensurePrivateDirs", () => {
	it("tightens CONFIG dir and PROJECT_HISTORY_DIR to 0700 (safe direction)", () => {
		mkdirSync(PROJECT_HISTORY_DIR, { recursive: true });
		chmodSync(TEST_HOME, 0o777);
		chmodSync(PROJECT_HISTORY_DIR, 0o777);
		expect(statSync(TEST_HOME).mode & 0o077).not.toBe(0);
		expect(statSync(PROJECT_HISTORY_DIR).mode & 0o077).not.toBe(0);

		ensurePrivateDirs();

		expect(statSync(TEST_HOME).mode & 0o077).toBe(0);
		expect(statSync(PROJECT_HISTORY_DIR).mode & 0o077).toBe(0);
	});

	it("is safe when PROJECT_HISTORY_DIR does not exist", () => {
		expect(() => ensurePrivateDirs()).not.toThrow();
		// TEST_HOME exists and is tightened (or already 0700)
		expect(statSync(TEST_HOME).mode & 0o077).toBe(0);
	});
});

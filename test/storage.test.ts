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
	loadEntries,
	saveEntries,
	writeAtomic,
	tightenFile,
	isPersistable,
	persistMemory,
	mergeEntries,
	listHistoryFiles,
	ensurePrivateDirs,
} = __internals;

beforeEach(() => {
	cleanHome();
	__resetConfig();
	__setActiveEditor(null);
});

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
// loadEntries
// ---------------------------------------------------------------------------

describe("loadEntries", () => {
	it("returns [] for a missing file", () => {
		expect(loadEntries(join(TEST_HOME, "nope.json"))).toEqual([]);
	});

	it("returns [] for corrupt JSON", () => {
		const f = join(TEST_HOME, "corrupt.json");
		writeFileSync(f, "{ not valid json");
		expect(loadEntries(f)).toEqual([]);
	});

	it("returns [] for non-array JSON (number)", () => {
		const f = join(TEST_HOME, "num.json");
		writeFileSync(f, "5");
		expect(loadEntries(f)).toEqual([]);
	});

	it("returns [] for non-array JSON (object)", () => {
		const f = join(TEST_HOME, "obj.json");
		writeFileSync(f, "{}");
		expect(loadEntries(f)).toEqual([]);
	});

	it("filters out non-string elements from an array", () => {
		const f = join(TEST_HOME, "mixed.json");
		writeFileSync(f, JSON.stringify([1, "a", true, null, "b", {}, "c", undefined]));
		expect(loadEntries(f)).toEqual(["a", "b", "c"]);
	});

	it("returns a valid string[] as-is", () => {
		const f = join(TEST_HOME, "valid.json");
		const entries = ["alpha", "beta", "gamma"];
		writeFileSync(f, JSON.stringify(entries));
		expect(loadEntries(f)).toEqual(entries);
	});

	it("returns [] for an empty array", () => {
		const f = join(TEST_HOME, "empty.json");
		writeFileSync(f, "[]");
		expect(loadEntries(f)).toEqual([]);
	});

	it("tightens file permissions on load", () => {
		const f = join(TEST_HOME, "loose.json");
		writeFileSync(f, JSON.stringify(["a", "b"]));
		chmodSync(f, 0o644);
		expect(statSync(f).mode & 0o077).not.toBe(0);
		loadEntries(f);
		expect(statSync(f).mode & 0o077).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// saveEntries
// ---------------------------------------------------------------------------

describe("saveEntries", () => {
	it("writes a JSON string[] that loadEntries can read back", () => {
		const f = join(TEST_HOME, "save.json");
		const entries = ["x", "y", "z"];
		saveEntries(f, entries);
		expect(loadEntries(f)).toEqual(entries);
	});

	it("creates the file with mode 0600", () => {
		const f = join(TEST_HOME, "save_perms.json");
		saveEntries(f, ["a"]);
		expect(statSync(f).mode & 0o777).toBe(0o600);
	});

	it("creates the parent directory with mode 0700", () => {
		const f = join(TEST_HOME, "subdir", "save.json");
		saveEntries(f, ["a"]);
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
// persistMemory
// ---------------------------------------------------------------------------

describe("persistMemory", () => {
	it("filters non-persistable entries and applies the maxEntries cap", () => {
		config.maxEntries = 3;
		config.minLength = 2;
		const f = join(TEST_HOME, "persist.json");
		persistMemory(f, ["a", "bb", "cc", "dd", "ee"]);
		// "a" too short (minLength=2), rest OK, capped to 3
		expect(loadEntries(f)).toEqual(["bb", "cc", "dd"]);
	});

	it("writes an empty array when no entries are persistable", () => {
		config.minLength = 10;
		const f = join(TEST_HOME, "empty.json");
		persistMemory(f, ["a", "b", "c"]);
		expect(loadEntries(f)).toEqual([]);
	});

	it("writes all entries when under the cap", () => {
		config.maxEntries = 10;
		const f = join(TEST_HOME, "all.json");
		persistMemory(f, ["a", "b", "c"]);
		expect(loadEntries(f)).toEqual(["a", "b", "c"]);
	});
});

// ---------------------------------------------------------------------------
// mergeEntries
// ---------------------------------------------------------------------------

describe("mergeEntries", () => {
	it("places live entries before disk entries (newest-first)", () => {
		config.dedup = "off";
		config.maxEntries = 100;
		expect(mergeEntries(["x", "y"], ["z", "w"])).toEqual(["x", "y", "z", "w"]);
	});

	it("dedup off keeps all entries, sliced to maxEntries", () => {
		config.dedup = "off";
		config.maxEntries = 3;
		expect(mergeEntries(["a", "b"], ["c", "d"])).toEqual(["a", "b", "c"]);
	});

	it("dedup consecutive collapses only adjacent duplicates", () => {
		config.dedup = "consecutive";
		config.maxEntries = 100;
		// persistable = ["a","a","b","b","c"] → a, skip(adj a), b, skip(adj b), c
		expect(mergeEntries(["a", "a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
	});

	it("dedup consecutive keeps non-adjacent duplicates", () => {
		config.dedup = "consecutive";
		config.maxEntries = 100;
		// persistable = ["a","b","a","c"] → a, b, a(not adjacent to b), c
		expect(mergeEntries(["a", "b"], ["a", "c"])).toEqual(["a", "b", "a", "c"]);
	});

	it("dedup always collapses all duplicates keeping first occurrence", () => {
		config.dedup = "always";
		config.maxEntries = 100;
		// persistable = ["a","b","a","c"] → a, b, skip(seen a), c
		expect(mergeEntries(["a", "b"], ["a", "c"])).toEqual(["a", "b", "c"]);
	});

	it("dedup always collapses all-identical input to a single entry", () => {
		config.dedup = "always";
		config.maxEntries = 100;
		expect(mergeEntries(["a", "a", "a"], ["a", "a"])).toEqual(["a"]);
	});

	it("filters both live and disk by isPersistable", () => {
		config.dedup = "off";
		config.maxEntries = 100;
		config.minLength = 3;
		// live=["ab","abc"], disk=["de","def"] → persistable = ["abc","def"]
		expect(mergeEntries(["ab", "abc"], ["de", "def"])).toEqual(["abc", "def"]);
	});

	it("caps to maxEntries", () => {
		config.dedup = "always";
		config.maxEntries = 2;
		// a, b → break at 2
		expect(mergeEntries(["a", "b"], ["c"])).toEqual(["a", "b"]);
	});
});

// ---------------------------------------------------------------------------
// listHistoryFiles
// ---------------------------------------------------------------------------

describe("listHistoryFiles", () => {
	it("returns [] when no files exist", () => {
		expect(listHistoryFiles()).toEqual([]);
	});

	it("returns the global file when it exists", () => {
		saveEntries(GLOBAL_HISTORY_FILE, ["a"]);
		expect(listHistoryFiles()).toEqual([GLOBAL_HISTORY_FILE]);
	});

	it("returns global + project files (global first)", () => {
		saveEntries(GLOBAL_HISTORY_FILE, ["a"]);
		saveEntries(join(PROJECT_HISTORY_DIR, "p1.json"), ["b"]);
		saveEntries(join(PROJECT_HISTORY_DIR, "p2.json"), ["c"]);
		const files = listHistoryFiles();
		expect(files.length).toBe(3);
		expect(files[0]).toBe(GLOBAL_HISTORY_FILE);
		expect(files).toContain(join(PROJECT_HISTORY_DIR, "p1.json"));
		expect(files).toContain(join(PROJECT_HISTORY_DIR, "p2.json"));
	});

	it("returns only project files when global does not exist", () => {
		saveEntries(join(PROJECT_HISTORY_DIR, "p1.json"), ["b"]);
		expect(listHistoryFiles()).toEqual([join(PROJECT_HISTORY_DIR, "p1.json")]);
	});

	it("excludes .json.lock files", () => {
		saveEntries(join(PROJECT_HISTORY_DIR, "p1.json"), ["b"]);
		writeFileSync(join(PROJECT_HISTORY_DIR, "p1.json.lock"), String(process.pid), {
			mode: 0o600,
		});
		const files = listHistoryFiles();
		expect(files).toEqual([join(PROJECT_HISTORY_DIR, "p1.json")]);
	});
});

// ---------------------------------------------------------------------------
// getAllHistoryEntries
// ---------------------------------------------------------------------------

describe("getAllHistoryEntries", () => {
	it("returns [] when no files exist", () => {
		expect(getAllHistoryEntries()).toEqual([]);
	});

	it("merges global + project files, de-duplicated keeping first occurrence", () => {
		saveEntries(GLOBAL_HISTORY_FILE, ["a", "b"]);
		saveEntries(join(PROJECT_HISTORY_DIR, "p1.json"), ["b", "c"]);
		// global first: a, b; then p1: c (b already seen)
		expect(getAllHistoryEntries()).toEqual(["a", "b", "c"]);
	});

	it("de-duplicates across multiple project files (global first)", () => {
		saveEntries(GLOBAL_HISTORY_FILE, ["shared", "g1"]);
		saveEntries(join(PROJECT_HISTORY_DIR, "p1.json"), ["shared", "p1"]);
		saveEntries(join(PROJECT_HISTORY_DIR, "p2.json"), ["shared", "p2"]);
		const result = getAllHistoryEntries();
		expect(result.length).toBe(4);
		expect(result.filter((e) => e === "shared").length).toBe(1);
		expect(result).toContain("g1");
		expect(result).toContain("p1");
		expect(result).toContain("p2");
		// Global entries come before any project entries
		expect(result.indexOf("shared")).toBeLessThan(result.indexOf("p1"));
		expect(result.indexOf("shared")).toBeLessThan(result.indexOf("p2"));
		expect(result.indexOf("g1")).toBeLessThan(result.indexOf("p1"));
	});
});

// ---------------------------------------------------------------------------
// getHistoryEntries
// ---------------------------------------------------------------------------

describe("getHistoryEntries (no-editor branch)", () => {
	// beforeEach sets __setActiveEditor(null) — exercises the loadEntries fallback.

	it("global scope: project view never returns the shared cross-project list", () => {
		config.scope = "global";
		saveEntries(GLOBAL_HISTORY_FILE, ["from-project-a", "from-project-b"]);
		// Regression: the Ctrl+R project view must be scoped to this cwd even
		// when the shared global file holds every project's prompts.
		expect(getHistoryEntries("/proj-c")).toEqual([]);
	});

	it("global scope: returns only the entries recorded for that cwd", () => {
		config.scope = "global";
		saveEntries(projectHistoryFileFor("/proj-c"), ["own-1", "own-2"]);
		saveEntries(projectHistoryFileFor("/other"), ["foreign"]);
		expect(getHistoryEntries("/proj-c")).toEqual(["own-1", "own-2"]);
	});

	it("global scope: returns [] when the project file does not exist", () => {
		config.scope = "global";
		expect(getHistoryEntries("/some/cwd")).toEqual([]);
	});

	it("respects project scope (reads the project file for that cwd)", () => {
		config.scope = "project";
		const cwd = "/proj/dir";
		const f = historyFileFor(cwd);
		saveEntries(f, ["x", "y"]);
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
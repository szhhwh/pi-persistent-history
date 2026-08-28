import { describe, it, expect, beforeEach } from "bun:test";
import {
	__internals,
	__resetConfig,
	config,
	__setActiveEditor,
	historyFileFor,
	getHistoryEntries,
} from "../index.ts";
import { cleanHome, exists } from "./helpers.ts";

const {
	recordEntry,
	PersistentHistoryEditor,
	loadHistoryEntries,
	saveHistoryEntries,
	loadProjectTexts,
	projIdFor,
	GLOBAL_HISTORY_FILE,
} = __internals;

/** Deterministic newest-first seed for a history file. */
const seed = (file: string, arr: string[]) =>
	saveHistoryEntries(file, arr.map((t, i) => ({ t, ts: arr.length - i })));
/** Read back just the texts of a history file. */
const texts = (file: string) => loadHistoryEntries(file).map((e) => e.t);

beforeEach(() => {
	cleanHome();
	__resetConfig();
	__setActiveEditor(null);
});

// ---------------------------------------------------------------------------
// recordEntry — pure helper (no disk, no `this`)
// ---------------------------------------------------------------------------

describe("recordEntry (pure helper)", () => {
	it("returns history unchanged for empty/whitespace text", () => {
		const hist = ["a", "b"];
		// empty/whitespace → same reference returned, input untouched
		expect(recordEntry(hist, "", "off", 10)).toBe(hist);
		expect(recordEntry(hist, "   ", "consecutive", 10)).toBe(hist);
		expect(recordEntry(hist, "\t\n", "always", 10)).toBe(hist);
		expect(hist).toEqual(["a", "b"]);
	});

	it("dedup off: always prepends and caps to maxEntries (truncate tail)", () => {
		expect(recordEntry(["a", "b"], "c", "off", 3)).toEqual(["c", "a", "b"]);
		// overflow truncates the tail
		expect(recordEntry(["a", "b"], "c", "off", 2)).toEqual(["c", "a"]);
		expect(recordEntry(["a", "b", "c"], "d", "off", 2)).toEqual(["d", "a"]);
	});

	it("dedup consecutive: prepends only if head differs; no-prepend returns slice(0, max)", () => {
		// head equals text → no prepend, just cap
		expect(recordEntry(["a", "b"], "a", "consecutive", 10)).toEqual(["a", "b"]);
		// head differs → prepend
		expect(recordEntry(["a", "b"], "c", "consecutive", 10)).toEqual(["c", "a", "b"]);
		// cap applied on prepend
		expect(recordEntry(["a", "b"], "c", "consecutive", 2)).toEqual(["c", "a"]);
		// cap applied on no-prepend (slice path)
		expect(recordEntry(["a", "b", "c"], "a", "consecutive", 2)).toEqual(["a", "b"]);
	});

	it("dedup always: removes ALL earlier copies then prepends", () => {
		expect(recordEntry(["a", "b", "a"], "a", "always", 10)).toEqual(["a", "b"]);
		expect(recordEntry(["b", "a"], "a", "always", 10)).toEqual(["a", "b"]);
		// cap applied
		expect(recordEntry(["b", "c", "d"], "a", "always", 2)).toEqual(["a", "b"]);
		// mid-list copy also removed
		expect(recordEntry(["x", "a", "y"], "a", "always", 10)).toEqual(["a", "x", "y"]);
	});

	it("returns a NEW array and does not mutate the input (prepend cases)", () => {
		const input = ["a", "b"];
		const result = recordEntry(input, "c", "off", 10);
		expect(result).toEqual(["c", "a", "b"]);
		expect(input).toEqual(["a", "b"]);
		expect(result).not.toBe(input);

		const input2 = ["a", "b"];
		const result2 = recordEntry(input2, "c", "consecutive", 10);
		expect(input2).toEqual(["a", "b"]);
		expect(result2).not.toBe(input2);

		const input3 = ["b", "a"];
		const result3 = recordEntry(input3, "a", "always", 10);
		expect(input3).toEqual(["b", "a"]);
		expect(result3).not.toBe(input3);
	});
});

// ---------------------------------------------------------------------------
// PersistentHistoryEditor — constructed via Object.create (no constructor)
// ---------------------------------------------------------------------------

/** Build a degraded instance (no host.history array). */
function makeDegraded(cwd: string): any {
	const ed = Object.create(PersistentHistoryEditor.prototype);
	ed.init(cwd);
	return ed;
}

/** Build a non-degraded instance (host.history array present). */
function makeNonDegraded(cwd: string): any {
	const ed = Object.create(PersistentHistoryEditor.prototype);
	ed.history = [];
	ed.historyIndex = -1;
	ed.historyDraft = null;
	ed.cwd = cwd;
	ed.degraded = false;
	ed.seeded = false;
	ed.fallbackMemory = [];
	ed.init(cwd);
	return ed;
}

describe("PersistentHistoryEditor hostHistory() feature detection", () => {
	it("degrades when no host.history array is present", () => {
		const ed = Object.create(PersistentHistoryEditor.prototype);
		ed.init("/degraded-cwd");
		expect(ed.degraded).toBe(true);
		expect(ed.memory()).toEqual([]);
	});

	it("non-degraded when host.history is an array", () => {
		const ed = makeNonDegraded("/x");
		expect(ed.degraded).toBe(false);
		expect(Array.isArray(ed.memory())).toBe(true);
	});
});

describe("PersistentHistoryEditor init(cwd) seeding", () => {
	it("seeds fallbackMemory from the project file (project view, degraded)", () => {
		config.scope = "project";
		const cwd = "/seed-degraded";
		seed(historyFileFor(cwd), ["s1", "s2"]);
		const ed = makeDegraded(cwd);
		expect(ed.memory()).toEqual(["s1", "s2"]);
	});

	it("seeds host.history from the project file (project view, non-degraded)", () => {
		config.scope = "project";
		const cwd = "/seed-non";
		seed(historyFileFor(cwd), ["n1", "n2"]);
		const ed = makeNonDegraded(cwd);
		expect(ed.memory()).toEqual(["n1", "n2"]);
	});

	it("seeds from the global view when scope is global", () => {
		config.scope = "global";
		seed(GLOBAL_HISTORY_FILE, ["g1", "g2"]);
		const ed = makeDegraded("/seed-global");
		expect(ed.memory()).toEqual(["g1", "g2"]);
	});
});

describe("PersistentHistoryEditor addToHistory (degraded path)", () => {
	it("consecutive dedup: consecutive duplicates collapse", () => {
		const ed = makeDegraded("/deg-cwd");
		ed.addToHistory("x");
		ed.addToHistory("x");
		ed.addToHistory("y");
		expect(ed.memory()).toEqual(["y", "x"]);
	});

	it("persists to BOTH stores when seeded=true", () => {
		const ed = makeDegraded("/persist-cwd");
		ed.addToHistory("x");
		ed.addToHistory("y");
		expect(loadProjectTexts("/persist-cwd")).toEqual(["y", "x"]);
		expect(texts(GLOBAL_HISTORY_FILE)).toEqual(["y", "x"]);
	});

	it("does NOT write to disk when seeded=false", () => {
		const ed = Object.create(PersistentHistoryEditor.prototype);
		// do NOT call init → seeded is undefined (falsy)
		ed.fallbackMemory = [];
		ed.cwd = "/no-seed";
		ed.addToHistory("x");
		expect(ed.memory()).toEqual(["x"]);
		expect(loadProjectTexts("/no-seed")).toEqual([]);
		expect(exists(GLOBAL_HISTORY_FILE)).toBe(false);
	});
});

describe("PersistentHistoryEditor addToHistory with dedup always", () => {
	it("degraded path: removes earlier copy", () => {
		config.dedup = "always";
		const ed = makeDegraded("/always-deg");
		ed.addToHistory("a");
		ed.addToHistory("b");
		ed.addToHistory("a");
		expect(ed.memory()).toEqual(["a", "b"]);
	});

	it("non-degraded path: updates host.history in place (same reference)", () => {
		config.dedup = "always";
		const ed = makeNonDegraded("/always-non");
		const ref = ed.memory();
		ed.addToHistory("a");
		ed.addToHistory("b");
		ed.addToHistory("a");
		expect(ed.memory()).toEqual(["a", "b"]);
		// same array reference — mutated in place, not replaced
		expect(ed.memory()).toBe(ref);
	});
});

describe("PersistentHistoryEditor setMemory", () => {
	it("degraded path: replaces fallbackMemory", () => {
		const ed = makeDegraded("/setmem-deg");
		ed.setMemory(["p", "q"]);
		expect(ed.memory()).toEqual(["p", "q"]);
	});

	it("non-degraded path: replaces host.history and resets index/draft", () => {
		const ed = makeNonDegraded("/setmem-non");
		// perturb index/draft to confirm setMemory resets them
		ed.historyIndex = 5;
		ed.historyDraft = "draft";
		ed.setMemory(["r", "s"]);
		expect(ed.memory()).toEqual(["r", "s"]);
		expect(ed.historyIndex).toBe(-1);
		expect(ed.historyDraft).toBeNull();
	});
});

describe("PersistentHistoryEditor reloadFromDisk", () => {
	it("replaces memory with the view file's contents", () => {
		config.scope = "project";
		const cwd = "/reload-cwd";
		const ed = makeDegraded(cwd);
		ed.setMemory(["a", "b"]);
		// Overwrite the project file behind the view.
		seed(historyFileFor(cwd), ["z", "y"]);
		ed.reloadFromDisk();
		expect(ed.memory()).toEqual(["z", "y"]);
	});

	it("re-seeds from the global view when scope is global", () => {
		config.scope = "global";
		const ed = makeDegraded("/reload-global");
		ed.setMemory(["a"]);
		seed(GLOBAL_HISTORY_FILE, ["z"]);
		ed.reloadFromDisk();
		expect(ed.memory()).toEqual(["z"]);
	});
});

describe("PersistentHistoryEditor maxEntries cap in addToHistory", () => {
	it("caps memory to config.maxEntries", () => {
		config.maxEntries = 2;
		const ed = makeDegraded("/cap-cwd");
		ed.addToHistory("a");
		ed.addToHistory("b");
		ed.addToHistory("c");
		expect(ed.memory().length).toBe(2);
		expect(ed.memory()).toEqual(["c", "b"]);
	});
});

describe("PersistentHistoryEditor addToHistory store attribution", () => {
	it("credits BOTH the per-project file and the global view (any scope)", () => {
		const ed = makeDegraded("/dual-cwd");
		ed.addToHistory("only-here");
		expect(loadProjectTexts("/dual-cwd")).toEqual(["only-here"]);
		const g = loadHistoryEntries(GLOBAL_HISTORY_FILE);
		expect(g.map((e) => e.t)).toEqual(["only-here"]);
		expect(g[0].p).toBe(projIdFor("/dual-cwd"));
	});

	it("project file gets ONLY the new entry, never the cross-project list", () => {
		const cwd = "/dual-isolated";
		const ed = makeDegraded(cwd);
		// Simulate a cross-project mix living in memory (global view); only the
		// newly typed entry may be credited to this project's file.
		ed.setMemory(["foreign-a", "foreign-b"]);
		ed.addToHistory("mine");
		expect(loadProjectTexts(cwd)).toEqual(["mine"]);
		// …and the global view also gets ONLY the new entry, never the list.
		expect(texts(GLOBAL_HISTORY_FILE)).toEqual(["mine"]);
	});

	it("honors isPersistable in both stores (recordCommands off)", () => {
		const ed = makeDegraded("/dual-cmd");
		ed.addToHistory("/slash-command");
		expect(loadProjectTexts("/dual-cmd")).toEqual([]);
		expect(texts(GLOBAL_HISTORY_FILE)).toEqual([]);
	});

	it("project view: writes BOTH stores too (scope never changes storage)", () => {
		config.scope = "project";
		const ed = makeDegraded("/proj-only");
		ed.addToHistory("p-entry");
		expect(loadProjectTexts("/proj-only")).toEqual(["p-entry"]);
		expect(texts(GLOBAL_HISTORY_FILE)).toEqual(["p-entry"]);
	});
});

describe("live singleton editor via __setActiveEditor", () => {
	it("project scope: getHistoryEntries uses the active editor's memory, then disk", () => {
		config.scope = "project";
		const cwd = "/singleton-cwd";
		const ed = makeDegraded(cwd);
		ed.addToHistory("hello");
		__setActiveEditor(ed);
		// active editor present → returns its in-memory list
		expect(getHistoryEntries(cwd)).toEqual(["hello"]);
		__setActiveEditor(null);
		// no active editor → falls back to on-disk entries (persisted above)
		expect(getHistoryEntries(cwd)).toEqual(["hello"]);
	});

	it("global scope: getHistoryEntries ignores the shared memory and reads the project file", () => {
		const cwd = "/singleton-global";
		const ed = makeDegraded(cwd);
		// Memory holds a cross-project mix; the project view must NOT surface it.
		ed.setMemory(["other-project-a", "other-project-b"]);
		__setActiveEditor(ed);
		expect(getHistoryEntries(cwd)).toEqual([]);
		ed.addToHistory("typed-here");
		// The dual-write credited the project file → now visible in the view.
		expect(getHistoryEntries(cwd)).toEqual(["typed-here"]);
		__setActiveEditor(null);
	});
});
import { describe, it, expect, beforeEach } from "bun:test";
import {
	__internals,
	__resetConfig,
	config,
	__setActiveEditor,
	historyFileFor,
	getHistoryEntries,
} from "../index.ts";
import { cleanHome } from "./helpers.ts";
import { writeFileSync } from "node:fs";

const { recordEntry, PersistentHistoryEditor, loadEntries } = __internals;

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
	it("seeds fallbackMemory from the on-disk file (degraded)", () => {
		const cwd = "/seed-degraded";
		writeFileSync(historyFileFor(cwd), JSON.stringify(["s1", "s2"]));
		const ed = makeDegraded(cwd);
		expect(ed.memory()).toEqual(["s1", "s2"]);
	});

	it("seeds host.history from the on-disk file (non-degraded)", () => {
		const cwd = "/seed-non";
		writeFileSync(historyFileFor(cwd), JSON.stringify(["n1", "n2"]));
		const ed = makeNonDegraded(cwd);
		expect(ed.memory()).toEqual(["n1", "n2"]);
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

	it("persists to disk when seeded=true", () => {
		const ed = makeDegraded("/persist-cwd");
		ed.addToHistory("x");
		ed.addToHistory("y");
		expect(loadEntries(historyFileFor("/persist-cwd"))).toEqual(["y", "x"]);
	});

	it("does NOT write to disk when seeded=false", () => {
		const ed = Object.create(PersistentHistoryEditor.prototype);
		// do NOT call init → seeded is undefined (falsy)
		ed.fallbackMemory = [];
		ed.cwd = "/no-seed";
		ed.addToHistory("x");
		expect(ed.memory()).toEqual(["x"]);
		expect(loadEntries(historyFileFor("/no-seed"))).toEqual([]);
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
	it("replaces memory with the on-disk contents", () => {
		const cwd = "/reload-cwd";
		const ed = makeDegraded(cwd);
		ed.setMemory(["a", "b"]);
		// write a different file
		writeFileSync(historyFileFor(cwd), JSON.stringify(["z", "y"]));
		ed.reloadFromDisk();
		expect(ed.memory()).toEqual(["z", "y"]);
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

describe("live singleton editor via __setActiveEditor", () => {
	it("getHistoryEntries uses the active editor's memory, then falls back to disk", () => {
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
});
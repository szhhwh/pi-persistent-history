import { describe, it, expect, beforeEach } from "bun:test";
import {
	__internals,
	config,
	__resetConfig,
	__setActiveEditor,
	statusText,
	onOff,
	historyFileFor,
	getHistoryEntries,
} from "../index.ts";
import { makeCtx, cleanHome, TEST_HOME } from "./helpers.ts";
import { readFileSync } from "node:fs";

const {
	argumentCompletions,
	handleHistoryCommand,
	handleSettingsCommand,
	SUBCOMMANDS,
	CONFIG_KEYS,
	HELP_TEXT,
	configValueAsString,
	loadHistoryEntries,
	saveHistoryEntries,
	loadProjectTexts,
	projIdFor,
	GLOBAL_HISTORY_FILE,
	PROJECT_HISTORY_DIR,
	PersistentHistoryEditor,
} = __internals;

/** Deterministic newest-first seed for a history file. */
const seed = (file: string, arr: string[]) =>
	saveHistoryEntries(file, arr.map((t, i) => ({ t, ts: arr.length - i })));
/** Read back just the texts of a history file. */
const texts = (file: string) => loadHistoryEntries(file).map((e) => e.t);
/** The project file for the default test cwd. */
const projectFileFor = () => __internals.projectHistoryFileFor("/test-cwd");

beforeEach(() => {
	cleanHome();
	__resetConfig();
	__setActiveEditor(null);
});

// ---------------------------------------------------------------------------
// argumentCompletions
// ---------------------------------------------------------------------------

describe("argumentCompletions", () => {
	describe("level 0 — subcommand completion", () => {
		it("returns subcommands starting with the prefix", () => {
			const hits = argumentCompletions("sh");
			expect(hits).not.toBeNull();
			expect(hits!.length).toBe(1);
			expect(hits![0].value).toBe("show");
			expect(hits![0].label).toBe("show");
		});

		it("returns null on an exact unique match (hidden so Enter submits)", () => {
			expect(argumentCompletions("clear")).toBeNull();
		});

		it("returns null when nothing matches", () => {
			expect(argumentCompletions("zzz")).toBeNull();
		});

		it("returns multiple subcommands for a broad prefix", () => {
			const hits = argumentCompletions("s");
			expect(hits).not.toBeNull();
			const labels = hits!.map((h) => h.label);
			expect(labels).toContain("show");
			expect(labels).toContain("set");
		});

		it("returns all subcommands for an empty prefix", () => {
			const hits = argumentCompletions("");
			expect(hits).not.toBeNull();
			expect(hits!.length).toBe(SUBCOMMANDS.length);
			for (const item of hits!) {
				expect(item.value).toBe(item.label);
			}
		});
	});

	describe("level 1 — set <key>", () => {
		it("returns all CONFIG keys for 'set ' (empty last token)", () => {
			const hits = argumentCompletions("set ");
			expect(hits).not.toBeNull();
			const labels = hits!.map((h) => h.label);
			expect(labels).toEqual(Object.keys(CONFIG_KEYS));
			// values are full replacement text including the prior token
			for (const item of hits!) {
				expect(item.value).toBe(`set ${item.label}`);
			}
		});

		it("filters keys by the last token ('set s' → scope, searchRows)", () => {
			const hits = argumentCompletions("set s");
			expect(hits).not.toBeNull();
			const labels = hits!.map((h) => h.label);
			expect(labels).toEqual(["scope", "searchRows"]);
			expect(hits![0].value).toBe("set scope");
			expect(hits![1].value).toBe("set searchRows");
		});

		it("filters keys by the last token ('set sc' → scope only; searchRows starts with 'se')", () => {
			const hits = argumentCompletions("set sc");
			expect(hits).not.toBeNull();
			expect(hits!.map((h) => h.label)).toEqual(["scope"]);
		});

		it("returns null on an exact unique key match ('set scope')", () => {
			expect(argumentCompletions("set scope")).toBeNull();
		});

		it("returns null for a key prefix that matches nothing", () => {
			expect(argumentCompletions("set zzzz")).toBeNull();
		});
	});

	describe("level 2 — set <key> <value>", () => {
		it("enum keys filter values by the last token (scope → global|project)", () => {
			const hits = argumentCompletions("set scope ");
			expect(hits).not.toBeNull();
			const labels = hits!.map((h) => h.label);
			expect(labels).toEqual(["global", "project"]);
			expect(hits![0].value).toBe("set scope global");
			expect(hits![1].value).toBe("set scope project");
		});

		it("dedup → consecutive|always|off", () => {
			const hits = argumentCompletions("set dedup ");
			expect(hits).not.toBeNull();
			expect(hits!.map((h) => h.label)).toEqual(["consecutive", "always", "off"]);
		});

		it("enabled → on|off", () => {
			const hits = argumentCompletions("set enabled ");
			expect(hits).not.toBeNull();
			expect(hits!.map((h) => h.label)).toEqual(["on", "off"]);
		});

		it("recordCommands → on|off", () => {
			const hits = argumentCompletions("set recordCommands ");
			expect(hits).not.toBeNull();
			expect(hits!.map((h) => h.label)).toEqual(["on", "off"]);
		});

		it("filters enum values by prefix ('set scope g' → global)", () => {
			const hits = argumentCompletions("set scope g");
			expect(hits).not.toBeNull();
			expect(hits!.length).toBe(1);
			expect(hits![0].label).toBe("global");
			expect(hits![0].value).toBe("set scope global");
		});

		it("returns null on exact enum match ('set scope global')", () => {
			expect(argumentCompletions("set scope global")).toBeNull();
		});

		it("numeric keys (maxEntries etc.) have no enum → [] → null", () => {
			expect(argumentCompletions("set maxEntries ")).toBeNull();
			expect(argumentCompletions("set maxEntryChars ")).toBeNull();
			expect(argumentCompletions("set minLength ")).toBeNull();
			expect(argumentCompletions("set searchRows ")).toBeNull();
		});
	});

	describe("unrelated prefixes", () => {
		it("returns null for a non-set level-1 prefix ('foo bar')", () => {
			expect(argumentCompletions("foo bar")).toBeNull();
		});

		it("returns null at level 2 when prior is not 'set'", () => {
			expect(argumentCompletions("show 3")).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// configValueAsString
// ---------------------------------------------------------------------------

describe("configValueAsString", () => {
	it("renders boolean fields as on/off", () => {
		expect(configValueAsString("enabled")).toBe("on");
		config.enabled = false;
		expect(configValueAsString("enabled")).toBe("off");
		__resetConfig();
		expect(configValueAsString("recordCommands")).toBe("off");
		config.recordCommands = true;
		expect(configValueAsString("recordCommands")).toBe("on");
	});

	it("renders numeric fields as strings", () => {
		expect(configValueAsString("maxEntries")).toBe(String(config.maxEntries));
		config.maxEntries = 42;
		expect(configValueAsString("maxEntries")).toBe("42");
	});

	it("renders scope and dedup as their string values", () => {
		expect(configValueAsString("scope")).toBe("global");
		config.scope = "project";
		expect(configValueAsString("scope")).toBe("project");
		expect(configValueAsString("dedup")).toBe("consecutive");
	});
});

// ---------------------------------------------------------------------------
// handleHistoryCommand
// ---------------------------------------------------------------------------

/** Build a minimal mock editor backed by fallbackMemory (no host history array). */
function makeMockEditor(cwd: string, entries: string[] = []) {
	const editor = Object.create(PersistentHistoryEditor.prototype) as InstanceType<
		typeof PersistentHistoryEditor
	>;
	editor.cwd = cwd;
	editor.degraded = false;
	editor.seeded = true;
	editor.fallbackMemory = [...entries];
	return editor;
}

function lastNotify(ctx: ReturnType<typeof makeCtx>) {
	return ctx._notifications[ctx._notifications.length - 1];
}

describe("handleHistoryCommand", () => {
	describe("help", () => {
		it("notifies with HELP_TEXT", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("help", ctx);
			expect(ctx._notifications.length).toBe(1);
			expect(ctx._notifications[0].level).toBe("info");
			expect(ctx._notifications[0].text).toBe(HELP_TEXT);
		});
	});

	describe("path", () => {
		it("notifies with the historyFileFor(cwd) path", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("path", ctx);
			expect(ctx._notifications.length).toBe(1);
			expect(ctx._notifications[0].text).toBe(historyFileFor("/test-cwd"));
			expect(ctx._notifications[0].level).toBe("info");
		});
	});

	describe("show", () => {
		it("notifies 'History is empty.' when there are no entries", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("show", ctx);
			expect(ctx._notifications.length).toBe(1);
			expect(ctx._notifications[0].text).toBe("History is empty.");
			expect(ctx._notifications[0].level).toBe("info");
		});

		it("lists seeded disk entries with numbering", async () => {
			const ctx = makeCtx();
			saveHistoryEntries(historyFileFor("/test-cwd"), [
				{ t: "alpha", ts: 3 },
				{ t: "beta", ts: 2 },
				{ t: "gamma", ts: 1 },
			]);
			await handleHistoryCommand("show", ctx);
			const text = ctx._notifications[0].text;
			expect(text).toContain("Recent 3 of 3 entries:");
			expect(text).toContain("1. alpha");
			expect(text).toContain("2. beta");
			expect(text).toContain("3. gamma");
		});

		it("respects a count argument ('show 2') capping the list", async () => {
			const ctx = makeCtx();
			saveHistoryEntries(historyFileFor("/test-cwd"), [
				{ t: "a", ts: 5 },
				{ t: "b", ts: 4 },
				{ t: "c", ts: 3 },
				{ t: "d", ts: 2 },
				{ t: "e", ts: 1 },
			]);
			await handleHistoryCommand("show 2", ctx);
			const text = ctx._notifications[0].text;
			expect(text).toContain("Recent 2 of 5 entries:");
			expect(text).toContain("1. a");
			expect(text).toContain("2. b");
			expect(text).not.toContain("3. c");
		});

		it("uses the live editor memory when an active editor is set", async () => {
			const ctx = makeCtx();
			const editor = makeMockEditor("/test-cwd", ["live-a", "live-b"]);
			__setActiveEditor(editor);
			await handleHistoryCommand("show", ctx);
			const text = ctx._notifications[0].text;
			expect(text).toContain("live-a");
			expect(text).toContain("live-b");
		});
	});

	describe("set", () => {
		it("sets maxEntries and notifies ok", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("set maxEntries 5", ctx);
			expect(config.maxEntries).toBe(5);
			expect(ctx._notifications.length).toBe(1);
			expect(ctx._notifications[0].text).toBe("Set maxEntries = 5");
			expect(ctx._notifications[0].level).toBe("info");
		});

		it("rejects maxEntries 0 with an error notify", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("set maxEntries 0", ctx);
			expect(ctx._notifications[0].level).toBe("error");
			expect(ctx._notifications[0].text).toContain("Invalid value for maxEntries");
			expect(config.maxEntries).not.toBe(0);
		});

		it("rejects an unknown option with an error notify containing 'Unknown option'", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("set bogus x", ctx);
			expect(ctx._notifications[0].level).toBe("error");
			expect(ctx._notifications[0].text).toContain("Unknown option");
		});

		it("warns with usage when no key is given ('set')", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("set", ctx);
			expect(ctx._notifications[0].level).toBe("warning");
			expect(ctx._notifications[0].text).toContain("Usage: /history set");
		});

		it("warns when key is given but value is missing", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("set maxEntries", ctx);
			expect(ctx._notifications[0].level).toBe("warning");
			expect(ctx._notifications[0].text).toContain("Usage: /history set");
		});
	});

	describe("remove", () => {
		it("removes matching entries from disk and memory, notifying the count", async () => {
			const ctx = makeCtx();
			const file = historyFileFor("/test-cwd");
			seed(file, ["apple", "banana", "cherry"]);
			await handleHistoryCommand("remove an", ctx);
			// "banana" contains "an"; "apple" and "cherry" do not
			expect(ctx._notifications[0].level).toBe("info");
			expect(ctx._notifications[0].text).toContain("Removed 1 entr");
			// disk reflects the removal — scrubbed in BOTH stores (the global view
			// spans every project, so it is always scrubbed too)
			expect(texts(file)).toEqual(["apple", "cherry"]);
			expect(texts(GLOBAL_HISTORY_FILE)).toEqual(["apple", "cherry"]);
		});

		it("works against the live editor memory when active", async () => {
			const ctx = makeCtx();
			const editor = makeMockEditor("/test-cwd", ["apple", "banana", "cherry"]);
			__setActiveEditor(editor);
			await handleHistoryCommand("remove an", ctx);
			expect(editor.memory()).toEqual(["apple", "cherry"]);
			expect(ctx._notifications[0].text).toContain("Removed 1 entr");
		});

		it("warns with usage when the needle is empty", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("remove", ctx);
			expect(ctx._notifications[0].level).toBe("warning");
			expect(ctx._notifications[0].text).toContain("Usage: /history remove");
		});

		it("notifies zero removed when nothing matches", async () => {
			const ctx = makeCtx();
			seed(historyFileFor("/test-cwd"), ["apple", "banana"]);
			await handleHistoryCommand("remove zzz", ctx);
			expect(ctx._notifications[0].text).toContain("Removed 0");
		});
	});

	describe("clear", () => {
		it("refuses without --yes when hasUI is false (warning)", async () => {
			const ctx = makeCtx();
			seed(historyFileFor("/test-cwd"), ["a", "b"]);
			await handleHistoryCommand("clear", ctx);
			expect(ctx._notifications[0].level).toBe("warning");
			expect(ctx._notifications[0].text).toContain("Refusing to clear");
		});

		it("clears this project's file and purges its entries from the global view", async () => {
			const ctx = makeCtx();
			const pf = projectFileFor();
			seed(pf, ["mine-1", "mine-2"]);
			saveHistoryEntries(GLOBAL_HISTORY_FILE, [
				{ t: "mine-1", ts: 30, p: projIdFor("/test-cwd") },
				{ t: "foreign", ts: 20, p: "other-project" },
				{ t: "mine-2", ts: 10, p: projIdFor("/test-cwd") },
			]);
			await handleHistoryCommand("clear --yes", ctx);
			expect(ctx._notifications[0].level).toBe("info");
			expect(ctx._notifications[0].text).toContain("Cleared");
			// This project's own file is empty; the global view keeps ONLY the
			// other project's entries.
			expect(texts(pf)).toEqual([]);
			expect(texts(GLOBAL_HISTORY_FILE)).toEqual(["foreign"]);
		});

		it("clears the live editor memory too", async () => {
			const ctx = makeCtx();
			config.scope = "project";
			seed(historyFileFor("/test-cwd"), ["a", "b"]);
			const editor = makeMockEditor("/test-cwd", ["a", "b"]);
			__setActiveEditor(editor);
			await handleHistoryCommand("clear --yes", ctx);
			expect(editor.memory()).toEqual([]);
		});

		it("--all --yes deletes every history file and notifies the count", async () => {
			const ctx = makeCtx();
			config.scope = "project";
			const f1 = historyFileFor("/proj-a");
			const f2 = historyFileFor("/proj-b");
			seed(f1, ["a"]);
			seed(f2, ["b"]);
			seed(GLOBAL_HISTORY_FILE, ["g"]);
			// sanity: three files exist
			expect(loadHistoryEntries(f1).length).toBe(1);
			expect(loadHistoryEntries(f2).length).toBe(1);
			expect(loadHistoryEntries(GLOBAL_HISTORY_FILE).length).toBe(1);
			await handleHistoryCommand("clear --all --yes", ctx);
			expect(ctx._notifications[0].level).toBe("info");
			expect(ctx._notifications[0].text).toContain("Deleted 3 history file(s).");
			// all gone
			expect(loadHistoryEntries(f1)).toEqual([]);
			expect(loadHistoryEntries(f2)).toEqual([]);
			expect(loadHistoryEntries(GLOBAL_HISTORY_FILE)).toEqual([]);
		});
	});

	describe("reload", () => {
		it("warns 'No live editor' when there is no active editor", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("reload", ctx);
			expect(ctx._notifications[0].level).toBe("warning");
			expect(ctx._notifications[0].text).toContain("No live editor");
		});

		it("reloads from disk and notifies the count when an editor is active", async () => {
			const ctx = makeCtx();
			const file = historyFileFor("/test-cwd");
			seed(file, ["x", "y", "z"]);
			const editor = makeMockEditor("/test-cwd", []);
			__setActiveEditor(editor);
			await handleHistoryCommand("reload", ctx);
			expect(editor.memory()).toEqual(["x", "y", "z"]);
			expect(ctx._notifications[0].level).toBe("info");
			expect(ctx._notifications[0].text).toContain("Reloaded 3 entries");
		});

		it("notes recording is off when config.enabled is false", async () => {
			const ctx = makeCtx();
			config.enabled = false;
			seed(historyFileFor("/test-cwd"), ["x"]);
			const editor = makeMockEditor("/test-cwd", []);
			__setActiveEditor(editor);
			await handleHistoryCommand("reload", ctx);
			expect(ctx._notifications[0].text).toContain("recording is off");
		});
	});

	describe("pick", () => {
		it("warns when not in tui mode", async () => {
			const ctx = makeCtx();
			seed(historyFileFor("/test-cwd"), ["apple"]);
			await handleHistoryCommand("pick", ctx);
			expect(ctx._notifications[0].level).toBe("warning");
			expect(ctx._notifications[0].text).toContain("interactive mode");
		});

		it("in tui mode, sets the editor text to the full chosen entry", async () => {
			const ctx = makeCtx({ mode: "tui", hasUI: true, _selected: "banana" });
			seed(historyFileFor("/test-cwd"), ["apple", "banana", "cherry"]);
			let captured = "";
			ctx.ui.setEditorText = (text: string) => {
				captured = text;
			};
			await handleHistoryCommand("pick", ctx);
			expect(captured).toBe("banana");
		});

		it("in tui mode with empty history, notifies 'History is empty.'", async () => {
			const ctx = makeCtx({ mode: "tui", hasUI: true });
			await handleHistoryCommand("pick", ctx);
			expect(ctx._notifications[0].text).toBe("History is empty.");
		});
	});

	describe("misc", () => {
		it("errors on an unknown subcommand", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("bogus", ctx);
			expect(ctx._notifications[0].level).toBe("error");
			expect(ctx._notifications[0].text).toContain("Unknown subcommand");
		});

		it("warns about interactive mode when no subcommand is given in non-tui ctx", async () => {
			const ctx = makeCtx();
			await handleHistoryCommand("", ctx);
			expect(ctx._notifications[0].level).toBe("warning");
			expect(ctx._notifications[0].text).toContain("interactive mode");
		});
	});
});

// ---------------------------------------------------------------------------
// handleSettingsCommand
// ---------------------------------------------------------------------------

describe("handleSettingsCommand", () => {
	it("notifies statusText(cwd) in non-tui mode (info)", async () => {
		const ctx = makeCtx();
		config.maxEntries = 7;
		await handleSettingsCommand("", ctx);
		expect(ctx._notifications.length).toBe(1);
		expect(ctx._notifications[0].level).toBe("info");
		expect(ctx._notifications[0].text).toBe(statusText("/test-cwd"));
	});

	it("statusText in the notification reflects config changes", async () => {
		const ctx = makeCtx();
		config.scope = "project";
		await handleSettingsCommand("", ctx);
		expect(ctx._notifications[0].text).toContain("scope:            project");
	});
});

// ---------------------------------------------------------------------------
// getHistoryEntries (disk-backed when no active editor)
// ---------------------------------------------------------------------------

describe("getHistoryEntries", () => {
	it("returns disk entries when there is no active editor", () => {
		config.scope = "project";
		seed(historyFileFor("/test-cwd"), ["one", "two"]);
		expect(getHistoryEntries("/test-cwd")).toEqual(["one", "two"]);
	});

	it("returns live editor memory when an editor is active (project scope)", () => {
		config.scope = "project";
		const editor = makeMockEditor("/test-cwd", ["mem-a", "mem-b"]);
		__setActiveEditor(editor);
		expect(getHistoryEntries("/test-cwd")).toEqual(["mem-a", "mem-b"]);
	});

	it("global scope: never returns the shared list even with an active editor", () => {
		// Regression: with an editor seeded from the global file, the project
		// view used to leak every project's prompts via live memory.
		saveHistoryEntries(GLOBAL_HISTORY_FILE, [{ t: "cross-a", ts: 1 }]);
		const editor = makeMockEditor("/test-cwd", ["cross-a"]);
		__setActiveEditor(editor);
		expect(getHistoryEntries("/test-cwd")).toEqual([]);
	});
});

// keep TEST_HOME referenced so linters don't drop the import
void TEST_HOME;
void onOff;
void readFileSync;
void PROJECT_HISTORY_DIR;
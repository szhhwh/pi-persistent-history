import { describe, it, expect, beforeEach } from "bun:test";
import { __internals, __resetConfig, config, setOption, onOff, statusText } from "../index.ts";
import { cleanHome, TEST_HOME } from "./helpers.ts";
import { writeFileSync } from "node:fs";

const { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig, parseBool, CONFIG_FILE } =
	__internals;

beforeEach(() => {
	cleanHome();
	__resetConfig();
});

describe("normalizeConfig", () => {
	it("applies valid fields over the previous baseline", () => {
		const c = normalizeConfig(
			{
				enabled: false,
				maxEntries: 7,
				maxEntryChars: 42,
				scope: "project",
				dedup: "always",
				recordCommands: true,
				minLength: 3,
				searchRows: 25,
			},
			DEFAULT_CONFIG,
		);
		expect(c).toEqual({
			enabled: false,
			maxEntries: 7,
			maxEntryChars: 42,
			scope: "project",
			dedup: "always",
			recordCommands: true,
			minLength: 3,
			searchRows: 25,
		});
	});

	it("ignores out-of-range / wrong-type values, keeping previous", () => {
		const base = { ...DEFAULT_CONFIG, maxEntries: 99, minLength: 5, searchRows: 20, dedup: "off" as const };
		const c = normalizeConfig(
			{
				maxEntries: 0, // <1 → ignore
				maxEntries: 5.5, // non-integer → ignore
				maxEntryChars: 0, // <1 → ignore
				scope: "bogus", // invalid → ignore
				dedup: "nope", // invalid → ignore
				recordCommands: "yes", // non-boolean → ignore
				minLength: -1, // <0 → ignore
				searchRows: 0, // <1 → ignore
				searchRows: 51, // >50 → ignore
				enabled: "true", // non-boolean → ignore
			} as unknown as Record<string, unknown>,
			base,
		);
		expect(c.maxEntries).toBe(99);
		expect(c.maxEntryChars).toBe(DEFAULT_CONFIG.maxEntryChars);
		expect(c.scope).toBe("global");
		expect(c.dedup).toBe("off");
		expect(c.recordCommands).toBe(false);
		expect(c.minLength).toBe(5);
		expect(c.searchRows).toBe(20);
		expect(c.enabled).toBe(true);
	});

	it("returns the baseline unchanged for a non-object payload", () => {
		expect(normalizeConfig(null as unknown, DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig(123 as unknown, DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig([1, 2] as unknown, DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
	});
});

describe("loadConfig", () => {
	it("returns defaults when no config file exists", () => {
		expect(loadConfig()).toEqual(DEFAULT_CONFIG);
	});

	it("parses a valid config file", () => {
		writeFileSync(
			CONFIG_FILE,
			JSON.stringify({ maxEntries: 13, dedup: "always", scope: "project" }),
		);
		const c = loadConfig();
		expect(c.maxEntries).toBe(13);
		expect(c.dedup).toBe("always");
		expect(c.scope).toBe("project");
	});

	it("disables persistence when the config file is corrupt JSON", () => {
		writeFileSync(CONFIG_FILE, "{ not valid json");
		const c = loadConfig();
		// Fail-safe: corrupt config must not silently re-enable persistence.
		expect(c.enabled).toBe(false);
		expect(c.maxEntries).toBe(DEFAULT_CONFIG.maxEntries);
	});

	it("the imported singleton matches defaults on a fresh temp home", () => {
		expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
		expect(config.scope).toBe(DEFAULT_CONFIG.scope);
		expect(config.maxEntries).toBe(DEFAULT_CONFIG.maxEntries);
	});
});

describe("saveConfig", () => {
	it("round-trips config through disk via loadConfig", () => {
		config.maxEntries = 250;
		config.dedup = "off";
		config.scope = "project";
		saveConfig();
		const reloaded = loadConfig();
		expect(reloaded.maxEntries).toBe(250);
		expect(reloaded.dedup).toBe("off");
		expect(reloaded.scope).toBe("project");
	});
});

describe("setOption", () => {
	it("sets enabled on/off and persists", () => {
		expect(setOption("enabled", "off")).toMatchObject({ ok: true });
		expect(config.enabled).toBe(false);
		expect(loadConfig().enabled).toBe(false);
		expect(setOption("enabled", "on")).toMatchObject({ ok: true });
		expect(config.enabled).toBe(true);
	});

	it("rejects invalid enabled values", () => {
		const r = setOption("enabled", "maybe");
		expect(r.ok).toBe(false);
		expect(config.enabled).toBe(true); // unchanged
	});

	it("sets maxEntries (positive int) and persists", () => {
		expect(setOption("maxEntries", "8").ok).toBe(true);
		expect(config.maxEntries).toBe(8);
		expect(loadConfig().maxEntries).toBe(8);
	});

	it("rejects non-positive / non-integer maxEntries", () => {
		expect(setOption("maxEntries", "0").ok).toBe(false);
		expect(setOption("maxEntries", "-3").ok).toBe(false);
		expect(setOption("maxEntries", "abc").ok).toBe(false);
	});

	it("parses maxEntries with parseInt (truncates decimals)", () => {
		// parseInt("2.5") === 2 — a positive integer, so it is accepted as 2.
		const r = setOption("maxEntries", "2.5");
		expect(r.ok).toBe(true);
		expect(config.maxEntries).toBe(2);
	});

	it("sets maxEntryChars and rejects invalid", () => {
		expect(setOption("maxEntryChars", "2048").ok).toBe(true);
		expect(config.maxEntryChars).toBe(2048);
		expect(setOption("maxEntryChars", "0").ok).toBe(false);
	});

	it("sets scope global|project and rejects invalid", () => {
		expect(setOption("scope", "project").ok).toBe(true);
		expect(config.scope).toBe("project");
		expect(setOption("scope", "global").ok).toBe(true);
		expect(config.scope).toBe("global");
		expect(setOption("scope", "galaxy").ok).toBe(false);
	});

	it("sets dedup and rejects invalid", () => {
		expect(setOption("dedup", "always").ok).toBe(true);
		expect(config.dedup).toBe("always");
		expect(setOption("dedup", "nope").ok).toBe(false);
	});

	it("sets recordCommands on/off and rejects invalid", () => {
		expect(setOption("recordCommands", "on").ok).toBe(true);
		expect(config.recordCommands).toBe(true);
		expect(setOption("recordCommands", "off").ok).toBe(true);
		expect(config.recordCommands).toBe(false);
		expect(setOption("recordCommands", "yep").ok).toBe(false);
	});

	it("sets minLength (non-negative int) and rejects negative", () => {
		expect(setOption("minLength", "2").ok).toBe(true);
		expect(config.minLength).toBe(2);
		expect(setOption("minLength", "-1").ok).toBe(false);
	});

	it("sets searchRows 1-50 and rejects out-of-range", () => {
		expect(setOption("searchRows", "15").ok).toBe(true);
		expect(config.searchRows).toBe(15);
		expect(setOption("searchRows", "0").ok).toBe(false);
		expect(setOption("searchRows", "51").ok).toBe(false);
	});

	it("rejects an unknown key", () => {
		const r = setOption("nonsense", "1");
		expect(r.ok).toBe(false);
		expect(r.message).toContain("Unknown option");
	});

	it("requires key + value + no extra args in the set subcommand path", () => {
		// setOption itself just takes (key, value); the arg-count guard lives in
		// the command handler (covered in commands.test.ts). Here we only assert
		// the validator is stateless and does not mutate config on failure.
		const before = { ...config };
		setOption("maxEntries", "bad");
		expect(config).toEqual(before);
	});
});

describe("parseBool", () => {
	it("accepts on/true/1/yes (case-insensitive) as true", () => {
		for (const v of ["on", "true", "1", "yes", "ON", "Yes"]) {
			expect(parseBool(v)).toBe(true);
		}
	});
	it("accepts off/false/0/no (case-insensitive) as false", () => {
		for (const v of ["off", "false", "0", "no", "OFF", "No"]) {
			expect(parseBool(v)).toBe(false);
		}
	});
	it("returns undefined for anything else", () => {
		expect(parseBool("maybe")).toBeUndefined();
		expect(parseBool("")).toBeUndefined();
		expect(parseBool("2")).toBeUndefined();
	});
});

describe("onOff", () => {
	it("maps boolean to on/off strings", () => {
		expect(onOff(true)).toBe("on");
		expect(onOff(false)).toBe("off");
	});
});

describe("statusText", () => {
	it("renders all config lines, counts, and the file path", () => {
		config.maxEntries = 5;
		config.scope = "project";
		const txt = statusText("/some/cwd");
		expect(txt).toContain("Prompt history");
		expect(txt).toContain("enabled:          on");
		expect(txt).toContain("maxEntries:       5");
		expect(txt).toContain("scope:            project");
		expect(txt).toContain("entries (live):   0");
		expect(txt).toContain("entries (disk):   0");
		// project scope → file under prompt-histories with the cwd hash
		expect(txt).toContain("prompt-histories");
		expect(txt).toContain("-"); // sanitized-hash separator
	});

	it("uses the global file path when scope is global", () => {
		config.scope = "global";
		expect(statusText("/x")).toContain("prompt-history.json");
		expect(TEST_HOME).toBeTruthy();
	});
});
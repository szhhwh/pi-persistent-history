/**
 * Test harness for pi-persistent-history.
 *
 * Sets PI_HISTORY_HOME to an isolated temp dir BEFORE any test file imports
 * index.ts. index.ts derives all storage paths from this env var at module
 * load, so tests are fully hermetic — the real ~/.pi/agent is never touched.
 *
 * IMPORTANT: this module is a `bun test` preload (see bunfig.toml). It MUST NOT
 * statically `import`/`export *` from ../index.ts: a static import is hoisted
 * and would evaluate index.ts BEFORE this module's body runs (before the env is
 * set), silently falling back to the real ~/.pi/agent. Test files import the
 * module under test directly from "../index.ts"; the preload runs first, so by
 * the time a test file's static imports resolve, the env is already set.
 *
 * Import utilities here:
 *   import { TEST_HOME, cleanHome, makeCtx, setOldMtime, exists } from "./helpers.ts";
 * And import the module under test directly:
 *   import { __internals, config, __resetConfig } from "../index.ts";
 */
import { mkdtempSync, rmSync, readdirSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One temp home for the whole test run. index.ts reads this at import.
export const TEST_HOME = mkdtempSync(join(tmpdir(), "pi-history-test-"));
process.env.PI_HISTORY_HOME = TEST_HOME;

/** Remove every file/dir inside TEST_HOME (keeps the root). Call in beforeEach. */
export function cleanHome(): void {
	for (const entry of readdirSync(TEST_HOME)) {
		rmSync(join(TEST_HOME, entry), { recursive: true, force: true });
	}
}

/** Set a file's mtime/atime into the past by ageMs (for lock age-staleness tests). */
export function setOldMtime(file: string, ageMs: number): void {
	const d = new Date(Date.now() - ageMs);
	utimesSync(file, d, d);
}

/** Is the given path present on disk? */
export function exists(file: string): boolean {
	try {
		statSync(file);
		return true;
	} catch {
		return false;
	}
}

// Remove the whole temp home when the process exits.
process.on("exit", () => {
	try {
		rmSync(TEST_HOME, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

/** A minimal mock ExtensionCommandContext for /history command tests. */
export interface MockCtx {
	mode: string;
	hasUI: boolean;
	cwd: string;
	ui: {
		notify: (text: string, level: string) => void;
		confirm: (title: string, message: string) => Promise<boolean>;
		select: (title: string, options: string[]) => Promise<string | undefined>;
		setEditorText: (text: string) => void;
		getEditorComponent: () => unknown;
		onTerminalInput: (cb: (data: string) => unknown) => () => void;
	};
	_notifications: Array<{ text: string; level: string }>;
	_selected?: string;
	_confirmResult?: boolean;
}

/** Build a mock ctx; override any field. Captures notify() calls in _notifications. */
export function makeCtx(overrides: Partial<MockCtx> = {}): MockCtx {
	const notifications: Array<{ text: string; level: string }> = [];
	const confirmResult = overrides._confirmResult ?? true;
	const selected = overrides._selected;
	const ctx: MockCtx = {
		mode: "non-tui",
		hasUI: false,
		cwd: "/test-cwd",
		ui: {
			notify: (text: string, level: string) => notifications.push({ text, level }),
			confirm: async () => confirmResult,
			select: async (_title: string, options: string[]) =>
				selected !== undefined ? selected : options[0],
			setEditorText: () => {},
			getEditorComponent: () => null,
			onTerminalInput: () => () => {},
		},
		_notifications: notifications,
		...overrides,
	};
	return ctx;
}
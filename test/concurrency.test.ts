import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { __internals, __resetConfig } from "../index.ts";
import { cleanHome, TEST_HOME, setOldMtime, exists } from "./helpers.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GLOBAL_HISTORY_FILE, lockFileFor, loadEntries, LOCK_STALE_AGE_MS } = __internals;

// ---------------------------------------------------------------------------
// Shared worker script
//
// Each child process imports the repo's index.ts fresh (by absolute path so
// resolution works regardless of cwd), then loops M times calling
// persistEntries on the SAME global history file.  PI_HISTORY_HOME is set
// via env to TEST_HOME so every child shares the parent's isolated temp home.
// ---------------------------------------------------------------------------

const workerDir = mkdtempSync(join(tmpdir(), "pi-conc-worker-"));
const workerScript = join(workerDir, "worker.ts");

beforeAll(() => {
	const indexPath = join(import.meta.dir, "..", "index.ts");
	const code = [
		`import { __internals } from ${JSON.stringify(indexPath)};`,
		`const file = __internals.GLOBAL_HISTORY_FILE;`,
		`const id = process.env.PI_WORKER_ID ?? "X";`,
		`const M = Number(process.env.PI_WORKER_M ?? "1");`,
		`for (let i = 0; i < M; i++) {`,
		`  __internals.persistEntries(file, [id + "-" + i]);`,
		`}`,
	].join("\n");
	writeFileSync(workerScript, code);
});

afterAll(() => {
	try {
		rmSync(workerDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

beforeEach(() => {
	cleanHome();
	__resetConfig();
});

/** Spawn a worker that calls persistEntries M times with entries `<id>-<i>`. */
async function spawnWorker(id: string, M: number): Promise<number> {
	const proc = Bun.spawn({
		cmd: ["bun", workerScript],
		env: {
			...process.env,
			PI_HISTORY_HOME: TEST_HOME,
			PI_WORKER_ID: id,
			PI_WORKER_M: String(M),
		},
		stdout: "ignore",
		stderr: "inherit",
	});
	return await proc.exited;
}

describe("cross-process concurrency", () => {
	it("preserves all entries under concurrent writes (WITH lock)", async () => {
		const K = 3;
		const M = 25;
		const ids = ["A", "B", "C"];
		const exits = await Promise.all(ids.map((id) => spawnWorker(id, M)));
		expect(exits.every((e) => e === 0)).toBe(true);

		const entries = loadEntries(GLOBAL_HISTORY_FILE);
		const unique = new Set(entries);
		expect(unique.size).toBe(K * M); // 75 unique entries, no loss

		// Verify every expected entry is present.
		for (const id of ids) {
			for (let i = 0; i < M; i++) {
				expect(unique.has(`${id}-${i}`)).toBe(true);
			}
		}
	});

	it("reclaims a dead-owner lock and writes without stall", async () => {
		const lockFile = lockFileFor(GLOBAL_HISTORY_FILE);
		writeFileSync(lockFile, "999999", { mode: 0o600 });
		expect(exists(lockFile)).toBe(true);

		const exit = await spawnWorker("A", 5);
		expect(exit).toBe(0);

		const entries = loadEntries(GLOBAL_HISTORY_FILE);
		expect(new Set(entries).size).toBe(5);
		expect(exists(lockFile)).toBe(false);
	});

	it("reclaims a wedged (old + live-pid) lock by age", async () => {
		const lockFile = lockFileFor(GLOBAL_HISTORY_FILE);
		writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
		// Set mtime well past the staleness threshold (LOCK_STALE_AGE_MS + 10s).
		setOldMtime(lockFile, LOCK_STALE_AGE_MS + 10_000);
		expect(exists(lockFile)).toBe(true);

		const exit = await spawnWorker("A", 5);
		expect(exit).toBe(0);

		const entries = loadEntries(GLOBAL_HISTORY_FILE);
		expect(new Set(entries).size).toBe(5);
		expect(exists(lockFile)).toBe(false);
	});

	it("releases the lock after a normal write", async () => {
		const lockFile = lockFileFor(GLOBAL_HISTORY_FILE);
		expect(exists(lockFile)).toBe(false);

		const exit = await spawnWorker("A", 3);
		expect(exit).toBe(0);

		const entries = loadEntries(GLOBAL_HISTORY_FILE);
		expect(new Set(entries).size).toBe(3);
		expect(exists(lockFile)).toBe(false);
	});
});
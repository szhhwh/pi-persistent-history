import { describe, it, expect, beforeEach } from "bun:test";
import { __internals, __resetConfig, config } from "../index.ts";
import { cleanHome, setOldMtime, exists, TEST_HOME } from "./helpers.ts";
import { writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const {
	LOCK_STALE_AGE_MS,
	LOCK_RETRY_MAX,
	LOCK_RETRY_BACKOFF_MS,
	GLOBAL_HISTORY_FILE,
	PROJECT_HISTORY_DIR,
	isPidAlive,
	isLockStale,
	lockFileFor,
	acquireHistoryLock,
	releaseHistoryLock,
	reclaimStaleLock,
	sweepStaleLocks,
	sweepStaleTmp,
	loadEntries,
	persistEntries,
} = __internals;

beforeEach(() => {
	cleanHome();
	__resetConfig();
});

describe("lock constants", () => {
	it("exposes the documented tuning values", () => {
		expect(LOCK_STALE_AGE_MS).toBe(10_000);
		expect(LOCK_RETRY_MAX).toBe(60);
		expect(LOCK_RETRY_BACKOFF_MS).toBe(5);
	});
});

describe("isPidAlive", () => {
	it("returns true for the running current process pid", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("returns false for a dead / unused pid (ESRCH)", () => {
		// A very high pid that no OS will ever allocate → process.kill ESRCH.
		expect(isPidAlive(999_999)).toBe(false);
	});
});

describe("lockFileFor", () => {
	it("appends .lock to the history file path", () => {
		const f = join(TEST_HOME, "prompt-history.json");
		expect(lockFileFor(f)).toBe(`${f}.lock`);
	});

	it("works for project-scoped files too", () => {
		const f = join(PROJECT_HISTORY_DIR, "myproj-abcdef012345.json");
		expect(lockFileFor(f)).toBe(`${f}.lock`);
	});
});

describe("isLockStale", () => {
	it("treats undefined ownerPid as stale (corrupt)", () => {
		const f = join(TEST_HOME, "x.lock");
		writeFileSync(f, "whatever");
		expect(isLockStale(f, undefined)).toBe(true);
	});

	it("treats NaN ownerPid as stale (corrupt)", () => {
		const f = join(TEST_HOME, "x.lock");
		writeFileSync(f, "not-a-number");
		expect(isLockStale(f, Number.NaN)).toBe(true);
	});

	it("treats a dead ownerPid as stale", () => {
		const f = join(TEST_HOME, "x.lock");
		writeFileSync(f, "999999");
		expect(isLockStale(f, 999_999)).toBe(true);
	});

	it("returns false for a live ownerPid with a fresh mtime (age <= 10s)", () => {
		const f = join(TEST_HOME, "x.lock");
		writeFileSync(f, String(process.pid));
		setOldMtime(f, 1000); // 1s old → well within the 10s threshold
		expect(isLockStale(f, process.pid)).toBe(false);
	});

	it("returns true for a live ownerPid with an old mtime (age > 10s, wedge/PID-reuse)", () => {
		const f = join(TEST_HOME, "x.lock");
		writeFileSync(f, String(process.pid));
		setOldMtime(f, 11_000); // 11s old → past the 10s threshold
		expect(isLockStale(f, process.pid)).toBe(true);
	});

	it("returns true when the lock file is missing (unreadable)", () => {
		expect(isLockStale(join(TEST_HOME, "does-not-exist.lock"), process.pid)).toBe(true);
	});
});

describe("acquireHistoryLock", () => {
	it("creates a .lock file containing String(process.pid) with mode 0600 on a clean dir", () => {
		const hist = join(TEST_HOME, "prompt-history.json");
		const lock = lockFileFor(hist);
		expect(exists(lock)).toBe(false);
		acquireHistoryLock(hist);
		expect(exists(lock)).toBe(true);
		expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
		const mode = statSync(lock).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("releaseHistoryLock removes the lock when it holds our pid", () => {
		const hist = join(TEST_HOME, "prompt-history.json");
		const lock = lockFileFor(hist);
		acquireHistoryLock(hist);
		expect(exists(lock)).toBe(true);
		releaseHistoryLock(hist);
		expect(exists(lock)).toBe(false);
	});

	it("can re-acquire after release", () => {
		const hist = join(TEST_HOME, "prompt-history.json");
		const lock = lockFileFor(hist);
		acquireHistoryLock(hist);
		releaseHistoryLock(hist);
		expect(exists(lock)).toBe(false);
		acquireHistoryLock(hist);
		expect(exists(lock)).toBe(true);
		expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
		releaseHistoryLock(hist);
	});
});

describe("releaseHistoryLock", () => {
	it("does NOT unlink when the lock holds a different pid", () => {
		const hist = join(TEST_HOME, "prompt-history.json");
		const lock = lockFileFor(hist);
		writeFileSync(lock, "999999", { mode: 0o600 });
		releaseHistoryLock(hist);
		expect(exists(lock)).toBe(true);
		expect(readFileSync(lock, "utf8")).toBe("999999");
	});

	it("does not throw when the lock file is missing", () => {
		const hist = join(TEST_HOME, "prompt-history.json");
		expect(() => releaseHistoryLock(hist)).not.toThrow();
	});
});

describe("reclaimStaleLock", () => {
	it("reclaims a stale lock (dead owner pid)", () => {
		const f = join(TEST_HOME, "stale.lock");
		writeFileSync(f, "999999", { mode: 0o600 });
		expect(exists(f)).toBe(true);
		reclaimStaleLock(f);
		expect(exists(f)).toBe(false);
	});

	it("leaves a non-stale lock (live owner, fresh mtime)", () => {
		const f = join(TEST_HOME, "live.lock");
		writeFileSync(f, String(process.pid), { mode: 0o600 });
		setOldMtime(f, 1000);
		reclaimStaleLock(f);
		expect(exists(f)).toBe(true);
	});

	it("reclaims a corrupt/unreadable lock", () => {
		const f = join(TEST_HOME, "corrupt.lock");
		// Write garbage so readFileSync fails to parse → ownerPid undefined → stale.
		writeFileSync(f, "\u0000\u0001", { mode: 0o600 });
		reclaimStaleLock(f);
		// parseInt("\u0000\u0001") → NaN → isInteger false → stale → removed
		expect(exists(f)).toBe(false);
	});
});

describe("sweepStaleLocks", () => {
	it("the global lock path lives under TEST_HOME (isolation)", () => {
		const globalLock = lockFileFor(GLOBAL_HISTORY_FILE);
		expect(globalLock.startsWith(TEST_HOME)).toBe(true);
	});

	it("sweeps a stale global lock (dead pid)", () => {
		const globalLock = lockFileFor(GLOBAL_HISTORY_FILE);
		writeFileSync(globalLock, "999999", { mode: 0o600 });
		sweepStaleLocks();
		expect(exists(globalLock)).toBe(false);
	});

	it("leaves a fresh+live global lock untouched", () => {
		const globalLock = lockFileFor(GLOBAL_HISTORY_FILE);
		writeFileSync(globalLock, String(process.pid), { mode: 0o600 });
		setOldMtime(globalLock, 1000);
		sweepStaleLocks();
		expect(exists(globalLock)).toBe(true);
	});

	it("sweeps a stale *.json.lock inside PROJECT_HISTORY_DIR", () => {
		mkdirSync(PROJECT_HISTORY_DIR, { recursive: true, mode: 0o700 });
		const stale = join(PROJECT_HISTORY_DIR, "proj-abcdef012345.json.lock");
		writeFileSync(stale, "999999", { mode: 0o600 });
		sweepStaleLocks();
		expect(exists(stale)).toBe(false);
	});

	it("leaves a fresh+live *.json.lock inside PROJECT_HISTORY_DIR untouched", () => {
		mkdirSync(PROJECT_HISTORY_DIR, { recursive: true, mode: 0o700 });
		const live = join(PROJECT_HISTORY_DIR, "proj-live.json.lock");
		writeFileSync(live, String(process.pid), { mode: 0o600 });
		setOldMtime(live, 1000);
		sweepStaleLocks();
		expect(exists(live)).toBe(true);
	});

	it("does NOT touch a foreign *.lock (non-.json.lock) in PROJECT_HISTORY_DIR", () => {
		mkdirSync(PROJECT_HISTORY_DIR, { recursive: true, mode: 0o700 });
		const foreign = join(PROJECT_HISTORY_DIR, "foreign.lock");
		writeFileSync(foreign, "999999", { mode: 0o600 });
		sweepStaleLocks();
		expect(exists(foreign)).toBe(true);
	});

	it("does NOT touch other.lock (non-.json.lock) in PROJECT_HISTORY_DIR", () => {
		mkdirSync(PROJECT_HISTORY_DIR, { recursive: true, mode: 0o700 });
		const other = join(PROJECT_HISTORY_DIR, "other.lock");
		writeFileSync(other, String(process.pid), { mode: 0o600 });
		sweepStaleLocks();
		expect(exists(other)).toBe(true);
	});

	it("does not throw when PROJECT_HISTORY_DIR does not exist", () => {
		expect(() => sweepStaleLocks()).not.toThrow();
	});
});

describe("sweepStaleTmp", () => {
	it("removes a tmp whose embedded pid is dead", () => {
		// Pattern: ^(.*)\.(\d+)\.[0-9a-f]+\.tmp$
		const dead = join(TEST_HOME, "prompt-history.json.999999.dead.tmp");
		writeFileSync(dead, "x", { mode: 0o600 });
		sweepStaleTmp();
		expect(exists(dead)).toBe(false);
	});

	it("keeps a tmp whose embedded pid is alive (process.pid)", () => {
		const alive = join(TEST_HOME, `prompt-history.json.${process.pid}.aabb.tmp`);
		writeFileSync(alive, "x", { mode: 0o600 });
		sweepStaleTmp();
		expect(exists(alive)).toBe(true);
	});

	it("keeps a non-matching file", () => {
		const nope = join(TEST_HOME, "random.tmp");
		writeFileSync(nope, "x", { mode: 0o600 });
		const nope2 = join(TEST_HOME, "notmp.txt");
		writeFileSync(nope2, "x", { mode: 0o600 });
		sweepStaleTmp();
		expect(exists(nope)).toBe(true);
		expect(exists(nope2)).toBe(true);
	});
});

describe("persistEntries", () => {
	it("early-returns when config.enabled=false: no lock, file unchanged", () => {
		config.enabled = false;
		const hist = join(TEST_HOME, "prompt-history.json");
		const lock = lockFileFor(hist);
		// Pre-seed the data file so we can prove it is untouched.
		writeFileSync(hist, JSON.stringify(["a"]), { mode: 0o600 });
		persistEntries(hist, ["b"]);
		expect(exists(lock)).toBe(false);
		expect(loadEntries(hist)).toEqual(["a"]);
	});

	it("writes merged entries under the lock and releases the lock afterward", () => {
		config.enabled = true;
		const hist = join(TEST_HOME, "prompt-history.json");
		const lock = lockFileFor(hist);
		persistEntries(hist, ["hello"]);
		expect(exists(lock)).toBe(false); // lock cleaned up
		expect(loadEntries(hist)).toContain("hello");
	});

	it("re-reads and merges disk content (newest first)", () => {
		config.enabled = true;
		const hist = join(TEST_HOME, "prompt-history.json");
		const lock = lockFileFor(hist);
		writeFileSync(hist, JSON.stringify(["a"]), { mode: 0o600 });
		persistEntries(hist, ["b"]);
		// Default dedup "consecutive": ["b", "a"] — b first (newest), a survives.
		expect(exists(lock)).toBe(false);
		expect(loadEntries(hist)).toEqual(["b", "a"]);
	});
});
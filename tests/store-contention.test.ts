/**
 * Write-contention tests.
 *
 * Covers the failure mode that produced:
 *
 *   [ai-radar] vercel-blob:news.json changed since it was read; rebasing 83 local change(s)
 *   [ai-radar] gave up persisting vercel-blob:news.json after 3 attempts of contention
 *
 * Three properties are asserted:
 *
 *   1. retries back off exponentially with jitter (not fixed-interval, not
 *      lockstep), and the budget is configurable;
 *   2. a change set that cannot be persisted is written to durable pending
 *      storage before the flush returns — never left in process memory only —
 *      and is merged back once the contention clears;
 *   3. N writers hitting the same document concurrently either get every change
 *      stored, or have it captured in that durable fallback.
 *
 * Run with: npm test  (node --import tsx --test tests)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  StorageConflictError,
  isScanLeaseActive,
  makeScanLeaseRecord,
  setStorageBackendForTesting,
  storageErrorMessage,
  type PendingWriteRecord,
  type ScanLeaseOptions,
  type ScanLeaseRecord,
  type ScanLeaseResult,
  type StorageBackend,
  type StoredDocument,
  type WriteOptions,
  type WriteResult,
} from "../src/lib/storage";
import { createLocalBackend } from "../src/lib/storage/local";
import { mergePendingDocument } from "../src/lib/storage/merge";
import {
  DEFAULT_WRITE_RETRY_POLICY,
  backoffDelayMs,
  ensureStoreLoaded,
  flush,
  getStoreStatus,
  mutate,
  resetStoreCache,
  writeRetryPolicy,
} from "../src/lib/store";
import { emptyDocument, makeArticle } from "./fixtures/article";

const TRACKED_ENV = [
  "DATA_DIR",
  "STORAGE_BACKEND",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_ACCESS",
  "BLOB_STORE_PATHNAME",
  "BLOB_STORE_ID",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "NODE_ENV",
  "SEED_ON_EMPTY",
  "STORE_WRITE_ATTEMPTS",
  "STORE_WRITE_BACKOFF_MS",
  "STORE_WRITE_BACKOFF_MAX_MS",
  "STORE_WRITE_DEADLINE_MS",
] as const;

const savedEnv = new Map<string, string | undefined>();
let dataDir = "";

beforeEach(() => {
  if (savedEnv.size === 0) {
    for (const key of TRACKED_ENV) savedEnv.set(key, process.env[key]);
  }
  for (const key of TRACKED_ENV) delete process.env[key];

  dataDir = mkdtempSync(path.join(tmpdir(), "ai-radar-contention-"));
  process.env.DATA_DIR = dataDir;
  process.env.SEED_ON_EMPTY = "false";

  resetStoreCache();
});

afterEach(() => {
  setStorageBackendForTesting(null);
  resetStoreCache();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* -------------------------------------------------------------------------- */
/*  A backend with deterministic contention                                    */
/* -------------------------------------------------------------------------- */

interface FakeBackend {
  backend: StorageBackend;
  /** The document currently stored (i.e. the primary key, never a pending one). */
  stored: () => string | null;
  /** Pending records, keyed by id. */
  pending: Map<string, PendingWriteRecord>;
  /** Let the rival stop writing so a later hydrate can recover. */
  rival: { active: boolean };
  /** Artificial delay of `writePending`, so a change can land mid-record. */
  pendingLatencyMs: number;
  /** Resolves once the next `writePending` call has started. */
  pendingWriteStarted: () => Promise<void>;
}

/**
 * In-memory stand-in for the Blob backend. `rival.active` makes another writer
 * land a write immediately before every attempt, which is exactly the race the
 * blob store cannot rule out (no compare-and-swap) — deterministic instead of
 * timing-dependent, so the give-up path is actually exercised.
 */
function createFakeBackend(initial: string | null, rivalActive = false): FakeBackend {
  let document = initial;
  let etag: string | null = initial === null ? null : "v1";
  let version = initial === null ? 0 : 1;
  const pending = new Map<string, PendingWriteRecord>();
  /** Scheduler lease state, mirroring what a real backend stores. */
  let lease: ScanLeaseRecord | null = null;
  const rival = { active: rivalActive };
  const controls = { pendingLatencyMs: 0 };
  let signalStarted: (() => void) | null = null;

  const meta = () => ({
    etag: etag as string,
    size: document?.length ?? 0,
    updatedAt: new Date().toISOString(),
  });

  /** Another writer commits: content and version token both move on. */
  const rivalWrite = () => {
    if (document === null) return;
    const parsed = JSON.parse(document) as { meta?: Record<string, unknown> };
    parsed.meta = { ...(parsed.meta ?? {}), rivalTicks: Number(parsed.meta?.rivalTicks ?? 0) + 1 };
    version += 1;
    etag = `v${version}`;
    document = JSON.stringify(parsed);
  };

  return {
    rival,
    pending,
    stored: () => document,
    get pendingLatencyMs() {
      return controls.pendingLatencyMs;
    },
    set pendingLatencyMs(value: number) {
      controls.pendingLatencyMs = value;
    },
    pendingWriteStarted: () =>
      new Promise<void>((resolve) => {
        signalStarted = resolve;
      }),
    backend: {
      kind: "blob",
      label: "fake-blob:news.json",

      async read(): Promise<StoredDocument | null> {
        if (document === null) return null;
        return { meta: meta(), json: document };
      },

      async stat() {
        if (document === null) return null;
        return meta();
      },

      async write(json: string, { expectedEtag }: WriteOptions): Promise<WriteResult> {
        if (rival.active) rivalWrite();
        if (expectedEtag !== etag) {
          throw new StorageConflictError("fake-blob:news.json changed since it was read", "blob");
        }
        version += 1;
        etag = `v${version}`;
        document = json;
        return { meta: meta() };
      },

      async quarantine(): Promise<string | null> {
        return null;
      },

      async writePending(record: PendingWriteRecord): Promise<string> {
        const started = signalStarted;
        signalStarted = null;
        started?.();
        if (controls.pendingLatencyMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, controls.pendingLatencyMs));
        }
        pending.set(record.id, record);
        return `news.pending-${record.id}.json`;
      },

      async listPending(): Promise<PendingWriteRecord[]> {
        return [...pending.values()].sort((a, b) => b.id.localeCompare(a.id));
      },

      async resolvePending(id: string): Promise<boolean> {
        return pending.delete(id);
      },

      async acquireScanLease({ holder, ttlMs, now = Date.now() }: ScanLeaseOptions): Promise<ScanLeaseResult> {
        if (lease && lease.holder !== holder && isScanLeaseActive(lease, now)) {
          return { acquired: false, record: lease, reason: `held by ${lease.holder} until ${lease.expiresAt}` };
        }
        lease = makeScanLeaseRecord(holder, ttlMs, now);
        return { acquired: true, record: lease, reason: null };
      },

      async releaseScanLease({ holder }: { holder: string }): Promise<boolean> {
        if (!lease || lease.holder !== holder) return false;
        lease = null;
        return true;
      },

      describe() {
        return { kind: "blob", label: "fake-blob:news.json", pendingRecords: pending.size };
      },
    },
  };
}

/** Install the fake backend and hydrate a fresh store state against it. */
async function activate(fake: FakeBackend): Promise<void> {
  setStorageBackendForTesting(fake.backend);
  resetStoreCache();
  await ensureStoreLoaded();
}

/** Keep the tests fast: short retry budget, no long sleeps. */
function useFastRetryPolicy(attempts = 3): void {
  process.env.STORE_WRITE_ATTEMPTS = String(attempts);
  process.env.STORE_WRITE_BACKOFF_MS = "1";
  process.env.STORE_WRITE_BACKOFF_MAX_MS = "2";
  process.env.STORE_WRITE_DEADLINE_MS = "250";
}

/* -------------------------------------------------------------------------- */
/*  Retry policy                                                               */
/* -------------------------------------------------------------------------- */

describe("write retry policy", () => {
  test("retries back off exponentially and are bounded by the max delay", () => {
    const policy = { attempts: 8, baseDelayMs: 100, maxDelayMs: 800, deadlineMs: 10_000 };
    // random() = 0 returns the lower bound of the jitter window: half the window.
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelayMs(attempt, policy, () => 0)),
      [50, 100, 200, 400, 400, 400],
    );
    // random() = 1 returns the upper bound: the full window, still capped.
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelayMs(attempt, policy, () => 1)),
      [100, 200, 400, 800, 800, 800],
    );
  });

  test("jitter keeps two writers out of lockstep", () => {
    const policy = { attempts: 5, baseDelayMs: 200, maxDelayMs: 2_000, deadlineMs: 5_000 };
    // Two writers rolling a different dice must not wait the same time.
    const first = backoffDelayMs(2, policy, () => 0);
    const second = backoffDelayMs(2, policy, () => 0.999);
    assert.ok(second > first, `${second} should exceed ${first}`);
    assert.ok(first >= policy.baseDelayMs / 2 && second <= policy.baseDelayMs * 2);
  });

  test("a zero base delay means no waiting (opt-out for tests)", () => {
    assert.equal(backoffDelayMs(3, { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, deadlineMs: 0 }), 0);
  });

  test("attempts and delays are configurable, with sane fallbacks", () => {
    delete process.env.STORE_WRITE_ATTEMPTS;
    delete process.env.STORE_WRITE_BACKOFF_MS;
    assert.deepEqual(writeRetryPolicy(), DEFAULT_WRITE_RETRY_POLICY);

    process.env.STORE_WRITE_ATTEMPTS = "9";
    process.env.STORE_WRITE_BACKOFF_MS = "25";
    process.env.STORE_WRITE_BACKOFF_MAX_MS = "250";
    process.env.STORE_WRITE_DEADLINE_MS = "900";
    assert.deepEqual(writeRetryPolicy(), {
      attempts: 9,
      baseDelayMs: 25,
      maxDelayMs: 250,
      deadlineMs: 900,
    });

    // Garbage and an inverted max delay cannot break the loop.
    process.env.STORE_WRITE_ATTEMPTS = "nope";
    process.env.STORE_WRITE_BACKOFF_MS = "100";
    process.env.STORE_WRITE_BACKOFF_MAX_MS = "10";
    const policy = writeRetryPolicy();
    assert.equal(policy.attempts, DEFAULT_WRITE_RETRY_POLICY.attempts);
    assert.equal(policy.baseDelayMs, 100);
    assert.equal(policy.maxDelayMs, 100);
  });
});

/* -------------------------------------------------------------------------- */
/*  Recovery merge                                                             */
/* -------------------------------------------------------------------------- */

describe("pending change set merge", () => {
  test("keeps another writer's additions and applies the recovered changes", () => {
    const base = JSON.stringify({ articles: [{ id: "a" }], meta: { scans: 1 } });
    const local = JSON.stringify({ articles: [{ id: "a" }, { id: "b" }], meta: { scans: 2 } });
    const remote = JSON.stringify({ articles: [{ id: "a" }, { id: "c" }], meta: { scans: 9 } });

    const merged = JSON.parse(mergePendingDocument(base, local, remote) as string);
    assert.deepEqual(
      merged.articles.map((article: { id: string }) => article.id),
      ["a", "b", "c"],
    );
    // Both sides changed the counter: the recovered change set wins (it is the
    // change the user made; dropping it is the bug being fixed).
    assert.equal(merged.meta.scans, 2);
  });

  test("respects deletions on both sides", () => {
    const base = JSON.stringify({ items: [{ id: "keep" }, { id: "gone-remotely" }, { id: "gone-locally" }] });
    const local = JSON.stringify({ items: [{ id: "keep" }, { id: "gone-remotely" }] });
    const remote = JSON.stringify({ items: [{ id: "keep" }, { id: "gone-locally" }, { id: "added" }] });

    const merged = JSON.parse(mergePendingDocument(base, local, remote) as string);
    assert.deepEqual(
      merged.items.map((item: { id: string }) => item.id),
      ["keep", "added"],
    );
  });

  test("recreates the document when it was removed, and refuses unreadable payloads", () => {
    const local = JSON.stringify({ articles: [], meta: { scans: 3 } });
    assert.equal(mergePendingDocument(null, local, null), local);
    assert.equal(mergePendingDocument(null, "{not json", "{}"), null);
  });
});

/* -------------------------------------------------------------------------- */
/*  Give-up: durable fallback                                                  */
/* -------------------------------------------------------------------------- */

describe("durable fallback when retries are exhausted", () => {
  test("a change set that loses every race is persisted before the flush returns", async () => {
    useFastRetryPolicy(3);
    const fake = createFakeBackend(JSON.stringify(emptyDocument()), true);
    await activate(fake);

    mutate((db) => {
      db.settings.scanIntervalMinutes = 42;
    });
    await flush();

    // Still pending in memory, so the next flush can retry it ...
    const status = getStoreStatus();
    assert.equal(status.dirty, true);
    assert.equal(status.pendingWrites, 1);

    // ... but not *only* in memory: the change set is durable.
    assert.equal(fake.pending.size, 1);
    const record = [...fake.pending.values()][0];
    assert.equal(record.changes, 1);
    assert.equal(record.label, "fake-blob:news.json");
    assert.match(record.reason, /contention/);
    assert.ok(record.base, "the base document is kept so the change set can be merged later");
    assert.equal(JSON.parse(record.document).settings.scanIntervalMinutes, 42);

    // The failure is loud: metrics plus a status error an operator can see.
    assert.match(status.lastError ?? "", /could not persist 1 change\(s\).*kept durably at news\.pending-/);
    assert.equal(status.contention.giveUps, 1);
    assert.equal(status.contention.fallbacksWritten, 1);
    assert.equal(status.contention.writes, 0);
    assert.ok(status.contention.contentionRetries >= 2, "retries were counted, not hidden");
    assert.ok(status.contention.maxAttemptsUsed >= 3);

    // The fallback never touches the primary document key.
    assert.notEqual(JSON.parse(fake.stored() as string).settings.scanIntervalMinutes, 42);
  });

  test("does not treat a change set someone else stored as covering newer local changes", async () => {
    useFastRetryPolicy(2);
    const fake = createFakeBackend(JSON.stringify(emptyDocument()), true);
    await activate(fake);

    // First change loses every race -> a durable record with one change.
    mutate((db) => {
      db.meta.lastScanTrigger = "manual";
    });
    await flush();
    const record = [...fake.pending.values()][0];
    assert.equal(record.changes, 1);

    // Another instance recovered that record and stored it verbatim (this is
    // what a recovery write looks like from here). It succeeds, so the rivalry
    // stops for the rest of the test.
    fake.rival.active = false;
    const etag = (await fake.backend.stat())?.etag as string;
    await fake.backend.write(record.document, { expectedEtag: etag });

    // A second change arrives afterwards; the stored document does not have it.
    mutate((db) => {
      db.settings.scanIntervalMinutes = 42;
    });
    await flush();

    const stored = JSON.parse(fake.stored() as string);
    assert.equal(stored.meta.lastScanTrigger, "manual", "the already-stored change is kept as it is");
    assert.equal(stored.settings.scanIntervalMinutes, 42, "the newer change must not be dropped");
    assert.equal(fake.pending.size, 0, "the record is cleared once everything pending is stored");
    assert.equal(getStoreStatus().dirty, false);
    assert.equal(getStoreStatus().pendingWrites, 0);
  });

  test("a change that arrives while the record is written is covered by it too", async () => {
    useFastRetryPolicy(1);
    const fake = createFakeBackend(JSON.stringify(emptyDocument()), true);
    // Blob needs a network round trip to store a record, so a change can land
    // while the record is in flight.
    fake.pendingLatencyMs = 25;
    await activate(fake);

    mutate((db) => {
      db.meta.lastScanTrigger = "manual";
    });

    const pendingWrite = fake.pendingWriteStarted();
    const inFlight = flush();
    await pendingWrite; // the record is on its way
    mutate((db) => {
      db.settings.scanIntervalMinutes = 42;
    });
    await inFlight;

    const record = [...fake.pending.values()][0];
    assert.equal(record.changes, 2, "the record covers the change that arrived mid-write");
    assert.equal(JSON.parse(record.document).settings.scanIntervalMinutes, 42);
    assert.equal(fake.pending.size, 1, "the record is refreshed in place, not duplicated");
  });

  test("repeated give-ups refresh one record instead of piling up", async () => {
    useFastRetryPolicy(2);
    const fake = createFakeBackend(JSON.stringify(emptyDocument()), true);
    await activate(fake);

    mutate((db) => {
      db.meta.lastScanTrigger = "manual";
    });
    await flush();
    const firstId = [...fake.pending.keys()][0];

    await flush();
    await flush();

    assert.equal(fake.pending.size, 1, "one record per process, not one per failed flush");
    assert.equal([...fake.pending.keys()][0], firstId);
    assert.equal(getStoreStatus().contention.fallbacksWritten, 3);
    assert.equal(getStoreStatus().contention.giveUps, 3);
  });
});

/* -------------------------------------------------------------------------- */
/*  Recovery                                                                   */
/* -------------------------------------------------------------------------- */

describe("recovering a durable change set", () => {
  test("merged back into the document once the contention clears, then cleared", async () => {
    useFastRetryPolicy(2);
    const fake = createFakeBackend(JSON.stringify(emptyDocument()), true);
    await activate(fake);

    mutate((db) => {
      db.settings.scanIntervalMinutes = 42;
      db.meta.lastScanTrigger = "manual";
    });
    await flush();
    assert.equal(fake.pending.size, 1, "the change set did not make it into the document");
    const rivalTicks = JSON.parse(fake.stored() as string).meta.rivalTicks as number;

    // The rival stops writing and the instance is recycled: nothing is left in
    // process memory (this is the data-loss scenario).
    fake.rival.active = false;
    resetStoreCache();

    await ensureStoreLoaded(); // hydrate merges the record back in
    assert.equal(getStoreStatus().contention.pendingFallbacks, 1);
    await flush(); // ... and the next flush stores it

    const stored = JSON.parse(fake.stored() as string);
    assert.equal(stored.settings.scanIntervalMinutes, 42);
    assert.equal(stored.meta.lastScanTrigger, "manual");
    assert.ok(stored.meta.rivalTicks >= rivalTicks, "the other writer's changes survived the merge");
    assert.equal(fake.pending.size, 0, "the record is cleared once its changes are stored");
    assert.equal(getStoreStatus().contention.fallbacksRecovered, 1);
    assert.equal(getStoreStatus().dirty, false);
    assert.equal(getStoreStatus().lastError, null);
  });

  test("keeps what another writer published after the give-up", async () => {
    useFastRetryPolicy(2);
    const fake = createFakeBackend(JSON.stringify(emptyDocument()), true);
    await activate(fake);

    mutate((db) => {
      db.settings.scanIntervalMinutes = 42;
    });
    await flush();
    fake.rival.active = false;

    // Another instance publishes while this one is gone.
    const movedOn = JSON.parse(fake.stored() as string);
    movedOn.articles.push(makeArticle({ id: "other-1", title: "Another instance published this", sourceId: "other" }));
    const etag = (await fake.backend.stat())?.etag as string;
    await fake.backend.write(JSON.stringify(movedOn), { expectedEtag: etag });

    resetStoreCache();
    await ensureStoreLoaded();
    await flush();

    const stored = JSON.parse(fake.stored() as string);
    assert.equal(stored.settings.scanIntervalMinutes, 42, "the recovered change is applied");
    assert.ok(
      stored.articles.some((article: { id: string }) => article.id === "other-1"),
      "the other writer's article is not clobbered",
    );
    assert.equal(fake.pending.size, 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  N concurrent writers against the same document                             */
/* -------------------------------------------------------------------------- */

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a fixture as its own process — a stand-in for another instance/CLI run. */
function runChildProcess(
  file: string,
  args: string[],
  timeoutMs: number,
  onExit?: () => void,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", file, ...args], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (result: ChildResult) => {
      clearTimeout(timer);
      onExit?.();
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish({ code: -1, stdout, stderr: `${stderr}${storageErrorMessage(error)}` }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

/**
 * The test process doubles as a rival writer for as long as the spawned writers
 * are alive: it keeps bumping the stored document so every writer's
 * stat-then-write window is contended. Without it the writers can end up
 * perfectly serialised on a loaded machine, and the test would silently stop
 * testing contention at all.
 */
async function runRivalWriter(dir: string, isBusy: () => boolean): Promise<number> {
  const backend = createLocalBackend({ dir, fileName: "db.json" });
  let writes = 0;
  while (isBusy()) {
    const document = await backend.read();
    if (document) {
      const parsed = JSON.parse(document.json) as { meta?: Record<string, unknown> };
      parsed.meta = { ...(parsed.meta ?? {}), rivalTicks: Number(parsed.meta?.rivalTicks ?? 0) + 1 };
      try {
        await backend.write(JSON.stringify(parsed), { expectedEtag: document.meta.etag });
        writes += 1;
      } catch {
        // Lost a race to a writer — expected, and itself contention.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return writes;
}

/** Last JSON line a fixture printed. */
function lastReport(result: ChildResult): Record<string, number | boolean> {
  const line = result.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as Record<string, number | boolean>;
}

describe("N concurrent writers on one document", () => {
  test("every change is stored or captured in the durable fallback — never silently dropped", async () => {
    const writers = 3;
    const changesPerWriter = 5;
    writeFileSync(path.join(dataDir, "db.json"), JSON.stringify(emptyDocument()), "utf8");

    const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    const writerFile = path.join(fixtures, "concurrent-writer.ts");

    // Three separate processes — the serverless equivalent of three instances,
    // a CLI scan and a request all writing the same key at the same time — plus
    // this process as a rival writer for as long as they run.
    let alive = writers;
    const writerRuns = Array.from({ length: writers }, (_, index) =>
      runChildProcess(writerFile, [dataDir, String(index), String(changesPerWriter)], 30_000, () => {
        alive -= 1;
      }),
    );
    const [rivalWrites, ...results] = await Promise.all([runRivalWriter(dataDir, () => alive > 0), ...writerRuns]);

    for (const [index, result] of results.entries()) {
      assert.equal(result.code, 0, `writer ${index} failed (${result.stderr})`);
    }
    assert.ok(rivalWrites > 0, "the rival writer should have committed writes of its own");

    const reports = results.map(lastReport);
    // The contention machinery was exercised, not merely present: with widened
    // race windows at least one writer must have lost a conditional write.
    const lostRaces = reports.reduce((total, report) => total + Number(report.contended), 0);
    const giveUps = reports.reduce((total, report) => total + Number(report.giveUps), 0);
    assert.ok(lostRaces + giveUps > 0, "expected at least one writer to lose a conditional write");

    // A writer may only end "dirty" (changes still unflushed) if those changes
    // are already durable — that is the whole point of the fallback.
    for (const report of reports) {
      assert.ok(
        !report.dirty || Number(report.fallbacksWritten) > 0,
        `writer ${Number(report.index)} ended with ${Number(report.pendingWrites)} change(s) that exist only in process memory`,
      );
    }

    // Every change is either in the document or inside a durable record.
    const durable = new Set<string>(
      (JSON.parse(readFileSync(path.join(dataDir, "db.json"), "utf8")).articles as { id: string }[]).map(
        (article) => article.id,
      ),
    );
    const pendingFiles = readdirSync(dataDir).filter((name) => name.startsWith("db.json.pending-"));
    for (const name of pendingFiles) {
      const record = JSON.parse(readFileSync(path.join(dataDir, name), "utf8")) as { document: string };
      for (const article of JSON.parse(record.document).articles as { id: string }[]) durable.add(article.id);
    }

    for (let index = 0; index < writers; index += 1) {
      for (let change = 0; change < changesPerWriter; change += 1) {
        const id = `writer-${index}-${change}`;
        assert.ok(
          durable.has(id),
          `change ${id} was dropped.\n` +
            `writers: ${JSON.stringify(reports)}\n` +
            `rivalWrites: ${rivalWrites}\n` +
            `pending records: ${pendingFiles.join(", ") || "none"}\n` +
            `durable ids: ${[...durable].sort().join(", ")}`,
        );
      }
    }
  });
});

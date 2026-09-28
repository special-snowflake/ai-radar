import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyArticle } from "./classify";
import { reconcileSources } from "./sources";
import {
  DB_FILE_NAME,
  StorageConflictError,
  dataDirectory,
  describeStorage,
  mergePendingDocument,
  resolveStorageBackend,
  type PendingWriteRecord,
  type StorageBackend,
  type StorageBackendKind,
  type StoredDocument,
} from "./storage";
import type { LocalStorageBackend } from "./storage/local";
import { hashId, slugify, titleSimilarity, unique } from "./text";
import type {
  AlertEvent,
  AlertRule,
  Article,
  RadarDatabase,
  RadarSettings,
  ScanRun,
  Source,
  SourceInput,
} from "./types";
import { isCategoryId } from "./types";

/**
 * Durable JSON store.
 *
 * One JSON document, one in-memory copy per server process, debounced writes.
 * Articles are the only large collection and they are capped + pruned, which
 * keeps the whole dataset in the low single-digit megabytes even after months of
 * polling dozens of feeds.
 *
 * Persistence itself is delegated to a storage backend (see `./storage`):
 *
 *   - local development (`npm run dev`):    `data/db.json`   (synchronous read)
 *   - Vercel / production:                  Vercel Blob -> `news.json`
 *
 * Server code that touches the store must `await ensureStoreLoaded()` once per
 * request first (the pages/route handlers and scanner do this); local
 * development hydrates synchronously, so nothing changed there.
 *
 * Write safety: writes are conditional on the version the process last read
 * (`etag`). If another writer moved the document on — a CLI scan next to the dev
 * server, or a second serverless instance — the pending in-memory changes are
 * replayed on top of the fresh document instead of overwriting it, so no edit is
 * silently lost.
 *
 * Contention (see `persist`): retries use exponential backoff with jitter, and
 * when the retry budget is exhausted the change set is written to a durable
 * pending record in the backend (a sibling `*.pending-*` key) before the call
 * returns. A serverless instance can be recycled at any moment, so a change set
 * must never exist only in process memory. `ensureStoreLoaded()` merges pending
 * records back in (three-way merge, see `./storage/merge`).
 */

export const STORE_VERSION = 1;
const WRITE_DEBOUNCE_MS = 350;

export const DEFAULT_INTERESTS: { keyword: string; weight: number }[] = [
  { keyword: "open weights", weight: 1.4 },
  { keyword: "frontier model", weight: 1.4 },
  { keyword: "reasoning", weight: 1.2 },
  { keyword: "ai agent", weight: 1.2 },
  { keyword: "open source", weight: 1.1 },
  { keyword: "inference cost", weight: 1.1 },
  { keyword: "benchmark", weight: 1 },
  { keyword: "gpu", weight: 1 },
  { keyword: "datacenter", weight: 1 },
  { keyword: "funding", weight: 0.9 },
  { keyword: "regulation", weight: 0.9 },
  { keyword: "safety", weight: 0.9 },
  { keyword: "robotics", weight: 0.9 },
  { keyword: "healthcare", weight: 0.8 },
];

export const DEFAULT_SETTINGS: RadarSettings = {
  scanIntervalMinutes: 20,
  scanConcurrency: 6,
  fetchTimeoutMs: 15_000,
  maxItemsPerSource: 30,
  maxArticles: 4000,
  summarizer: "extractive",
  interests: DEFAULT_INTERESTS,
  categoryWeights: {
    models: 6,
    research: 4,
    agents: 5,
    infrastructure: 4,
    "open-source": 5,
    funding: 3,
    industry: 2,
    product: 2,
    policy: 4,
    safety: 4,
    science: 3,
    robotics: 3,
  },
  breakingImpactThreshold: 66,
  breakingWindowHours: 12,
  noiseFilter: true,
  collapseDuplicates: true,
};

/** Starter alert rules so the alerts feed is useful on first boot. */
export const DEFAULT_ALERT_RULES: Omit<AlertRule, "createdAt" | "updatedAt">[] = [
  {
    id: "breaking-model-releases",
    name: "Frontier model releases",
    description: "New model drops and capability announcements from tier-1 sources.",
    keywords: ["released", "launches", "open weights", "generally available"],
    keywordMode: "any",
    categories: ["models"],
    sourceIds: [],
    minImpact: 68,
    breakingOnly: false,
    enabled: true,
    lastMatchedAt: null,
    matchCount: 0,
  },
  {
    id: "compute-supply",
    name: "Compute, chips & datacenters",
    description: "Supply chain, accelerators, HBM and gigawatt-scale build-outs.",
    keywords: ["gpu", "semiconductor", "datacenter", "hbm", "gigawatt"],
    keywordMode: "any",
    categories: ["infrastructure"],
    sourceIds: [],
    minImpact: 58,
    breakingOnly: false,
    enabled: true,
    lastMatchedAt: null,
    matchCount: 0,
  },
  {
    id: "policy-watch",
    name: "Policy, courts & regulation",
    description: "Laws, regulators, litigation and standards that change what is legal.",
    keywords: [],
    keywordMode: "any",
    categories: ["policy"],
    sourceIds: [],
    minImpact: 62,
    breakingOnly: false,
    enabled: true,
    lastMatchedAt: null,
    matchCount: 0,
  },
  {
    id: "capital-markets",
    name: "Big money: raises, M&A, valuations",
    description: "Rounds, acquisitions and valuation resets above the noise floor.",
    keywords: ["raises", "acquisition", "valuation", "ipo"],
    keywordMode: "any",
    categories: ["funding"],
    sourceIds: [],
    minImpact: 55,
    breakingOnly: false,
    enabled: true,
    lastMatchedAt: null,
    matchCount: 0,
  },
];

export function dataDir(): string {
  return dataDirectory();
}

export function dbPath(): string {
  return path.join(dataDirectory(), DB_FILE_NAME);
}

export function seedPath(): string {
  return path.join(dataDir(), "seed", "articles.seed.json");
}

function settingsFromEnv(): Partial<RadarSettings> {
  const patch: Partial<RadarSettings> = {};
  const interval = Number.parseInt(process.env.SCAN_INTERVAL_MINUTES ?? "", 10);
  if (Number.isFinite(interval) && interval > 0) patch.scanIntervalMinutes = interval;
  const concurrency = Number.parseInt(process.env.SCAN_CONCURRENCY ?? "", 10);
  if (Number.isFinite(concurrency) && concurrency > 0) patch.scanConcurrency = concurrency;
  const timeout = Number.parseInt(process.env.FETCH_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(timeout) && timeout > 0) patch.fetchTimeoutMs = timeout;
  const perSource = Number.parseInt(process.env.MAX_ITEMS_PER_SOURCE ?? "", 10);
  if (Number.isFinite(perSource) && perSource > 0) patch.maxItemsPerSource = perSource;
  const maxArticles = Number.parseInt(process.env.MAX_ARTICLES ?? "", 10);
  if (Number.isFinite(maxArticles) && maxArticles > 100) patch.maxArticles = maxArticles;
  if (process.env.SUMMARIZER === "llm" || process.env.SUMMARIZER === "extractive") {
    patch.summarizer = process.env.SUMMARIZER;
  }
  return patch;
}

/* -------------------------------------------------------------------------- */
/*  Database lifecycle                                                         */
/* -------------------------------------------------------------------------- */

function createEmptyDatabase(now: string): RadarDatabase {
  return {
    version: STORE_VERSION,
    createdAt: now,
    updatedAt: now,
    articles: [],
    sources: reconcileSources([], now),
    alerts: DEFAULT_ALERT_RULES.map((rule) => ({ ...rule, createdAt: now, updatedAt: now })),
    alertEvents: [],
    runs: [],
    settings: { ...DEFAULT_SETTINGS, ...settingsFromEnv() },
    meta: {
      lastScanAt: null,
      lastScanTrigger: null,
      scansCompleted: 0,
      totalArticlesAdded: 0,
    },
  };
}

function normalizeDatabase(raw: Partial<RadarDatabase> | null, now: string): RadarDatabase {
  const base = createEmptyDatabase(now);
  if (!raw || typeof raw !== "object") return base;

  return {
    version: STORE_VERSION,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    articles: Array.isArray(raw.articles) ? raw.articles : [],
    sources: reconcileSources(Array.isArray(raw.sources) ? raw.sources : [], now),
    alerts: Array.isArray(raw.alerts) && raw.alerts.length > 0 ? raw.alerts : base.alerts,
    alertEvents: Array.isArray(raw.alertEvents) ? raw.alertEvents : [],
    runs: Array.isArray(raw.runs) ? raw.runs.slice(0, 60) : [],
    settings: { ...base.settings, ...(raw.settings ?? {}), ...settingsFromEnv() },
    meta: { ...base.meta, ...(raw.meta ?? {}) },
  };
}

/** Seed snapshot: keeps the dashboard useful before the first successful scan. */
export function loadSeedArticles(): Article[] {
  const file = seedPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { articles?: Article[] } | Article[];
    const articles = Array.isArray(parsed) ? parsed : (parsed.articles ?? []);
    return articles.filter((article) => article && typeof article.id === "string");
  } catch (error) {
    console.warn(`[ai-radar] could not read seed snapshot: ${(error as Error).message}`);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Singleton + persistence                                                    */
/* -------------------------------------------------------------------------- */

/** A change applied to the in-memory document; kept so it can be replayed after a rebase. */
type MutationThunk = (db: RadarDatabase) => unknown;

/** A durable pending record this process owns (refreshed on repeated give-ups). */
interface FallbackRecord {
  id: string;
  /** JSON that was handed to the backend — used to detect a remote copy of it. */
  document: string;
  /**
   * Number of pending changes the record's document covers. A remote document
   * that equals this record only holds *those* changes, so the change set may
   * only be treated as "already stored" while the pending queue has not grown
   * past it.
   */
  changes: number;
}

/**
 * Contention counters. Logged per write and reported through
 * `getStoreStatus()`/`/api/health` so a rising give-up rate is visible instead
 * of showing up as missing data weeks later.
 */
export interface WriteMetrics {
  /** Conditional writes that reached the backend. */
  writes: number;
  /** Writes that needed more than one attempt. */
  contended: number;
  /** Every lost race, including those that ended in a give-up. */
  conflicts: number;
  /** Retry attempts caused by losing a race (contended writes × attempts − 1). */
  contentionRetries: number;
  /** Writes abandoned after exhausting the retry budget. */
  giveUps: number;
  /** Change sets handed to durable pending records. */
  fallbacksWritten: number;
  /** Pending records merged back into the document and cleared. */
  fallbacksRecovered: number;
  /** Pending records seen in the backend during the last hydrate. */
  pendingFallbacks: number;
  lastGiveUpAt: string | null;
  /** Highest attempt count a single write needed. */
  maxAttemptsUsed: number;
}

function emptyMetrics(): WriteMetrics {
  return {
    writes: 0,
    contended: 0,
    conflicts: 0,
    contentionRetries: 0,
    giveUps: 0,
    fallbacksWritten: 0,
    fallbacksRecovered: 0,
    pendingFallbacks: 0,
    lastGiveUpAt: null,
    maxAttemptsUsed: 0,
  };
}

interface StoreState {
  db: RadarDatabase;
  /** True once the document has been read from the configured backend. */
  hydrated: boolean;
  hydrating: Promise<void> | null;
  /** Version token of the document this process last read or wrote. */
  etag: string | null;
  /**
   * Serialized document the version token belongs to, i.e. the stored state
   * *without* the pending changes. Kept so an abandoned change set can be
   * described as "base -> document" for a recovery merge.
   */
  baseJson: string | null;
  /** Changes applied since the last successful write (replayed when rebasing). */
  pending: MutationThunk[];
  dirty: boolean;
  timer: NodeJS.Timeout | null;
  /** Serialises writes so two flushes cannot interleave stat/read/write. */
  writing: Promise<void>;
  lastWriteAt: string | null;
  lastError: string | null;
  hydrateError: string | null;
  /** Durable record written for changes this process failed to persist. */
  fallbackWritten: FallbackRecord | null;
  /**
   * Records merged into memory at hydrate, cleared once the merged document is
   * stored. `changes` is 0 because the merge happens on a fresh state (nothing
   * else is pending when it runs).
   */
  fallbackRecovered: { ids: string[]; document: string; changes: number } | null;
  metrics: WriteMetrics;
}


const globalRef = globalThis as unknown as { __aiRadarStore?: StoreState };

/* -------------------------------------------------------------------------- */
/*  Write retry policy (contention)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Retry policy for conditional writes.
 *
 * Both backends are compare-and-swap only: read the version, write with it,
 * lose the race if somebody else wrote in between. Under concurrent writers the
 * retry loop therefore needs to *desynchronise* — retrying immediately in
 * lockstep with the other writer just loses again. Every value is configurable
 * (see `.env.example`) so a deployment can widen the budget without a code
 * change.
 */
export interface WriteRetryPolicy {
  /** Total attempts per flush, including the first. */
  attempts: number;
  /** Delay before the second attempt; doubles per attempt. */
  baseDelayMs: number;
  /** Upper bound for a single backoff delay. */
  maxDelayMs: number;
  /**
   * Wall-clock budget for the retries. Once it is spent the durable fallback
   * runs instead of sleeping past a serverless function timeout.
   */
  deadlineMs: number;
}

export const DEFAULT_WRITE_RETRY_POLICY: WriteRetryPolicy = {
  attempts: 5,
  baseDelayMs: 150,
  maxDelayMs: 2_000,
  deadlineMs: 5_000,
};

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw < min) return fallback;
  return Math.min(raw, max);
}

/** Current retry policy, read from the environment (cheap; a few times a minute). */
export function writeRetryPolicy(): WriteRetryPolicy {
  const attempts = envInt("STORE_WRITE_ATTEMPTS", DEFAULT_WRITE_RETRY_POLICY.attempts, 1, 20);
  const baseDelayMs = envInt("STORE_WRITE_BACKOFF_MS", DEFAULT_WRITE_RETRY_POLICY.baseDelayMs, 0, 60_000);
  const maxDelayMs = Math.max(
    baseDelayMs,
    envInt("STORE_WRITE_BACKOFF_MAX_MS", DEFAULT_WRITE_RETRY_POLICY.maxDelayMs, 0, 120_000),
  );
  const deadlineMs = envInt("STORE_WRITE_DEADLINE_MS", DEFAULT_WRITE_RETRY_POLICY.deadlineMs, 0, 300_000);
  return { attempts, baseDelayMs, maxDelayMs, deadlineMs };
}

/**
 * Exponential backoff with "equal jitter": half of the window is fixed, half is
 * random. The fixed half guarantees a contender actually pauses instead of
 * hammering the backend, the random half breaks the lockstep that made two
 * writers collide over and over (which is what filled the logs with
 * "changed since it was read; rebasing").
 */
export function backoffDelayMs(attempt: number, policy: WriteRetryPolicy, random: () => number = Math.random): number {
  const window = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  if (window <= 0) return 0;
  const half = window / 2;
  return Math.round(half + random() * half);
}

/** Unique, sortable id for a durable pending record (`<iso>-<random>`). */
function createPendingRecordId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Seed snapshot keeps the dashboard useful before the first successful scan. */
function createSeededDatabase(now: string): RadarDatabase {
  const seeded = createEmptyDatabase(now);
  const seeds = process.env.SEED_ON_EMPTY === "false" ? [] : loadSeedArticles();
  if (seeds.length > 0) {
    seeded.articles = pruneArticles(seeds, seeded.settings.maxArticles);
    seeded.meta.totalArticlesAdded = seeds.length;
    seeded.updatedAt = now;
  }
  return seeded;
}

/**
 * Parse a stored document. An unreadable payload is never overwritten: it is
 * moved aside (local file) or copied to a `.corrupt-*` sibling (Blob) and the
 * app continues from a valid, empty store.
 */
function parseDocument(json: string, backend: StorageBackend): RadarDatabase {
  const now = new Date().toISOString();
  try {
    const parsed = JSON.parse(json) as Partial<RadarDatabase> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return normalizeDatabase(parsed, now);
  } catch (error) {
    const reason = errorMessage(error);
    console.error(`[ai-radar] ${backend.label} is unreadable (${reason}); starting from an empty store.`);
    void backend
      .quarantine(reason, json)
      .then((kept) => {
        if (kept) console.warn(`[ai-radar] unreadable payload preserved at ${kept}`);
      })
      .catch(() => undefined);
    return createEmptyDatabase(now);
  }
}

/** Make a freshly read document the live one. */
function adopt(current: StoreState, document: StoredDocument | null, backend: StorageBackend): void {
  if (document) {
    current.db = parseDocument(document.json, backend);
    current.etag = document.meta.etag;
    current.baseJson = document.json;
  } else {
    // Nothing stored yet: start from the empty (seeded) database. It is written
    // on the first change, exactly like the pre-Blob store did.
    current.db = createSeededDatabase(new Date().toISOString());
    current.etag = null;
    current.baseJson = null;
  }
  current.pending = [];
  current.dirty = false;
  current.hydrated = true;
  current.hydrateError = null;
}

async function hydrate(current: StoreState): Promise<void> {
  let backend: StorageBackend;
  try {
    backend = resolveStorageBackend();
  } catch (error) {
    current.hydrated = false;
    current.hydrateError = errorMessage(error);
    console.error(`[ai-radar] storage is not configured: ${current.hydrateError}`);
    return;
  }

  try {
    const document = await backend.read();
    adopt(current, document, backend);
    current.lastError = null;
    // Finish what an earlier process could not: change sets that were durable
    // but never landed are merged back in before the app starts serving.
    await recoverPendingWrites(current, backend, document?.json ?? null);
  } catch (error) {
    // Stay unhydrated and report through `getStoreStatus()` / `/api/health`;
    // the next request retries instead of caching the failure forever.
    current.hydrated = false;
    current.hydrateError = errorMessage(error);
    console.error(`[ai-radar] could not load ${backend.label}: ${current.hydrateError}`);
  }
}

function state(): StoreState {
  if (!globalRef.__aiRadarStore) {
    const now = new Date().toISOString();
    const current: StoreState = {
      db: createEmptyDatabase(now),
      hydrated: false,
      hydrating: null,
      etag: null,
      baseJson: null,
      pending: [],
      dirty: false,
      timer: null,
      writing: Promise.resolve(),
      lastWriteAt: null,
      lastError: null,
      hydrateError: null,
      fallbackWritten: null,
      fallbackRecovered: null,
      metrics: emptyMetrics(),
    };
    globalRef.__aiRadarStore = current;

    // Local development hydrates synchronously so the existing synchronous
    // store API - and `npm run dev` - keeps working unchanged. The Blob backend
    // needs a network round-trip, so it hydrates through `ensureStoreLoaded()`
    // (awaited by the pages, route handlers, scanner and scripts).
    let backend: StorageBackend | null = null;
    try {
      backend = resolveStorageBackend();
    } catch (error) {
      current.hydrateError = errorMessage(error);
      console.error(`[ai-radar] storage is not configured: ${current.hydrateError}`);
    }
    if (backend && backend.kind === "local") {
      try {
        adopt(current, (backend as LocalStorageBackend).readSync(), backend);
      } catch (error) {
        current.hydrateError = errorMessage(error);
        console.error(`[ai-radar] could not load ${backend.label}: ${current.hydrateError}`);
      }
    }
  }
  return globalRef.__aiRadarStore;
}

/**
 * Load the store from the configured backend. Idempotent, cheap to call from
 * every server entry point, and it never throws: failures are recorded (see
 * `getStoreStatus()`) so the app reports a clear diagnostic instead of serving
 * empty data and writing it back over the real document.
 */
export function ensureStoreLoaded(): Promise<void> {
  const current = state();
  if (current.hydrated) return Promise.resolve();
  if (!current.hydrating) {
    current.hydrating = hydrate(current).finally(() => {
      current.hydrating = null;
    });
  }
  return current.hydrating;
}

/** Guard so a missed `ensureStoreLoaded()` fails loudly instead of losing data. */
function assertReady(current: StoreState, action: string): void {
  if (current.hydrated) return;
  throw new Error(
    `[ai-radar] the store is not loaded, so it cannot ${action}. Server code must \`await ensureStoreLoaded()\` before touching the store. ` +
      (current.hydrateError ? `Storage error: ${current.hydrateError}` : "Loading is still in flight."),
  );
}

export function getDb(): RadarDatabase {
  const current = state();
  assertReady(current, "read the stored news");
  return current.db;
}

/**
 * Persist pending changes now.
 *
 * Writes are serialised per process and conditional on the version we last read,
 * so a slow write can never be interleaved with — or clobber — another writer.
 * Failures are logged, kept in `pending` and retried by the next flush.
 */
export async function flush(): Promise<void> {
  const current = state();
  if (current.timer) {
    clearTimeout(current.timer);
    current.timer = null;
  }
  const run = current.writing.then(
    () => persist(current),
    () => persist(current),
  );
  current.writing = run.then(
    () => undefined,
    () => undefined,
  );
  await current.writing;
}

function scheduleFlush(): void {
  const current = state();
  current.dirty = true;
  if (current.timer) return;
  current.timer = setTimeout(() => {
    current.timer = null;
    void flush();
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Mutate the store, then schedule a debounced (atomic) write.
 *
 * Mutating routes and scripts follow up with `await flush()` so the change is on
 * the backend before the response is sent; the debounce only coalesces bursts.
 */
export function mutate<T>(fn: (db: RadarDatabase) => T): T {
  const current = state();
  assertReady(current, "modify the store");
  const result = fn(current.db);
  current.pending.push(fn as MutationThunk);
  scheduleFlush();
  return result;
}

/** Drop the in-process copy; the next access re-reads the backend (tests/tooling). */
export function resetStoreCache(): void {
  const current = globalRef.__aiRadarStore;
  if (current?.timer) clearTimeout(current.timer);
  globalRef.__aiRadarStore = undefined;
}

export interface StoreStatus {
  backend: {
    kind: StorageBackendKind;
    label: string;
    reason: string;
    detail: Record<string, string | number | boolean>;
  };
  /** False when the backend could not be read/configured. */
  hydrated: boolean;
  dirty: boolean;
  pendingWrites: number;
  lastWriteAt: string | null;
  /** Last storage failure (read, write or configuration), if any. */
  lastError: string | null;
  documentUpdatedAt: string | null;
  articles: number;
  /** Write contention + durable-fallback counters (see README, "Concurrency"). */
  contention: WriteMetrics;
}

/** Storage diagnostics for `/api/health` and the settings screen. Never throws. */
export function getStoreStatus(): StoreStatus {
  const current = state();
  return {
    backend: describeStorage(),
    hydrated: current.hydrated,
    dirty: current.dirty,
    pendingWrites: current.pending.length,
    lastWriteAt: current.lastWriteAt,
    lastError: current.lastError ?? current.hydrateError,
    documentUpdatedAt: current.db.updatedAt ?? null,
    articles: current.db.articles.length,
    contention: { ...current.metrics },
  };
}

/* -------------------------------------------------------------------------- */
/*  Conditional writes (optimistic concurrency)                                */
/* -------------------------------------------------------------------------- */

/**
 * Re-apply the changes made since the last successful write to another document
 * (the one another writer produced). Mutations are plain `(db) => result`
 * functions, so replaying them on a fresh document merges both writers'
 * changes instead of dropping one of them.
 */
function replay(db: RadarDatabase, thunks: MutationThunk[]): RadarDatabase {
  for (const thunk of thunks) {
    try {
      thunk(db);
    } catch (error) {
      console.error(`[ai-radar] could not replay a pending change: ${errorMessage(error)}`);
    }
  }
  return db;
}

/**
 * Write the in-memory document back, conditionally on the version we last read.
 *
 * The flow mirrors the classic compare-and-swap loop: check the stored version
 * (cheap `stat`), rebase local changes onto a newer document when somebody else
 * won the race, then write with `ifMatch`. Retries wait out an exponential
 * backoff with jitter, and when the budget is exhausted the change set is handed
 * to durable storage ({@link preservePendingChanges}) instead of being left in
 * process memory — a serverless instance can be recycled at any moment.
 *
 * Never throws — a failure is reported through `lastError`, the metrics and
 * `getStoreStatus()`, and the changes stay `pending` for the next flush.
 */
async function persist(current: StoreState): Promise<void> {
  if (!current.hydrated || (!current.dirty && current.pending.length === 0)) return;

  let backend: StorageBackend;
  try {
    backend = resolveStorageBackend();
  } catch (error) {
    current.lastError = errorMessage(error);
    console.error(`[ai-radar] failed to persist the store: ${current.lastError}`);
    return;
  }

  const policy = writeRetryPolicy();
  const startedAt = Date.now();
  // Snapshot the changes this write is responsible for; anything recorded while
  // the request is in flight stays pending for the next flush.
  const batch = current.pending.slice();
  let rebase = false;
  let attemptsUsed = 0;
  let contended = false;
  let lastConflict = false;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const remote = await backend.stat();

      // A rebase is needed whenever the stored version is not the one this
      // document was built on: somebody moved it, removed it or created it.
      if (rebase || (remote === null ? current.etag !== null : remote.etag !== current.etag)) {
        const latest = await backend.read();
        const abandoned = current.fallbackWritten ?? current.fallbackRecovered;
        // Somebody already stored exactly the change set we could not write (a
        // pending record recovered by another instance): adopt it instead of
        // replaying the same changes on top of themselves. Only valid while the
        // record still covers the whole pending queue — a change made after the
        // record was written is *not* in it and must not be dropped.
        const abandonedCoversBatch = abandoned !== null && batch.length === abandoned.changes;
        if (latest && abandoned && abandonedCoversBatch && latest.json === abandoned.document) {
          console.info(
            `[ai-radar] ${backend.label} already contains change set ${current.fallbackWritten?.id ?? current.fallbackRecovered?.ids.join(", ")}; adopting it`,
          );
          current.db = parseDocument(latest.json, backend);
          current.etag = latest.meta.etag;
          current.baseJson = latest.json;
          current.pending = current.pending.filter((thunk) => !batch.includes(thunk));
          current.dirty = current.pending.length > 0;
          current.lastWriteAt = new Date().toISOString();
          current.lastError = null;
          recordWrite(current, { attempts: 1, contended: false });
          await resolvePendingRecords(current, backend, { recoveredStored: true });
          return;
        }
        if (latest) {
          console.info(`[ai-radar] ${backend.label} changed since it was read; rebasing ${batch.length} local change(s)`);
          // Replay the *live* queue, not just the snapshot: a mutation that
          // arrived while this flush was waiting may already have been applied
          // to the document that is about to be replaced, and must survive too.
          current.db = replay(parseDocument(latest.json, backend), current.pending.slice());
          current.etag = latest.meta.etag;
          current.baseJson = latest.json;
        } else {
          current.etag = null; // document removed: (re)create it
          current.baseJson = null;
        }
      }

      current.db.updatedAt = new Date().toISOString();
      const json = JSON.stringify(current.db);
      const written = await backend.write(json, { expectedEtag: current.etag });

      current.etag = written.meta.etag;
      current.baseJson = json;
      current.pending = current.pending.filter((thunk) => !batch.includes(thunk));
      current.dirty = current.pending.length > 0;
      current.lastWriteAt = new Date().toISOString();
      current.lastError = null;
      recordWrite(current, { attempts: attemptsUsed, contended });
      // The batch is stored, so a record we kept as a safety net is obsolete. A
      // change set recovered at hydrate is only obsolete if this write actually
      // contained it — a rebase replaced our document with the remote one.
      await resolvePendingRecords(current, backend, { recoveredStored: !rebase });
      return;
    } catch (error) {
      const conflict = error instanceof StorageConflictError;
      if (conflict) {
        // Somebody wrote between our `stat` and our write: re-read and retry.
        rebase = true;
        contended = true;
        current.metrics.conflicts += 1;
      } else {
        current.lastError = errorMessage(error);
      }
      lastConflict = conflict;

      const wait = backoffDelayMs(attempt, policy);
      const spent = Date.now() - startedAt;
      if (attempt >= policy.attempts || spent + wait > policy.deadlineMs) {
        console.warn(`[ai-radar] giving up on ${backend.label} after ${attempt} attempt(s), ${spent}ms spent`);
        break;
      }
      await delay(wait);
    }
  }

  current.dirty = current.pending.length > 0;
  current.metrics.giveUps += 1;
  current.metrics.lastGiveUpAt = new Date().toISOString();
  current.metrics.contentionRetries += Math.max(0, attemptsUsed - 1);
  current.metrics.maxAttemptsUsed = Math.max(current.metrics.maxAttemptsUsed, attemptsUsed);
  if (current.pending.length === 0) return;

  const reason = lastConflict
    ? `contention: all ${attemptsUsed} conditional write attempt(s) lost a race against another writer`
    : `storage error after ${attemptsUsed} attempt(s): ${current.lastError}`;
  const location = await preservePendingChanges(current, backend, { reason, attempts: attemptsUsed, batch });
  // Reported through `lastError` as well, so `/api/health` shows the give-up
  // instead of the changes quietly disappearing from the deployment.
  current.lastError = location
    ? `could not persist ${current.pending.length} change(s) to ${backend.label} (${reason}); kept durably at ${location}`
    : `could not persist ${current.pending.length} change(s) to ${backend.label} (${reason}); the durable fallback failed too — data is in this process's memory only`;
  console.error(`[ai-radar] ${current.lastError}`);
}

/**
 * Durable last resort: keep a change set that could not be written under its own
 * key so it survives this process. Repeated give-ups refresh the same record
 * instead of piling up one per flush.
 */
async function preservePendingChanges(
  current: StoreState,
  backend: StorageBackend,
  input: { reason: string; attempts: number; batch: MutationThunk[] },
  round = 0,
): Promise<string | null> {
  const existing = current.fallbackWritten;
  const id = existing?.id ?? createPendingRecordId();
  const document = JSON.stringify(current.db);
  // The document includes every change applied so far; `batch` is what this
  // flush was responsible for. Record both so a later process can tell whether
  // the pending queue has moved past this record.
  const covered = Math.max(input.batch.length, current.pending.length);
  const record: PendingWriteRecord = {
    id,
    createdAt: new Date().toISOString(),
    label: backend.label,
    reason: input.reason,
    attempts: input.attempts,
    baseEtag: current.etag,
    base: current.baseJson,
    document,
    changes: covered,
  };

  try {
    const location = await backend.writePending(record);
    current.fallbackWritten = { id, document, changes: covered };
    current.metrics.fallbacksWritten += 1;
    console.info(
      `[ai-radar] kept ${input.batch.length} change(s) for ${backend.label} in durable pending storage at ${location}`,
    );
    // Writing the record is a network round trip on Blob, so a change may have
    // arrived meanwhile; it is not in the payload we just stored. Refresh the
    // same record until it covers the queue (bounded, so a pathologically busy
    // instance cannot spin here).
    if (current.pending.length > covered) {
      if (round >= 2) {
        console.warn(
          `[ai-radar] pending changes for ${backend.label} keep arriving while they are being persisted; ` +
            `the current record is one change set behind and the remaining changes stay in memory`,
        );
        return location;
      }
      return preservePendingChanges(current, backend, input, round + 1);
    }
    return location;
  } catch (error) {
    console.error(`[ai-radar] durable pending storage failed for ${backend.label}: ${errorMessage(error)}`);
    return null;
  }
}

function recordWrite(current: StoreState, result: { attempts: number; contended: boolean }): void {
  current.metrics.writes += 1;
  current.metrics.maxAttemptsUsed = Math.max(current.metrics.maxAttemptsUsed, result.attempts);
  if (result.contended || result.attempts > 1) {
    current.metrics.contended += 1;
    current.metrics.contentionRetries += Math.max(0, result.attempts - 1);
    console.warn(`[ai-radar] persisted the store after ${result.attempts} attempts (write contention)`);
  }
}

/** Clear durable records whose changes are known to be in the stored document. */
async function resolvePendingRecords(
  current: StoreState,
  backend: StorageBackend,
  options: { recoveredStored: boolean },
): Promise<void> {
  const written = current.fallbackWritten;
  current.fallbackWritten = null;
  if (written) await clearPendingRecord(backend, written.id);

  const recovered = current.fallbackRecovered;
  current.fallbackRecovered = null;
  if (!recovered) return;

  if (options.recoveredStored) {
    for (const id of recovered.ids) await clearPendingRecord(backend, id);
    current.metrics.fallbacksRecovered += recovered.ids.length;
    console.info(`[ai-radar] recovered change set(s) ${recovered.ids.join(", ")} are now stored in ${backend.label}`);
    return;
  }
  // A rebase replaced the merged document with the remote one: the records must
  // stay so the changes are not lost.
  console.warn(
    `[ai-radar] recovered change set(s) ${recovered.ids.join(", ")} were superseded by a concurrent write; ` +
      `they stay in ${backend.label} pending storage`,
  );
}

async function clearPendingRecord(backend: StorageBackend, id: string): Promise<void> {
  try {
    await backend.resolvePending(id);
  } catch (error) {
    console.warn(`[ai-radar] could not clear pending record ${id} of ${backend.label}: ${errorMessage(error)}`);
  }
}

/**
 * Merge change sets that an earlier process could not write back into the
 * document (three-way merge against the stored version, see `./storage/merge`)
 * and let the next flush store the result. Nothing is dropped when a merge is
 * impossible: those records stay durable and are retried by the next hydrate.
 */
async function recoverPendingWrites(
  current: StoreState,
  backend: StorageBackend,
  remoteJson: string | null,
): Promise<void> {
  let records: PendingWriteRecord[];
  try {
    records = await backend.listPending();
  } catch (error) {
    console.warn(`[ai-radar] could not list pending changes of ${backend.label}: ${errorMessage(error)}`);
    return;
  }
  current.metrics.pendingFallbacks = records.length;
  if (records.length === 0) return;

  // Oldest first, so the most recent change set wins where two touch the same
  // field — the same order in which they were made.
  const ordered = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const applied: string[] = [];
  let merged = remoteJson;

  for (const record of ordered) {
    const next = mergePendingDocument(record.base, record.document, merged);
    if (next === null) {
      console.warn(`[ai-radar] pending change set ${record.id} of ${backend.label} could not be merged; kept for later`);
      continue;
    }
    merged = next;
    applied.push(record.id);
  }

  if (merged === null || applied.length === 0) return;

  current.db = parseDocument(merged, backend);
  current.baseJson = remoteJson;
  current.dirty = true;
  // A fresh state has nothing pending, so the merged document covers 0 changes
  // of its own — it must never be used to drop a later pending change.
  current.fallbackRecovered = { ids: applied, document: merged, changes: 0 };
  console.warn(
    `[ai-radar] recovered ${applied.length} unpersisted change set(s) from ${backend.label} pending storage; ` +
      `they will be written back on the next flush`,
  );
  // Do not wait for a user request: a recovered change set that is never written
  // back is still a pending write.
  scheduleFlush();
}



export function pruneArticles(articles: Article[], maxArticles: number): Article[] {
  if (articles.length <= maxArticles) return articles;
  // Never prune bookmarked items - they are an explicit user signal.
  const sorted = [...articles].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
  const bookmarked = sorted.filter((article) => article.bookmarked);
  const rest = sorted.filter((article) => !article.bookmarked);
  const keep = [...bookmarked, ...rest.slice(0, Math.max(0, maxArticles - bookmarked.length))];
  return keep;
}

/* -------------------------------------------------------------------------- */
/*  Sources                                                                    */
/* -------------------------------------------------------------------------- */

export function getSources(): Source[] {
  return getDb().sources;
}

export function getSource(id: string): Source | undefined {
  return getDb().sources.find((source) => source.id === id);
}

export function addSource(input: SourceInput): Source {
  const now = new Date().toISOString();
  let id = slugify(input.name);
  const existing = new Set(getDb().sources.map((source) => source.id));
  if (existing.has(id)) id = `${id}-${hashId(input.url).slice(0, 6)}`;

  const source: Source = {
    id,
    name: input.name.trim().slice(0, 80),
    url: input.url.trim(),
    homepage: (input.homepage ?? input.url).trim(),
    kind: input.kind ?? "media",
    tier: input.tier ?? 2,
    enabled: true,
    builtIn: false,
    beats: (input.beats ?? []).filter(isCategoryId),
    notes: input.notes,
    lastFetchedAt: null,
    lastStatus: "never",
    lastError: null,
    lastItemCount: 0,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };

  return mutate((db) => {
    db.sources.push(source);
    return source;
  });
}

export function updateSource(id: string, patch: Partial<Source>): Source | null {
  return mutate((db) => {
    const source = db.sources.find((candidate) => candidate.id === id);
    if (!source) return null;
    Object.assign(source, patch, { id: source.id, updatedAt: new Date().toISOString() });
    return { ...source };
  });
}

export function removeSource(id: string): boolean {
  return mutate((db) => {
    const index = db.sources.findIndex((source) => source.id === id);
    if (index === -1) return false;
    if (db.sources[index].builtIn) return false;
    db.sources.splice(index, 1);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*  Articles                                                                   */
/* -------------------------------------------------------------------------- */

export interface InsertResult {
  added: Article[];
  merged: number;
  duplicates: Article[];
}

const DEDUPE_WINDOW_MS = 72 * 3_600_000;
const DEDUPE_THRESHOLD = 0.6;

/**
 * Insert freshly scanned articles, folding cross-source duplicates together.
 *
 * Returns the genuinely new items so the alert engine only fires for news the
 * user has not seen yet.
 */
export function insertArticles(candidates: Article[]): InsertResult {
  return mutate((db) => {
    const byId = new Map(db.articles.map((article) => [article.id, article]));
    const recent = db.articles
      .filter((article) => Date.now() - Date.parse(article.publishedAt) <= DEDUPE_WINDOW_MS * 2)
      .slice(0, 600);

    const added: Article[] = [];
    const duplicates: Article[] = [];
    let merged = 0;

    for (const candidate of candidates) {
      const exact = byId.get(candidate.id);
      if (exact) {
        // The same URL resurfaced: refresh mutable metadata, keep user flags.
        exact.excerpt = candidate.excerpt || exact.excerpt;
        if (!exact.author && candidate.author) exact.author = candidate.author;
        merged += 1;
        continue;
      }

      const match = recent.find(
        (article) =>
          article.sourceId !== candidate.sourceId &&
          Math.abs(Date.parse(article.publishedAt) - Date.parse(candidate.publishedAt)) <
            DEDUPE_WINDOW_MS &&
          titleSimilarity(article.title, candidate.title) >= DEDUPE_THRESHOLD,
      );

      if (match) {
        if (Date.parse(match.publishedAt) <= Date.parse(candidate.publishedAt)) {
          match.alsoCoveredBy = unique([...match.alsoCoveredBy, candidate.sourceId]);
          match.impact = Math.max(match.impact, candidate.impact);
          match.relevance = Math.max(match.relevance, candidate.relevance);
          match.updatedAt = new Date().toISOString();
          merged += 1;
          continue;
        }
        candidate.duplicateOf = match.id;
        candidate.alsoCoveredBy = unique([...candidate.alsoCoveredBy, match.sourceId]);
      }

      byId.set(candidate.id, candidate);
      added.push(candidate);
      duplicates.push(candidate);
    }

    if (added.length > 0) {
      db.articles.push(...added);
      db.meta.totalArticlesAdded += added.length;
      db.articles = pruneArticles(db.articles, db.settings.maxArticles);
    }

    return { added, merged, duplicates };
  });
}

export function getArticle(id: string): Article | undefined {
  return getDb().articles.find((article) => article.id === id);
}

export function updateArticle(id: string, patch: Partial<Article>): Article | null {
  return mutate((db) => {
    const article = db.articles.find((candidate) => candidate.id === id);
    if (!article) return null;
    Object.assign(article, patch, { id: article.id, updatedAt: new Date().toISOString() });
    return { ...article };
  });
}

export function markAllRead(value = true): number {
  return mutate((db) => {
    let changed = 0;
    for (const article of db.articles) {
      if (article.read !== value) {
        article.read = value;
        changed += 1;
      }
    }
    return changed;
  });
}

/** Re-run the intelligence layer for one article against the current settings. */
export function reclassifyArticle(article: Article): Article {
  const source = getSource(article.sourceId);
  const result = classifyArticle(
    {
      title: article.title,
      body: `${article.excerpt} ${article.summary}`,
      tier: source?.tier ?? 2,
      sourceKind: source?.kind ?? article.sourceKind,
      beats: source?.beats ?? [],
      publishedAt: article.publishedAt,
    },
    getDb().settings,
  );

  return {
    ...article,
    category: result.category,
    secondaryCategories: result.secondaryCategories,
    categoryConfidence: result.categoryConfidence,
    tags: result.tags,
    entities: result.entities,
    impact: result.impact,
    signals: result.signals,
    relevance: result.relevance,
    sentiment: result.sentiment,
    isBreaking: result.isBreaking,
  };
}

/** Apply a new interest profile / weights to everything already stored. */
export function recomputeAllArticles(): number {
  return mutate((db) => {
    db.articles = db.articles.map((article) => reclassifyArticle(article));
    return db.articles.length;
  });
}

/* -------------------------------------------------------------------------- */
/*  Alerts                                                                     */
/* -------------------------------------------------------------------------- */

export function getAlerts(): AlertRule[] {
  return getDb().alerts;
}

export function getAlert(id: string): AlertRule | undefined {
  return getDb().alerts.find((rule) => rule.id === id);
}

export function createAlert(
  input: import("./types").AlertRuleInput,
): AlertRule {
  const now = new Date().toISOString();
  const rule: AlertRule = {
    id: hashId("alert", input.name, String(Date.now())),
    name: input.name.trim().slice(0, 80),
    description: input.description,
    keywords: (input.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean),
    keywordMode: input.keywordMode === "all" ? "all" : "any",
    categories: (input.categories ?? []).filter(isCategoryId),
    sourceIds: input.sourceIds ?? [],
    minImpact: typeof input.minImpact === "number" ? Math.min(99, Math.max(0, input.minImpact)) : 0,
    breakingOnly: Boolean(input.breakingOnly),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    lastMatchedAt: null,
    matchCount: 0,
  };

  return mutate((db) => {
    db.alerts.push(rule);
    return rule;
  });
}

export function updateAlert(id: string, patch: Partial<AlertRule>): AlertRule | null {
  return mutate((db) => {
    const rule = db.alerts.find((candidate) => candidate.id === id);
    if (!rule) return null;
    Object.assign(rule, patch, { id: rule.id, updatedAt: new Date().toISOString() });
    return { ...rule };
  });
}

export function deleteAlert(id: string): boolean {
  return mutate((db) => {
    const index = db.alerts.findIndex((rule) => rule.id === id);
    if (index === -1) return false;
    db.alerts.splice(index, 1);
    db.alertEvents = db.alertEvents.filter((event) => event.ruleId !== id);
    return true;
  });
}

export function getAlertEvents(): AlertEvent[] {
  return getDb().alertEvents;
}

export function recordAlertMatches(matches: { rule: AlertRule; event: AlertEvent }[]): number {
  if (matches.length === 0) return 0;
  return mutate((db) => {
    for (const { rule, event } of matches) {
      const target = db.alerts.find((candidate) => candidate.id === rule.id);
      if (target) {
        target.lastMatchedAt = event.createdAt;
        target.matchCount += 1;
      }
      db.alertEvents.unshift(event);
    }
    // Keep the event log bounded; 500 recent matches is plenty for the UI.
    db.alertEvents = db.alertEvents.slice(0, 500);
    return matches.length;
  });
}

export function markAlertEventsRead(ids?: string[]): number {
  return mutate((db) => {
    let changed = 0;
    const filter = ids ? new Set(ids) : null;
    for (const event of db.alertEvents) {
      if (filter && !filter.has(event.id)) continue;
      if (!event.read) {
        event.read = true;
        changed += 1;
      }
    }
    return changed;
  });
}

/** Snooze (or unsnooze with `until: null`) alert events by id. */
export function snoozeAlertEvents(ids: string[], until: string | null): number {
  return mutate((db) => {
    const filter = new Set(ids);
    let changed = 0;
    for (const event of db.alertEvents) {
      if (!filter.has(event.id)) continue;
      event.snoozedUntil = until;
      changed += 1;
    }
    return changed;
  });
}

/* -------------------------------------------------------------------------- */
/*  Scans + settings                                                           */
/* -------------------------------------------------------------------------- */

export function recordRun(run: ScanRun): ScanRun {
  return mutate((db) => {
    db.runs.unshift(run);
    db.runs = db.runs.slice(0, 60);
    db.meta.lastScanAt = run.finishedAt;
    db.meta.lastScanTrigger = run.trigger;
    db.meta.scansCompleted += 1;
    return run;
  });
}

export function getRuns(): ScanRun[] {
  return getDb().runs;
}

export function getSettings(): RadarSettings {
  return getDb().settings;
}

export function updateSettings(patch: Partial<RadarSettings>): RadarSettings {
  return mutate((db) => {
    db.settings = { ...db.settings, ...patch };
    if (Array.isArray(patch.interests)) {
      db.settings.interests = patch.interests
        .map((interest) => ({
          keyword: String(interest.keyword ?? "").trim().toLowerCase(),
          weight: Number.isFinite(Number(interest.weight)) ? Number(interest.weight) : 1,
        }))
        .filter((interest) => interest.keyword.length > 0)
        .slice(0, 40);
    }
    return db.settings;
  });
}

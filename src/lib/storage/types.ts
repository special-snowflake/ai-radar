/**
 * Storage abstraction for the radar's single JSON document.
 *
 * The application only knows `StorageBackend`, never the filesystem or Vercel
 * Blob directly:
 *
 *     application (src/lib/store.ts)
 *          |
 *          v
 *     StorageBackend
 *          |
 *     +----+----------------------+
 *     |                           |
 *  local backend             blob backend
 *  data/db.json              Vercel Blob: news.json
 *
 * Both backends implement the same optimistic-concurrency contract: `read()`
 * returns a version token (`etag`) and `write()` only succeeds while the stored
 * document still carries the version the caller read. That single rule is what
 * keeps a debounced in-process cache from clobbering a writer in another
 * process (a CLI scan next to the dev server, or another serverless instance).
 */

export type StorageBackendKind = "local" | "blob";

/** Metadata about the stored document — enough to compare versions without downloading it. */
export interface DocumentMeta {
  /**
   * Opaque version token. Local: `<size>:<mtimeMs>`. Blob: the Vercel Blob ETag.
   * Only ever compared for equality, never parsed.
   */
  etag: string;
  size: number;
  updatedAt: string | null;
}

export interface StoredDocument {
  meta: DocumentMeta;
  json: string;
}

export interface WriteOptions {
  /**
   * The version the document must still have for the write to be accepted.
   * `null` means "the document must not exist yet" — used for the very first
   * write so two fresh writers cannot both create the document.
   */
  expectedEtag: string | null;
}

export interface WriteResult {
  meta: DocumentMeta;
}

/**
 * A last-resort, durable record of changes that could not be written.
 *
 * Neither backend offers an atomic merge, so a conditional write can lose a
 * race more often than the retry budget allows (see `src/lib/store.ts`). The
 * store then hands the whole merged document to the backend under a sibling
 * key — a dead-letter queue with one entry per abandoned change set — so the
 * data survives the process (serverless instances are recycled without notice)
 * and a later process can merge it back in.
 */
export interface PendingWriteRecord {
  /** Unique, sortable id (`<iso>-<random>`); also the key suffix in storage. */
  id: string;
  createdAt: string;
  /** Backend label the write was aimed at, e.g. `vercel-blob:news.json`. */
  label: string;
  /** Why the write was abandoned. Safe to log. */
  reason: string;
  /** Attempts consumed before giving up. */
  attempts: number;
  /** Version the local changes were applied to (`null` = document did not exist). */
  baseEtag: string | null;
  /** Serialized document the local changes were applied to (`null` = it did not exist). */
  base: string | null;
  /** Serialized document *including* the local changes that failed to persist. */
  document: string;
  /** Number of local changes in the abandoned batch. */
  changes: number;
}

/** Upper bound on how many pending records are read/returned at once. */
export const PENDING_RECORD_LIMIT = 20;

/**
 * How long a pending record is kept before it is pruned.
 *
 * A pending record exists so an unpersisted change set can be merged back later.
 * A record that is still unmergeable after a week is not going to recover: the
 * document it was based on has moved on, the serverless instance that wrote it is
 * long gone, and keeping it only makes `listPending()` slower on every hydrate.
 * So records are pruned automatically after this age — always loudly, naming
 * every pruned id, so an operator can still recover one by hand with
 * `npm run recover-pending` before it disappears.
 */
export const PENDING_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A scheduler lease: "this instance is the one allowed to run the scan loop".
 *
 * The in-process scheduler runs in *every* server process, which is exactly
 * wrong on a serverless platform (every instance would scan and write). The
 * lease is a single small record in the storage backend, taken with the same
 * compare-and-swap the document write uses, so the first instance to win it
 * scans and the rest stay idle. It has a TTL because a holder can be frozen or
 * killed without releasing anything.
 */
export interface ScanLeaseRecord {
  /** Opaque id of the instance that holds the lease (safe to log). */
  holder: string;
  /** ISO timestamp the lease was taken. */
  acquiredAt: string;
  /** ISO timestamp after which another instance may take the lease over. */
  expiresAt: string;
}

export interface ScanLeaseOptions {
  /** Identity of this process, e.g. `<hostname>-<pid>`. */
  holder: string;
  /** Lease lifetime in ms; the winner renews it on every scheduler tick. */
  ttlMs: number;
  /** Injectable clock (tests). */
  now?: number;
}

export interface ScanLeaseResult {
  /** True when this caller now holds the lease. */
  acquired: boolean;
  /** The stored lease after the attempt (the winner's, or the incumbent's). */
  record: ScanLeaseRecord | null;
  /** Why the lease was not taken — safe to log, used in the scheduler message. */
  reason: string | null;
}

export interface StorageBackend {
  readonly kind: StorageBackendKind;
  /** Human readable target, e.g. `data/db.json` — never contains credentials. */
  readonly label: string;

  /** Read the document, or `null` when nothing has been stored yet. */
  read(): Promise<StoredDocument | null>;
  /** Read metadata only (cheap version check). */
  stat(): Promise<DocumentMeta | null>;
  /** Conditional write; throws {@link StorageConflictError} when the version moved on. */
  write(json: string, options: WriteOptions): Promise<WriteResult>;
  /**
   * Preserve a payload that could not be parsed instead of overwriting it.
   * Best effort: returns the backup location, or `null` when nothing was kept.
   */
  quarantine(reason: string, json: string): Promise<string | null>;
  /**
   * Durably keep a change set that could not be written, under a key of its own
   * so the primary document is never touched. Must survive this process.
   * @returns where the record was kept (safe to log).
   */
  writePending(record: PendingWriteRecord): Promise<string>;
  /** Pending records still waiting to be merged back, newest first. */
  listPending(): Promise<PendingWriteRecord[]>;
  /** Drop a record once its changes are known to be in the primary document. */
  resolvePending(id: string): Promise<boolean>;
  /**
   * Take the scheduler lease if it is free, ours, or expired.
   *
   * Must be atomic: two instances booting at the same time have to produce
   * exactly one winner. The TTL bounds how long a frozen instance keeps other
   * instances out of the scan loop.
   */
  acquireScanLease(options: ScanLeaseOptions): Promise<ScanLeaseResult>;
  /**
   * Give the lease up on a clean shutdown so the next instance can start
   * scanning immediately instead of waiting for the TTL.
   */
  releaseScanLease(options: { holder: string }): Promise<boolean>;
  /** Non-secret diagnostics for `/api/health` and logs. */
  describe(): Record<string, string | number | boolean>;
}

/** Thrown when a conditional write lost a race against another writer. */
export class StorageConflictError extends Error {
  readonly backend: StorageBackendKind;

  constructor(message: string, backend: StorageBackendKind) {
    super(message);
    this.name = "StorageConflictError";
    this.backend = backend;
  }
}

/** Thrown when the configured backend cannot be used at all (missing credentials, bad path). */
export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

/** Short, safe representation of an unknown error (never leaks tokens/URLs). */
export function storageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown storage error";
}

/**
 * Age of a pending record in ms, or `null` when it cannot be determined.
 *
 * `createdAt` is the honest clock, but a hand-written or truncated record may
 * not have a parsable one. Returning `null` (instead of guessing) lets callers
 * decide explicitly, and {@link isPendingRecordExpired} treats it as "keep".
 */
export function pendingRecordAgeMs(record: PendingWriteRecord, now: number = Date.now()): number | null {
  const created = Date.parse(record.createdAt);
  if (!Number.isFinite(created)) return null;
  return now - created;
}

/** True when a pending record is old enough to be pruned. Undated records are kept. */
export function isPendingRecordExpired(
  record: PendingWriteRecord,
  options: { now?: number; maxAgeMs?: number } = {},
): boolean {
  const age = pendingRecordAgeMs(record, options.now);
  if (age === null) return false;
  return age > (options.maxAgeMs ?? PENDING_RECORD_MAX_AGE_MS);
}

/** True while a stored lease still blocks other instances. */
export function isScanLeaseActive(record: ScanLeaseRecord | null, now: number = Date.now()): boolean {
  if (!record) return false;
  const expires = Date.parse(record.expiresAt);
  // An unparsable expiry is treated as expired: a corrupt lease must not park
  // the whole deployment's scan loop forever.
  if (!Number.isFinite(expires)) return false;
  return expires > now;
}

/** Build the lease this caller would store, from a clean or expired slot. */
export function makeScanLeaseRecord(holder: string, ttlMs: number, now: number = Date.now()): ScanLeaseRecord {
  return {
    holder,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

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

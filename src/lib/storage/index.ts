import path from "node:path";
import { createBlobBackend, type BlobAccess } from "./blob";
import { createLocalBackend } from "./local";
import { StorageConfigurationError, type StorageBackend, type StorageBackendKind } from "./types";

/**
 * Backend selection.
 *
 *   STORAGE_BACKEND=auto (default)
 *     - running on Vercel                      -> Vercel Blob (`news.json`)
 *     - production build with a Blob token     -> Vercel Blob (`news.json`)
 *     - everything else (npm run dev, tests)   -> local `data/db.json`
 *   STORAGE_BACKEND=local                      -> always `data/db.json`
 *   STORAGE_BACKEND=blob                       -> always Vercel Blob (opt-in,
 *                                                 even in development)
 *
 * `auto` is what keeps development safe: `npm run dev` never touches the
 * production Blob store unless `STORAGE_BACKEND=blob` is set explicitly.
 */

export * from "./types";
export { createBlobBackend, createLocalBackend };
export { mergePendingDocument, jsonEqual } from "./merge";
export type { BlobAccess };

/** File name of the local JSON document (unchanged from the pre-Blob app). */
export const DB_FILE_NAME = "db.json";
export const DEFAULT_BLOB_PATHNAME = "news.json";

export interface ResolvedStorageTarget {
  kind: StorageBackendKind;
  /** Why this backend was chosen — surfaced in logs and `/api/health`. */
  reason: string;
}

/** Directory that holds `db.json` + the seed snapshot. Honours `DATA_DIR`. */
export function dataDirectory(): string {
  const configured = process.env.DATA_DIR?.trim();
  if (configured) return path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  return path.join(process.cwd(), "data");
}

/** Pure env → backend decision (no client construction); handy for diagnostics and tests. */
export function resolveStorageTarget(): ResolvedStorageTarget {
  const configured = (process.env.STORAGE_BACKEND ?? "auto").trim().toLowerCase();
  if (configured === "local" || configured === "blob") {
    return { kind: configured, reason: `STORAGE_BACKEND=${configured}` };
  }

  if (process.env.VERCEL) {
    return { kind: "blob", reason: "running on Vercel (VERCEL is set)" };
  }

  const hasToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
  if (hasToken && process.env.NODE_ENV === "production") {
    return { kind: "blob", reason: "production build with BLOB_READ_WRITE_TOKEN configured" };
  }

  return {
    kind: "local",
    reason: process.env.NODE_ENV === "production" ? "no Blob store configured" : "local development",
  };
}

function blobAccess(): BlobAccess {
  return process.env.BLOB_ACCESS?.trim().toLowerCase() === "private" ? "private" : "public";
}

function blobPathname(): string {
  return (process.env.BLOB_STORE_PATHNAME?.trim() || DEFAULT_BLOB_PATHNAME).replace(/^\/+/, "");
}

function hasBlobCredentials(): boolean {
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) return true;
  // Vercel can also authenticate with short-lived OIDC credentials.
  return Boolean(process.env.VERCEL_OIDC_TOKEN?.trim() && process.env.BLOB_STORE_ID?.trim());
}

let cachedBackend: StorageBackend | null = null;

/**
 * The process-wide backend instance. Configuration problems (for example a
 * missing `BLOB_READ_WRITE_TOKEN`) throw a {@link StorageConfigurationError}
 * with an actionable message and are never swallowed into the stored data.
 */
export function resolveStorageBackend(): StorageBackend {
  if (cachedBackend) return cachedBackend;

  const target = resolveStorageTarget();

  if (target.kind === "blob") {
    if (!hasBlobCredentials()) {
      throw new StorageConfigurationError(
        `Vercel Blob storage was selected (${target.reason}) but no Blob credentials are available. ` +
          `Connect a Blob store to the project on Vercel — that sets BLOB_READ_WRITE_TOKEN automatically — ` +
          `or set BLOB_READ_WRITE_TOKEN in .env.local. ` +
          `To keep using data/db.json instead, set STORAGE_BACKEND=local.`,
      );
    }
    if (process.env.NODE_ENV !== "production" && process.env.STORAGE_BACKEND?.trim().toLowerCase() === "blob") {
      console.warn(
        "[ai-radar] STORAGE_BACKEND=blob is set outside a production build: reads and writes go to the Vercel Blob store.",
      );
    }
    cachedBackend = createBlobBackend({
      pathname: blobPathname(),
      access: blobAccess(),
      token: process.env.BLOB_READ_WRITE_TOKEN?.trim(),
    });
    return cachedBackend;
  }

  if (process.env.VERCEL) {
    console.warn(
      "[ai-radar] STORAGE_BACKEND=local on a serverless deployment: the filesystem is ephemeral and read-only outside /tmp, " +
        "so scans and settings will not persist. Connect a Blob store instead.",
    );
  }

  cachedBackend = createLocalBackend({ dir: dataDirectory(), fileName: DB_FILE_NAME });
  return cachedBackend;
}

/** Drop the memoised backend + warn-once state (used by tests). */
export function resetStorageBackend(): void {
  cachedBackend = null;
}

/**
 * Test seam: install a backend instead of resolving one from the environment.
 * Only the test suite uses this (to inject deterministic contention); normal
 * code always goes through {@link resolveStorageBackend}.
 */
export function setStorageBackendForTesting(backend: StorageBackend | null): void {
  cachedBackend = backend;
}

/** Non-secret storage summary for logs and `/api/health`. */
export function describeStorage(): { kind: StorageBackendKind; label: string; reason: string; detail: Record<string, string | number | boolean> } {
  const target = resolveStorageTarget();
  try {
    const backend = resolveStorageBackend();
    return { kind: backend.kind, label: backend.label, reason: target.reason, detail: backend.describe() };
  } catch (error) {
    return {
      kind: target.kind,
      label: target.kind === "blob" ? `vercel-blob:${blobPathname()}` : DB_FILE_NAME,
      reason: target.reason,
      detail: { error: error instanceof Error ? error.message : "storage unavailable" },
    };
  }
}

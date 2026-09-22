import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  StorageConflictError,
  storageErrorMessage,
  type DocumentMeta,
  type StorageBackend,
  type StoredDocument,
  type WriteOptions,
  type WriteResult,
} from "./types";

/**
 * Local development backend: the existing `data/db.json` file.
 *
 * Writes stay atomic (temp file + rename) exactly as before, and the version
 * token is derived from the file itself (`<size>:<mtimeMs>`), so a CLI scan
 * running next to `npm run dev` is detected instead of being overwritten.
 *
 * `readSync()`/`statSync()` exist on purpose: in local development the store
 * hydrates synchronously, which keeps the app's synchronous store API working
 * with zero `await` changes when no Blob store is configured.
 */

const TMP_SUFFIX = ".tmp";

export interface LocalBackendOptions {
  /** Absolute directory that holds the JSON document. */
  dir: string;
  /** File name inside that directory, e.g. `db.json`. */
  fileName: string;
}

export interface LocalStorageBackend extends StorageBackend {
  readonly kind: "local";
  /** Absolute path of the document. */
  readonly file: string;
  readSync(): StoredDocument | null;
  statSync(): DocumentMeta | null;
}

export function createLocalBackend({ dir, fileName }: LocalBackendOptions): LocalStorageBackend {
  const file = path.join(dir, fileName);
  const label = path.join(path.relative(process.cwd(), dir) || dir, fileName).replace(/\\/g, "/");

  function readMeta(): DocumentMeta | null {
    if (!existsSync(file)) return null;
    const stats = statSync(file);
    return {
      etag: `${stats.size}:${stats.mtimeMs}`,
      size: stats.size,
      updatedAt: new Date(stats.mtimeMs).toISOString(),
    };
  }

  function readDocumentSync(): StoredDocument | null {
    if (!existsSync(file)) return null;
    const json = readFileSync(file, "utf8");
    const meta = readMeta() ?? { etag: `0:${Date.now()}`, size: json.length, updatedAt: null };
    return { meta, json };
  }

  return {
    kind: "local",
    label,
    file,

    readSync: readDocumentSync,
    statSync: readMeta,

    async read(): Promise<StoredDocument | null> {
      return readDocumentSync();
    },

    async stat(): Promise<DocumentMeta | null> {
      return readMeta();
    },

    async write(json: string, { expectedEtag }: WriteOptions): Promise<WriteResult> {
      const current = readMeta();

      // Optimistic concurrency: the caller tells us which version it edited.
      if (expectedEtag === null) {
        if (current) {
          throw new StorageConflictError(`${label} already exists; refusing to overwrite it`, "local");
        }
      } else if (!current) {
        throw new StorageConflictError(`${label} was removed since it was read`, "local");
      } else if (current.etag !== expectedEtag) {
        throw new StorageConflictError(`${label} changed on disk since it was read`, "local");
      }

      mkdirSync(dir, { recursive: true });
      const tmp = `${file}${TMP_SUFFIX}`;
      writeFileSync(tmp, json, "utf8");
      renameSync(tmp, file);

      const written = readMeta();
      return { meta: written ?? { etag: expectedEtag ?? `${json.length}:${Date.now()}`, size: json.length, updatedAt: null } };
    },

    async quarantine(reason: string, json: string): Promise<string | null> {
      // Runs synchronously before the returned promise resolves: callers that
      // hydrate synchronously (local development) can rely on the backup
      // already being in place. Same behaviour as before this refactor — the
      // unreadable file is moved aside, never deleted.
      void json;
      try {
        const target = `${file}.corrupt-${Date.now()}`;
        renameSync(file, target);
        return target;
      } catch (error) {
        console.warn(`[ai-radar] could not move the unreadable store aside (${reason}): ${storageErrorMessage(error)}`);
        return null;
      }
    },

    describe(): Record<string, string | number | boolean> {
      const meta = readMeta();
      return {
        kind: "local",
        label,
        file,
        exists: meta !== null,
        sizeBytes: meta?.size ?? 0,
        modifiedAt: meta?.updatedAt ?? "",
      };
    },
  };
}

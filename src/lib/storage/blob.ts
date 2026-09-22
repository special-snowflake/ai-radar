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
 * Production backend: Vercel Blob (`news.json`).
 *
 * The SDK is loaded lazily (`await import("@vercel/blob")`) so the Blob client
 * — and its `undici` transport — never lands in a bundle that does not need it,
 * and so local development can run without a Blob store at all.
 *
 * Concurrency: writes are conditional. When we know the version we edited we
 * send it as `ifMatch` (the Blob API rejects the write with a precondition
 * failure if someone else moved the document on), and the first write of a new
 * document passes `allowOverwrite: false` so two fresh writers cannot both
 * create it. `src/lib/store.ts` turns those failures into a rebase + retry.
 */

/** Vercel Blob rejects a cache max-age below one minute. */
const CACHE_MAX_AGE_SECONDS = 60;
const JSON_CONTENT_TYPE = "application/json";

export type BlobAccess = "public" | "private";

export interface BlobBackendOptions {
  /** Path inside the store, default `news.json`. */
  pathname: string;
  /** Must match the access mode of the Blob store itself. */
  access: BlobAccess;
  /** Explicit token; omit to use `BLOB_READ_WRITE_TOKEN`/OIDC credentials. */
  token?: string;
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "BlobNotFoundError" || /not found/i.test(error.message);
}

function isConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "BlobPreconditionFailedError") return true;
  // `put(..., { allowOverwrite: false })` on an existing pathname.
  return /already exists/i.test(error.message);
}

export function createBlobBackend({ pathname, access, token }: BlobBackendOptions): StorageBackend {
  const label = `vercel-blob:${pathname}`;
  const credentials = () => (token ? { token } : {});

  return {
    kind: "blob",
    label,

    async read(): Promise<StoredDocument | null> {
      const { get } = await import("@vercel/blob");
      let result: Awaited<ReturnType<typeof get>>;
      try {
        result = await get(pathname, { access, useCache: false, ...credentials() });
      } catch (error) {
        throw new Error(`failed to read ${label}: ${storageErrorMessage(error)}`);
      }
      if (!result) return null;

      const json = await new Response(result.stream).text();
      return {
        meta: {
          etag: result.blob.etag || `blob:${result.blob.uploadedAt.getTime()}`,
          size: result.blob.size ?? textByteLength(json),
          updatedAt: result.blob.uploadedAt.toISOString(),
        },
        json,
      };
    },

    async stat(): Promise<DocumentMeta | null> {
      const { head } = await import("@vercel/blob");
      try {
        const info = await head(pathname, credentials());
        return {
          etag: info.etag || `blob:${info.uploadedAt.getTime()}`,
          size: info.size,
          updatedAt: info.uploadedAt.toISOString(),
        };
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw new Error(`failed to inspect ${label}: ${storageErrorMessage(error)}`);
      }
    },

    async write(json: string, { expectedEtag }: WriteOptions): Promise<WriteResult> {
      const { put } = await import("@vercel/blob");
      const shared = {
        access,
        contentType: JSON_CONTENT_TYPE,
        addRandomSuffix: false,
        cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
        ...credentials(),
      };

      try {
        const result = expectedEtag === null
          ? await put(pathname, json, { ...shared, allowOverwrite: false })
          : await put(pathname, json, { ...shared, ifMatch: expectedEtag });

        return {
          meta: {
            etag: result.etag || expectedEtag || `blob:${Date.now()}`,
            size: textByteLength(json),
            updatedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        if (isConflictError(error)) {
          throw new StorageConflictError(`${label} changed since it was read`, "blob");
        }
        throw new Error(`failed to write ${label}: ${storageErrorMessage(error)}`);
      }
    },

    async quarantine(reason: string, json: string): Promise<string | null> {
      // Keep an unparseable document instead of overwriting it: the blob API has
      // no rename, so the raw payload is copied to a sibling pathname.
      try {
        const { put } = await import("@vercel/blob");
        const backup = pathname.replace(/(\.[^./]+)?$/, (extension) => `.corrupt-${Date.now()}${extension || ".json"}`);
        await put(backup, json, {
          access,
          contentType: JSON_CONTENT_TYPE,
          addRandomSuffix: false,
          cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
          ...credentials(),
        });
        return backup;
      } catch (error) {
        console.warn(`[ai-radar] could not back up the unreadable store (${reason}): ${storageErrorMessage(error)}`);
        return null;
      }
    },

    describe(): Record<string, string | number | boolean> {
      return {
        kind: "blob",
        label,
        pathname,
        access,
        explicitToken: Boolean(token),
      };
    },
  };
}

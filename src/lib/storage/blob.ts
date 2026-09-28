import {
  PENDING_RECORD_LIMIT,
  StorageConflictError,
  isScanLeaseActive,
  makeScanLeaseRecord,
  storageErrorMessage,
  type DocumentMeta,
  type PendingWriteRecord,
  type ScanLeaseOptions,
  type ScanLeaseRecord,
  type ScanLeaseResult,
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
 * create it. `src/lib/store.ts` turns those failures into a rebase + retry, and
 * writes the rejected change set to a sibling `*.pending-*` key when the retry
 * budget runs out (see {@link StorageBackend.writePending}).
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

/**
 * `@vercel/blob` error classes do not set `name` (an SDK instance reports
 * `name === "Error"`), so classification has to look at the SDK's fixed
 * messages: `BlobNotFoundError` -> "The requested blob does not exist",
 * `BlobPreconditionFailedError` -> "Precondition failed: ETag mismatch.".
 */
function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "BlobNotFoundError" || /does not exist|not found/i.test(error.message);
}

function isConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "BlobPreconditionFailedError") return true;
  // `put(..., { ifMatch })` on a stale ETag, or `put(..., { allowOverwrite: false })`
  // on an existing pathname.
  return /already exists|precondition failed|etag mismatch/i.test(error.message);
}

export function createBlobBackend({ pathname, access, token }: BlobBackendOptions): StorageBackend {
  const label = `vercel-blob:${pathname}`;
  const credentials = () => (token ? { token } : {});

  /**
   * Pending records live next to the document under their own pathname
   * (`news.pending-<id>.json`) so they have an independent lifecycle: writing
   * one can never touch `news.json`, and merging one back is a normal
   * conditional write of the document.
   */
  const pendingMarker = ".pending-";
  const pendingPathname = (id: string) =>
    pathname.replace(/(\.[^./]+)?$/, (extension) => `${pendingMarker}${id}${extension || ".json"}`);
  const pendingPrefix = `${pathname.replace(/(\.[^./]+)$/, "")}${pendingMarker}`;

  /**
   * The lease lives in its own key (`news.lease.json`), written with the same
   * conditional-write primitives as the document: `allowOverwrite: false` for a
   * free slot, `ifMatch` to take over an expired one. The Blob API therefore
   * decides the winner of a simultaneous first boot, not the application.
   */
  const leasePathname = pathname.replace(/(\.[^./]+)?$/, (extension) => `.lease${extension || ".json"}`);

  async function readLease(): Promise<{ record: ScanLeaseRecord; etag: string | null } | null> {
    const { get } = await import("@vercel/blob");
    try {
      const result = await get(leasePathname, { access, useCache: false, ...credentials() });
      if (!result) return null;
      const parsed = JSON.parse(await new Response(result.stream).text()) as ScanLeaseRecord;
      if (!parsed || typeof parsed.holder !== "string") return null;
      return { record: parsed, etag: result.blob.etag || `blob:${result.blob.uploadedAt.getTime()}` };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      console.warn(`[ai-radar] ignoring unreadable scan lease ${leasePathname}: ${storageErrorMessage(error)}`);
      return null;
    }
  }

  async function readPending(path: string): Promise<PendingWriteRecord | null> {
    const { get } = await import("@vercel/blob");
    try {
      const result = await get(path, { access, useCache: false, ...credentials() });
      if (!result) return null;
      const parsed = JSON.parse(await new Response(result.stream).text()) as PendingWriteRecord;
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.document !== "string") return null;
      return parsed;
    } catch (error) {
      console.warn(`[ai-radar] ignoring unreadable pending write ${path}: ${storageErrorMessage(error)}`);
      return null;
    }
  }

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

    async writePending(record: PendingWriteRecord): Promise<string> {
      // Separate pathname, no `ifMatch`: this must succeed even while the
      // document itself is being rewritten by somebody else every few hundred
      // milliseconds — that is exactly the situation it exists for.
      const { put } = await import("@vercel/blob");
      const target = pendingPathname(record.id);
      try {
        await put(target, JSON.stringify(record), {
          access,
          contentType: JSON_CONTENT_TYPE,
          addRandomSuffix: false,
          cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
          ...credentials(),
        });
        return target;
      } catch (error) {
        throw new Error(`failed to keep pending changes for ${label} at ${target}: ${storageErrorMessage(error)}`);
      }
    },

    async listPending(): Promise<PendingWriteRecord[]> {
      const { list } = await import("@vercel/blob");
      let blobs: Awaited<ReturnType<typeof list>>["blobs"];
      try {
        // Ids start with an ISO timestamp, so pathname order is chronological.
        const result = await list({ prefix: pendingPrefix, limit: PENDING_RECORD_LIMIT, ...credentials() });
        blobs = result.blobs;
      } catch (error) {
        throw new Error(`failed to list pending changes for ${label}: ${storageErrorMessage(error)}`);
      }
      const records: PendingWriteRecord[] = [];
      for (const blob of [...blobs].sort((a, b) => b.pathname.localeCompare(a.pathname))) {
        const record = await readPending(blob.pathname);
        if (record) records.push(record);
      }
      return records.slice(0, PENDING_RECORD_LIMIT);
    },

    async resolvePending(id: string): Promise<boolean> {
      const { del } = await import("@vercel/blob");
      const target = pendingPathname(id);
      try {
        await del(target, credentials());
        return true;
      } catch (error) {
        console.warn(`[ai-radar] could not clear pending changes at ${target}: ${storageErrorMessage(error)}`);
        return false;
      }
    },

    async acquireScanLease({ holder, ttlMs, now = Date.now() }: ScanLeaseOptions): Promise<ScanLeaseResult> {
      const { put } = await import("@vercel/blob");
      const shared = {
        access,
        contentType: JSON_CONTENT_TYPE,
        addRandomSuffix: false,
        cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
        ...credentials(),
      };

      const current = await readLease();
      if (current && current.record.holder !== holder && isScanLeaseActive(current.record, now)) {
        return {
          acquired: false,
          record: current.record,
          reason: `held by ${current.record.holder} until ${current.record.expiresAt}`,
        };
      }

      const next = makeScanLeaseRecord(holder, ttlMs, now);
      try {
        if (!current) {
          // Nobody holds it: create-only, so exactly one first boot wins.
          await put(leasePathname, JSON.stringify(next), { ...shared, allowOverwrite: false });
        } else {
          // Ours to renew, or expired to take over — both are a conditional
          // write against the version we just read.
          await put(leasePathname, JSON.stringify(next), { ...shared, ifMatch: current.etag ?? undefined });
        }
        return { acquired: true, record: next, reason: null };
      } catch (error) {
        if (!isConflictError(error)) {
          console.warn(`[ai-radar] could not take the scan lease at ${leasePathname}: ${storageErrorMessage(error)}`);
          return { acquired: false, record: current?.record ?? null, reason: storageErrorMessage(error) };
        }
        // Lost the race: report the incumbent rather than pretending to own it.
        const winner = (await readLease())?.record ?? current?.record ?? null;
        return {
          acquired: false,
          record: winner,
          reason: winner ? `held by ${winner.holder} until ${winner.expiresAt}` : "taken by another instance",
        };
      }
    },

    async releaseScanLease({ holder }: { holder: string }): Promise<boolean> {
      const { del } = await import("@vercel/blob");
      const current = await readLease();
      // Only ever delete our own lease: a slow shutdown must not revoke the
      // lease a newer instance already took over.
      if (!current || current.record.holder !== holder) return false;
      try {
        await del(leasePathname, credentials());
        return true;
      } catch (error) {
        if (isNotFoundError(error)) return true;
        console.warn(`[ai-radar] could not release the scan lease at ${leasePathname}: ${storageErrorMessage(error)}`);
        return false;
      }
    },

    describe(): Record<string, string | number | boolean> {
      return {
        kind: "blob",
        label,
        pathname,
        access,
        explicitToken: Boolean(token),
        pendingKeyPattern: `${pendingPrefix}*.json`,
        leasePathname,
      };
    },
  };
}

/**
 * Local backend with artificial latency, installed by the concurrent-writer
 * fixture through `setStorageBackendForTesting`.
 *
 * Why: the plain file backend reads and writes synchronously, so its
 * stat-then-write window is about a microsecond wide and two processes almost
 * never collide — the opposite of production, where `vercel-blob:` needs a
 * network round-trip per `stat`/`put` and the window is tens to hundreds of
 * milliseconds. The delay below reproduces that window so the retry, rebase and
 * durable-fallback paths are genuinely exercised by the test.
 *
 * `kind` is reported as "blob" on purpose: this is an asynchronous,
 * network-shaped backend, not the synchronous local-file one.
 */
import { createLocalBackend } from "../../src/lib/storage/local";
import type {
  DocumentMeta,
  PendingWriteRecord,
  ScanLeaseOptions,
  ScanLeaseResult,
  StorageBackend,
  StoredDocument,
  WriteOptions,
  WriteResult,
} from "../../src/lib/storage/types";

export function createLatentBackend(options: {
  dir: string;
  fileName: string;
  latencyMs?: number;
}): StorageBackend {
  const inner = createLocalBackend({ dir: options.dir, fileName: options.fileName });
  const latencyMs = options.latencyMs ?? 10;

  const slow = async <T>(value: T): Promise<T> => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return value;
  };

  return {
    kind: "blob",
    label: `latent-file:${options.fileName}`,

    read: async (): Promise<StoredDocument | null> => slow(await inner.read()),
    stat: async (): Promise<DocumentMeta | null> => slow(await inner.stat()),
    write: async (json: string, writeOptions: WriteOptions): Promise<WriteResult> =>
      slow(await inner.write(json, writeOptions)),
    quarantine: (reason: string, json: string) => inner.quarantine(reason, json),
    writePending: (record: PendingWriteRecord) => inner.writePending(record),
    listPending: () => inner.listPending(),
    resolvePending: (id: string) => inner.resolvePending(id),
    // The lease is a one-off decision, so it does not need the artificial
    // latency: latency here would only slow the fixture down, not change which
    // process wins.
    acquireScanLease: (options: ScanLeaseOptions): Promise<ScanLeaseResult> => inner.acquireScanLease(options),
    releaseScanLease: (options: { holder: string }): Promise<boolean> => inner.releaseScanLease(options),
    describe: () => ({ ...inner.describe(), latencyMs }),
  };
}

/**
 * One concurrent writer, spawned as its own process by
 * `tests/store-contention.test.ts`.
 *
 * It behaves like the real writers of this app: hydrate the store, then a burst
 * of changes each followed by `await flush()` (a scan batch, a bookmark click,
 * a settings save ...). Two deliberate choices:
 *
 *   - the storage backend is the latency-injecting one, so the stat-then-write
 *     window matches what `vercel-blob:` costs over the network and the writers
 *     really do lose races;
 *   - each change appends a uniquely identifiable article through `mutate`
 *     instead of `insertArticles`, because the scanner's duplicate folding would
 *     legitimately merge same-topic headlines from different writers and the
 *     test could no longer tell "merged" from "lost".
 *
 *   node --import tsx tests/fixtures/concurrent-writer.ts <dataDir> <index> <changes>
 *
 * Prints one JSON line with its contention counters so the test can check that
 * nothing was left in process memory.
 */
import { setStorageBackendForTesting } from "../../src/lib/storage";
import { ensureStoreLoaded, flush, getDb, getStoreStatus, mutate } from "../../src/lib/store";
import { makeArticle } from "./article";
import { createLatentBackend } from "./latent-backend";

const [dataDir, indexRaw, changesRaw] = process.argv.slice(2);
const index = Number(indexRaw ?? "0");
const changes = Number(changesRaw ?? "5");

process.env.DATA_DIR = dataDir;
process.env.STORAGE_BACKEND = "local";
process.env.SEED_ON_EMPTY = "false";

setStorageBackendForTesting(createLatentBackend({ dir: dataDir, fileName: "db.json", latencyMs: 10 }));

async function main(): Promise<void> {
  await ensureStoreLoaded();

  for (let change = 0; change < changes; change += 1) {
    const article = makeArticle({
      id: `writer-${index}-${change}`,
      title: `Writer ${index} change ${change} unique headline ${index * 100 + change}`,
      sourceId: `writer-${index}`,
    });
    mutate((db) => {
      db.articles.push(article);
      db.meta.totalArticlesAdded += 1;
    });
    await flush();
  }

  const status = getStoreStatus();
  console.log(
    JSON.stringify({
      index,
      articles: getDb().articles.length,
      pendingWrites: status.pendingWrites,
      dirty: status.dirty,
      lastError: status.lastError,
      writes: status.contention.writes,
      contended: status.contention.contended,
      contentionRetries: status.contention.contentionRetries,
      giveUps: status.contention.giveUps,
      fallbacksWritten: status.contention.fallbacksWritten,
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[writer ${index}] failed:`, error);
    process.exit(1);
  });

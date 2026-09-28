/**
 * Re-run the intelligence layer over every stored article.
 *
 * Use after editing the taxonomy, the impact signals or the interest profile:
 * `npm run reindex` rewrites categories, tags, entities, impact, relevance and
 * breaking flags for the whole archive without re-fetching any feeds.
 *
 * Runs against whatever the storage abstraction resolves to: `data/db.json`
 * locally, Vercel Blob when `STORAGE_BACKEND=blob` (or a Blob token) is set.
 */
import { ensureStoreLoaded, flush, getDb, recomputeAllArticles } from "../src/lib/store";

async function main(): Promise<void> {
  await ensureStoreLoaded();

  const count = recomputeAllArticles();
  await flush();

  const db = getDb();
  const byCategory = db.articles.reduce<Record<string, number>>((accumulator, article) => {
    accumulator[article.category] = (accumulator[article.category] ?? 0) + 1;
    return accumulator;
  }, {});

  console.log(`[ai-radar] re-scored ${count} articles`);
  console.log(`  categories: ${JSON.stringify(byCategory)}`);
  console.log(`  breaking  : ${db.articles.filter((article) => article.isBreaking).length}`);
}

main().catch((error) => {
  console.error("[ai-radar] reindex failed:", error);
  process.exit(1);
});
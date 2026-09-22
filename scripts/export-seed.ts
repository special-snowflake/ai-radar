/**
 * Snapshot the current store into `data/seed/articles.seed.json`.
 *
 * The seed ships with the repo so a fresh install renders a populated
 * dashboard before the first network scan completes (or when the machine is
 * offline). User-specific state (read / bookmarked) is reset on export.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, ensureStoreLoaded, getDb } from "../src/lib/store";

const LIMIT = Number.parseInt(process.argv[2] ?? "150", 10);

async function main(): Promise<void> {
  await ensureStoreLoaded();

  const db = getDb();
  const articles = db.articles
    .filter((article) => !article.duplicateOf)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, LIMIT)
    .map((article) => ({
      ...article,
      read: false,
      bookmarked: false,
      duplicateOf: null,
    }));

  const target = path.join(dataDir(), "seed", "articles.seed.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: "Offline fallback snapshot produced by `npm run seed:export`. Real scans replace and extend it.",
        count: articles.length,
        articles,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`[ai-radar] exported ${articles.length} articles -> ${target}`);
}

main().catch((error) => {
  console.error("[ai-radar] seed export failed:", error);
  process.exit(1);
});

/**
 * CLI scan: `npm run scan [-- --source=openai-news --no-scheduler]`
 *
 * Useful for cron users who prefer polling from outside the web server, for
 * seeding a fresh install, and for debugging a single feed without waiting for
 * the in-process scheduler.
 */
import { runScan } from "../src/lib/scanner";
import { ensureStoreLoaded, flush, getDb } from "../src/lib/store";

interface CliOptions {
  sourceIds: string[];
  trigger: "cli";
}

function parseArgs(argv: string[]): CliOptions {
  const sourceIds: string[] = [];
  for (const arg of argv) {
    const match = arg.match(/^--source=(.+)$/);
    if (match) sourceIds.push(...match[1].split(",").map((value) => value.trim()).filter(Boolean));
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run scan [-- --source=<sourceId>[,<sourceId>]]");
      process.exit(0);
    }
  }
  return { sourceIds, trigger: "cli" };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Load the store from the configured backend (data/db.json locally, Vercel
  // Blob when the environment selects it) before touching any data.
  await ensureStoreLoaded();
  const before = getDb().articles.length;
  console.log(
    options.sourceIds.length > 0
      ? `[ai-radar] scanning sources: ${options.sourceIds.join(", ")}`
      : "[ai-radar] scanning all enabled sources",
  );

  const run = await runScan({ trigger: options.trigger, sourceIds: options.sourceIds });
  await flush();

  console.log(`\nscan ${run.id} finished in ${run.durationMs}ms`);
  console.log(`  sources : ${run.sourcesOk}/${run.sourcesAttempted} ok, ${run.sourcesFailed} failed`);
  console.log(`  items   : ${run.itemsSeen} seen, ${run.itemsAdded} new, ${run.itemsMerged} merged`);
  console.log(`  breaking: ${run.breakingFound}, alerts fired: ${run.alerted}`);
  console.log(`  store   : ${before} -> ${getDb().articles.length} articles`);

  if (run.errors.length > 0) {
    console.log("\nfeed errors:");
    for (const error of run.errors) console.log(`  - ${error.sourceId}: ${error.message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[ai-radar] scan failed:", error);
    process.exit(1);
  });

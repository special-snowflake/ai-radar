/**
 * Inspect and recover durable pending change sets.
 *
 * A pending record (`news.pending-<id>.json` in Blob, `data/db.json.pending-<id>.json`
 * locally) is a change set a previous process could not write back after losing
 * the compare-and-swap race too often. The app merges them back automatically on
 * the next `ensureStoreLoaded()`, so this script is for the two cases where that
 * is not enough:
 *
 *   - *inspect*: is anything waiting, how old is it, and will it still merge?
 *   - *rescue*: a record that automatic pruning would drop, or a deployment that
 *     has been serving from a stale read.
 *
 *   npm run recover-pending                  # list, then merge back and store
 *   npm run recover-pending -- --list         # report only, change nothing
 *   npm run recover-pending -- --prune        # drop records older than 7 days
 *   npm run recover-pending -- --prune=30     # ... older than 30 days
 *   npm run recover-pending -- --json         # machine-readable output
 *
 * Exit code is non-zero when records remain that could not be recovered, so it can
 * be used as a cron check ("did we lose data?").
 */
import {
  PENDING_RECORD_MAX_AGE_MS,
  pendingRecordAgeMs,
  resolveStorageBackend,
  StorageConfigurationError,
  type PendingWriteRecord,
  type StorageBackend,
} from "../src/lib/storage";
import { ensureStoreLoaded, flush, getStoreStatus, pruneExpiredPendingRecords } from "../src/lib/store";

interface CliOptions {
  action: "list" | "recover" | "prune";
  maxAgeMs: number;
  json: boolean;
}

const USAGE = `Usage: npm run recover-pending [-- --list | --prune[=<days>]] [--json]`;

function parseArgs(argv: string[]): CliOptions {
  let action: CliOptions["action"] = "recover";
  let maxAgeMs = PENDING_RECORD_MAX_AGE_MS;
  let json = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--list") {
      action = "list";
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--prune" || arg.startsWith("--prune=")) {
      action = "prune";
      const days = Number.parseFloat(arg.split("=")[1] ?? "");
      if (Number.isFinite(days) && days > 0) maxAgeMs = days * 86_400_000;
    } else {
      console.error(`[ai-radar] unknown argument ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }

  return { action, maxAgeMs, json };
}

function describe(records: PendingWriteRecord[], now: number) {
  return records.map((record) => {
    const age = pendingRecordAgeMs(record, now);
    return {
      id: record.id,
      createdAt: record.createdAt,
      ageDays: age === null ? null : Math.round((age / 86_400_000) * 10) / 10,
      changes: record.changes,
      attempts: record.attempts,
      reason: record.reason,
      baseEtag: record.baseEtag,
    };
  });
}

function report(records: PendingWriteRecord[], now: number): void {
  if (records.length === 0) {
    console.log("[ai-radar] no pending change sets: nothing was left unpersisted");
    return;
  }
  console.log(`[ai-radar] ${records.length} pending change set(s):\n`);
  for (const row of describe(records, now)) {
    console.log(`  ${row.id}`);
    console.log(
      `    created ${row.createdAt}` +
        (row.ageDays === null ? " (age unknown)" : ` (${row.ageDays}d old)`) +
        ` - ${row.changes} change(s), gave up after ${row.attempts} attempt(s)`,
    );
    console.log(`    reason: ${row.reason}`);
  }
}

async function listRecords(backend: StorageBackend): Promise<PendingWriteRecord[]> {
  try {
    return await backend.listPending();
  } catch (error) {
    throw new Error(`could not list pending changes of ${backend.label}: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let backend: StorageBackend;
  try {
    backend = resolveStorageBackend();
  } catch (error) {
    if (error instanceof StorageConfigurationError) {
      console.error(`[ai-radar] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const before = await listRecords(backend);

  if (options.action === "prune") {
    // The same code path the app runs at hydrate, so a manual prune and the
    // automatic one cannot disagree about what "expired" means.
    const pruned = await pruneExpiredPendingRecords(backend, { maxAgeMs: options.maxAgeMs });
    const after = await listRecords(backend);
    if (options.json) {
      console.log(JSON.stringify({ action: "prune", pruned, remaining: describe(after, Date.now()) }, null, 2));
    } else {
      console.log(
        `[ai-radar] pruned ${pruned.length} change set(s) older than ${Math.round(options.maxAgeMs / 86_400_000)}d`,
      );
      report(after, Date.now());
    }
    // Records still queued are the operator's problem to look at, not a failure
    // of the prune itself.
    process.exit(after.length > 0 ? 1 : 0);
  }

  if (options.action === "list") {
    if (options.json) {
      console.log(JSON.stringify({ action: "list", pending: describe(before, Date.now()) }, null, 2));
    } else {
      report(before, Date.now());
    }
    process.exit(0);
  }

  // recover: the merge happens in ensureStoreLoaded(), the write in flush().
  if (!options.json) report(before, Date.now());
  await ensureStoreLoaded();
  await flush();
  const after = await listRecords(backend);

  const status = getStoreStatus();
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          action: "recover",
          backend: status.backend,
          recovered: before.length - after.length,
          remaining: describe(after, Date.now()),
          lastError: status.lastError,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `\n[ai-radar] recovered ${before.length - after.length} of ${before.length} pending change set(s) into ` +
        `${status.backend.label}`,
    );
    report(after, Date.now());
    if (status.lastError) console.log(`  last storage error: ${status.lastError}`);
    console.log(
      after.length > 0
        ? "  records remain: they could not be merged (the document moved on) - see the reasons above"
        : "  nothing left pending",
    );
  }

  process.exit(after.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("[ai-radar] recover-pending failed:", (error as Error).message);
  process.exit(1);
});


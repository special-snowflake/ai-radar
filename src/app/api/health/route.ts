import { NextResponse } from "next/server";
import { ensureStoreLoaded, getDb, getStoreStatus } from "@/lib/store";
import { getSchedulerSnapshot } from "@/lib/runtime";
import { isScanRunning } from "@/lib/scanner";

export const dynamic = "force-dynamic";

/**
 * Liveness + radar status, handy for uptime checks and the client live pill.
 *
 * `storage` reports which backend is in use (local `data/db.json` or Vercel
 * Blob) plus the last persistence error, which is the first place to look when
 * a deployment cannot read or write its data. The endpoint responds 503 with
 * the same diagnostic when the store could not be loaded.
 */
export async function GET() {
  await ensureStoreLoaded();
  const storage = getStoreStatus();
  const scheduler = getSchedulerSnapshot();

  if (!storage.hydrated) {
    return NextResponse.json(
      {
        status: "degraded",
        service: "ai-radar",
        time: new Date().toISOString(),
        storage,
        scanning: isScanRunning(),
        scheduler,
      },
      { status: 503 },
    );
  }

  const db = getDb();
  return NextResponse.json({
    status: "ok",
    service: "ai-radar",
    time: new Date().toISOString(),
    articles: db.articles.length,
    sources: db.sources.length,
    enabledSources: db.sources.filter((source) => source.enabled).length,
    alerts: db.alerts.length,
    alertEvents: db.alertEvents.length,
    scanning: isScanRunning(),
    scheduler,
    lastScanAt: db.meta.lastScanAt,
    storeUpdatedAt: db.updatedAt,
    summarizer: db.settings.summarizer,
    storage,
  });
}

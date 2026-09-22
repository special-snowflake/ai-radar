import { NextResponse } from "next/server";
import { getRecentRuns, getSchedulerSnapshot } from "@/lib/runtime";
import { startScheduler, stopScheduler } from "@/lib/scheduler";
import { ensureStoreLoaded, flush } from "@/lib/store";
import { isScanRunning, runScan } from "@/lib/scanner";

export const dynamic = "force-dynamic";

/** GET /api/scan - last runs + scheduler state (the dashboard's "radar health"). */
export async function GET() {
  await ensureStoreLoaded();
  return NextResponse.json({
    scanning: isScanRunning(),
    scheduler: getSchedulerSnapshot(),
    runs: getRecentRuns(12),
  });
}

/**
 * POST /api/scan
 *
 * Body (all optional):
 *   { sources?: string[], trigger?: "manual" }  -> run a sweep now (blocking)
 *   { action: "scheduler-start" | "scheduler-stop" } -> toggle the auto-scan loop
 *
 * A sweep returns with the finished run so the "Scan now" button can show
 * progress and then refresh.
 */
export async function POST(request: Request) {
  await ensureStoreLoaded();
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* empty body is fine */
  }

  if (body.action === "scheduler-start" || body.action === "scheduler-stop") {
    if (body.action === "scheduler-start") startScheduler();
    else stopScheduler();
    return NextResponse.json({ scheduler: getSchedulerSnapshot() });
  }

  const sources = Array.isArray(body.sources)
    ? body.sources.filter((id): id is string => typeof id === "string")
    : undefined;

  try {
    const run = await runScan({ trigger: "manual", sourceIds: sources });
    await flush();
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "scan failed" },
      { status: 500 },
    );
  }
}

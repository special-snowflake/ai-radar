/**
 * Next.js instrumentation hook.
 *
 * Runs once per server process (dev and production). This is what makes the
 * radar "continuous": the scan loop lives inside the server rather than
 * depending on an external cron or a separate worker.
 *
 * It also loads the store from the configured backend — local `data/db.json` in
 * development, Vercel Blob in production — before the first request or scan.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureStoreLoaded, getStoreStatus } = await import("./lib/store");
    await ensureStoreLoaded();

    const status = getStoreStatus();
    if (!status.hydrated) {
      console.error(
        `[ai-radar] storage unavailable (${status.lastError ?? "unknown error"}); background scans stay disabled until it recovers`,
      );
      return;
    }
    console.info(`[ai-radar] store ready: ${status.backend.label} (${status.backend.reason})`);

    if (process.env.VERCEL && process.env.ENABLE_SCHEDULER !== "false") {
      console.warn(
        "[ai-radar] in-process scheduler on a serverless deployment: every instance would scan and write. " +
          "Set ENABLE_SCHEDULER=false and trigger POST /api/scan from Vercel Cron instead.",
      );
    }

    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  } catch (error) {
    console.error(`[ai-radar] failed to start scheduler: ${(error as Error).message}`);
  }
}

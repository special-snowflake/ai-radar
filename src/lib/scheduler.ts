import { runScan, isScanRunning } from "./scanner";
import { getSettings } from "./store";
import { hashFloat } from "./text";

/**
 * In-process scan loop.
 *
 * Started from `src/instrumentation.ts`, so both `next dev` and `next start`
 * keep the radar continuously up to date without an external cron. The delay
 * is re-read from the live settings on every cycle (so changing the interval in
 * the UI takes effect immediately) and jittered slightly to avoid hammering
 * feeds on the exact same second every time.
 */

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  enabled: boolean;
  intervalMs: number;
  nextRunAt: number | null;
  startedAt: number | null;
  runs: number;
  lastError: string | null;
}

const globalScheduler = globalThis as unknown as { __aiRadarScheduler?: SchedulerState };

function state(): SchedulerState {
  if (!globalScheduler.__aiRadarScheduler) {
    globalScheduler.__aiRadarScheduler = {
      timer: null,
      enabled: false,
      intervalMs: 0,
      nextRunAt: null,
      startedAt: null,
      runs: 0,
      lastError: null,
    };
  }
  return globalScheduler.__aiRadarScheduler;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

export function schedulerStatus(): {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  startedAt: string | null;
  runs: number;
  running: boolean;
  lastError: string | null;
} {
  const current = state();
  return {
    enabled: current.enabled,
    intervalMinutes: Math.round(current.intervalMs / 60_000),
    nextRunAt: current.nextRunAt ? new Date(current.nextRunAt).toISOString() : null,
    startedAt: current.startedAt ? new Date(current.startedAt).toISOString() : null,
    runs: current.runs,
    running: isScanRunning(),
    lastError: current.lastError,
  };
}

export function startScheduler(): void {
  const current = state();
  if (current.enabled) return;

  if (!envFlag("ENABLE_SCHEDULER", true)) {
    current.enabled = false;
    console.info("[ai-radar] background scheduler disabled via ENABLE_SCHEDULER");
    return;
  }

  current.enabled = true;
  current.startedAt = Date.now();
  const intervalMinutes = Math.max(1, getSettings().scanIntervalMinutes);
  current.intervalMs = intervalMinutes * 60_000;

  console.info(
    `[ai-radar] scheduler online - scanning ${intervalMinutes} enabled-sources window every ${intervalMinutes} minute(s)`,
  );

  if (envFlag("SCAN_ON_START", true)) {
    // Give the server a moment to finish booting before hitting the network.
    const bootTimer = setTimeout(() => {
      void tick("startup");
    }, 4_000);
    bootTimer.unref?.();
  }

  scheduleNext();
}

export function stopScheduler(): void {
  const current = state();
  if (current.timer) clearTimeout(current.timer);
  current.timer = null;
  current.enabled = false;
  current.nextRunAt = null;
}

function scheduleNext(): void {
  const current = state();
  if (!current.enabled) return;

  const intervalMinutes = Math.max(1, getSettings().scanIntervalMinutes);
  current.intervalMs = intervalMinutes * 60_000;

  // +/- 8% jitter keeps bursts spread out across the interval.
  const jitter = (hashFloat(`scan-${current.runs}-${Date.now()}`) - 0.5) * 0.16;
  const delay = Math.round(current.intervalMs * (1 + jitter));

  if (current.timer) clearTimeout(current.timer);
  current.nextRunAt = Date.now() + delay;
  current.timer = setTimeout(() => {
    void tick("scheduler");
  }, delay);
  current.timer.unref?.();
}

async function tick(trigger: "scheduler" | "startup"): Promise<void> {
  const current = state();
  try {
    if (isScanRunning()) {
      console.info("[ai-radar] scan already running, skipping this tick");
    } else {
      const run = await runScan({ trigger });
      console.info(
        `[ai-radar] scan ${run.id} (${run.trigger}) - ${run.itemsAdded} new, ${run.itemsMerged} merged, ` +
          `${run.sourcesFailed} failed in ${run.durationMs}ms`,
      );
    }
    current.lastError = null;
  } catch (error) {
    current.lastError = error instanceof Error ? error.message : String(error);
    console.error(`[ai-radar] scan failed: ${current.lastError}`);
  } finally {
    current.runs += 1;
    scheduleNext();
  }
}

/** Re-plan the next tick immediately (used after the interval setting changes). */
export function reschedule(): void {
  const current = state();
  if (!current.enabled) return;
  scheduleNext();
}

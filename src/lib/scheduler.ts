import { hostname } from "node:os";
import { runScan, isScanRunning } from "./scanner";
import { getSettings } from "./store";
import { resolveStorageBackend } from "./storage";
import { hashFloat } from "./text";

/**
 * In-process scan loop.
 *
 * Started from `src/instrumentation.ts`, so both `next dev` and `next start`
 * keep the radar continuously up to date without an external cron. The delay
 * is re-read from the live settings on every cycle (so changing the interval in
 * the UI takes effect immediately) and jittered slightly to avoid hammering
 * feeds on the exact same second every time.
 *
 * On a serverless platform this loop would run in *every* instance, so the
 * default is a lease: the first instance to boot takes it (see
 * {@link scanLeaseStatus}) and only the lease holder scans. The others stay
 * warm for requests but idle, which is what the platform is for. Set
 * `SCAN_LEASE=false` to get the old every-instance-scans behaviour back (correct
 * for a single long-lived Node server, wrong for serverless).
 */

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  enabled: boolean;
  intervalMs: number;
  nextRunAt: number | null;
  startedAt: number | null;
  runs: number;
  lastError: string | null;
  /** Lease bookkeeping, so `/api/health` can explain why nothing is scanning. */
  lease: {
    /** False when `SCAN_LEASE=false` — every instance scans, as before. */
    enabled: boolean;
    /** True while this process is the lease holder and may scan. */
    held: boolean;
    holder: string | null;
    /** Why the lease is not held (incumbent holder, TTL, storage error). */
    reason: string | null;
    expiresAt: string | null;
  };
}

const globalScheduler = globalThis as unknown as {
  __aiRadarScheduler?: SchedulerState;
  __aiRadarLeaseHolder?: string;
};

/**
 * Identity of this process in the lease record: `<hostname>-<pid>`.
 *
 * Deliberately boring and non-secret. Two processes on the same host differ by
 * pid; two hosts differ by hostname. It is stored in the backend and shown in
 * `/api/health`, so it must never contain a token or a path.
 */
function leaseHolder(): string {
  if (!globalScheduler.__aiRadarLeaseHolder) {
    let host = "host";
    try {
      host = hostname().split(".")[0] || "host";
    } catch {
      // `hostname()` is unavailable in a few sandboxes; the pid still differs.
    }
    globalScheduler.__aiRadarLeaseHolder = `${host}-${process.pid ?? 0}`;
  }
  return globalScheduler.__aiRadarLeaseHolder;
}

/** Lease lifetime; `SCAN_LEASE_TTL_MS` overrides it. Long enough to cover one scan. */
export const SCAN_LEASE_TTL_MS = 10 * 60_000;

function leaseTtlMs(): number {
  return envInt("SCAN_LEASE_TTL_MS", SCAN_LEASE_TTL_MS, 30_000, 6 * 60 * 60_000);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

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
      lease: { enabled: true, held: false, holder: null, reason: null, expiresAt: null },
    };
  }
  return globalScheduler.__aiRadarScheduler;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

/** Whether the scan loop is gated behind a lease. `SCAN_LEASE=false` opts out. */
export function scanLeaseEnabled(): boolean {
  return envFlag("SCAN_LEASE", true);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Take (or renew) the scan lease.
 *
 * The winner is decided by the backend's compare-and-swap, not by this process:
 * every instance that boots calls this, and exactly one gets `acquired: true`
 * for a free or expired lease. Renewal is the same call — a holder that calls
 * it again simply extends its own `expiresAt`.
 *
 * When the lease cannot be consulted (storage down, misconfigured backend) this
 * returns "not acquired" rather than scanning anyway: an unpersisted scan is
 * worse than a late one, and the store would reject the write anyway. The reason
 * is surfaced in `/api/health` so the cause is visible instead of silent.
 */
export async function acquireScanLease(): Promise<{ acquired: boolean; reason: string | null }> {
  const current = state();

  if (!scanLeaseEnabled()) {
    current.lease = { enabled: false, held: true, holder: null, reason: null, expiresAt: null };
    return { acquired: true, reason: null };
  }

  let backend;
  try {
    backend = resolveStorageBackend();
  } catch (error) {
    current.lease = { enabled: true, held: false, holder: null, reason: errorMessage(error), expiresAt: null };
    return { acquired: false, reason: errorMessage(error) };
  }

  const holder = leaseHolder();
  try {
    const result = await backend.acquireScanLease({ holder, ttlMs: leaseTtlMs() });
    current.lease = {
      enabled: true,
      held: result.acquired,
      holder: result.acquired ? holder : (result.record?.holder ?? null),
      reason: result.reason,
      expiresAt: result.record?.expiresAt ?? null,
    };
    return { acquired: result.acquired, reason: result.reason };
  } catch (error) {
    current.lease = { enabled: true, held: false, holder: null, reason: errorMessage(error), expiresAt: null };
    return { acquired: false, reason: errorMessage(error) };
  }
}

/** Give the lease back on a clean shutdown so the next instance can start at once. */
export async function releaseScanLease(): Promise<void> {
  const current = state();
  if (!current.lease.enabled || !current.lease.held) return;
  try {
    await resolveStorageBackend().releaseScanLease({ holder: leaseHolder() });
  } catch (error) {
    // A lease we cannot release simply expires; the TTL is the real safety net.
    console.warn(`[ai-radar] could not release the scan lease: ${errorMessage(error)}`);
  } finally {
    current.lease = { ...current.lease, held: false, expiresAt: null };
  }
}

/** Lease view for `/api/health` and the settings panel. */
export function scanLeaseStatus(): {
  enabled: boolean;
  held: boolean;
  holder: string | null;
  reason: string | null;
  expiresAt: string | null;
} {
  const current = state();
  return { ...current.lease, enabled: scanLeaseEnabled() };
}

export function schedulerStatus(): {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  startedAt: string | null;
  runs: number;
  running: boolean;
  lastError: string | null;
  lease: ReturnType<typeof scanLeaseStatus>;
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
    lease: scanLeaseStatus(),
  };
}

/**
 * Start the loop.
 *
 * The lease is taken asynchronously, so the first tick waits for it: an
 * instance that loses must never fire a scan, not even the startup one. The
 * winner keeps the lease alive by renewing it on every tick, which is why the
 * renewal lives in {@link tick} rather than in a timer of its own — a tick that
 * cannot renew has no reason to scan either.
 */
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

  void (async () => {
    const lease = await acquireScanLease();
    if (!current.enabled) return; // stopped while the lease call was in flight
    if (!lease.acquired) {
      console.warn(
        `[ai-radar] scan lease is ${lease.reason ?? "unavailable"}; this instance stays idle and serves requests only. ` +
          `The lease expires after ${Math.round(leaseTtlMs() / 1000)}s, so a frozen holder cannot park scanning forever.`,
      );
    }

    if (envFlag("SCAN_ON_START", true)) {
      // Give the server a moment to finish booting before hitting the network.
      const bootTimer = setTimeout(() => {
        void tick("startup");
      }, 4_000);
      bootTimer.unref?.();
    }

    scheduleNext();
  })();
}

export function stopScheduler(): void {
  const current = state();
  if (current.timer) clearTimeout(current.timer);
  current.timer = null;
  current.enabled = false;
  current.nextRunAt = null;
  // Hand the lease back so the next instance can start scanning immediately
  // rather than idling until the TTL runs out.
  void releaseScanLease();
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

  // Renew first: this call takes the lease if it is free or expired, and simply
  // extends it if we already hold it. Either way it re-checks that we are still
  // the one instance allowed to scan — a lease lost to a takeover stops the
  // loop instead of racing the new holder.
  const lease = await acquireScanLease();
  if (!lease.acquired) {
    console.info(`[ai-radar] skipping this tick: scan lease is ${lease.reason ?? "unavailable"}`);
    current.runs += 1;
    scheduleNext();
    return;
  }

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

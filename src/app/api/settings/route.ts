import { NextResponse } from "next/server";
import { getSettingsSnapshot } from "@/lib/runtime";
import { ensureStoreLoaded, flush, recomputeAllArticles, updateSettings } from "@/lib/store";
import { reschedule } from "@/lib/scheduler";
import { isCategoryId } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureStoreLoaded();
  return NextResponse.json({ settings: getSettingsSnapshot() });
}

/**
 * PATCH /api/settings
 *
 * Accepts any subset of RadarSettings. When interests / categoryWeights change
 * the stored articles are re-scored so the relevance ranking stays coherent,
 * and the scheduler is re-planned when the interval changes.
 */
export async function PATCH(request: Request) {
  await ensureStoreLoaded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  const clampNumber = (value: unknown, min: number, max: number): number | undefined => {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(max, Math.max(min, parsed));
  };

  const interval = clampNumber(payload.scanIntervalMinutes, 1, 24 * 60);
  if (interval !== undefined) patch.scanIntervalMinutes = interval;
  const concurrency = clampNumber(payload.scanConcurrency, 1, 16);
  if (concurrency !== undefined) patch.scanConcurrency = concurrency;
  const timeout = clampNumber(payload.fetchTimeoutMs, 3_000, 60_000);
  if (timeout !== undefined) patch.fetchTimeoutMs = timeout;
  const perSource = clampNumber(payload.maxItemsPerSource, 5, 100);
  if (perSource !== undefined) patch.maxItemsPerSource = perSource;
  const maxArticles = clampNumber(payload.maxArticles, 200, 20_000);
  if (maxArticles !== undefined) patch.maxArticles = maxArticles;
  const breakingImpact = clampNumber(payload.breakingImpactThreshold, 40, 99);
  if (breakingImpact !== undefined) patch.breakingImpactThreshold = breakingImpact;
  const breakingWindow = clampNumber(payload.breakingWindowHours, 1, 72);
  if (breakingWindow !== undefined) patch.breakingWindowHours = breakingWindow;

  if (payload.summarizer === "extractive" || payload.summarizer === "llm") {
    patch.summarizer = payload.summarizer;
  }
  if (typeof payload.noiseFilter === "boolean") patch.noiseFilter = payload.noiseFilter;
  if (typeof payload.collapseDuplicates === "boolean") {
    patch.collapseDuplicates = payload.collapseDuplicates;
  }

  if (Array.isArray(payload.interests)) {
    patch.interests = payload.interests
      .filter((interest): interest is { keyword?: unknown; weight?: unknown } => Boolean(interest))
      .map((interest) => ({
        keyword: String(interest.keyword ?? ""),
        weight: Number(interest.weight ?? 1),
      }))
      .filter((interest) => interest.keyword.trim().length > 0);
  }

  if (payload.categoryWeights && typeof payload.categoryWeights === "object") {
    const weights: Record<string, number> = {};
    for (const [key, value] of Object.entries(payload.categoryWeights as Record<string, unknown>)) {
      if (!isCategoryId(key)) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) weights[key] = Math.min(15, Math.max(0, parsed));
    }
    patch.categoryWeights = weights;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const settings = updateSettings(patch as never);
  let rescored = 0;
  if (patch.interests || patch.categoryWeights || patch.breakingImpactThreshold || patch.breakingWindowHours) {
    rescored = recomputeAllArticles();
  }
  if (patch.scanIntervalMinutes) reschedule();
  await flush();

  return NextResponse.json({ settings, rescored });
}

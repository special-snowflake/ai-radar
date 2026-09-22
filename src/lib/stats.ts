import { categoryMeta, CATEGORY_IDS } from "./types";
import type { AlertEvent, AlertRule, Article, FacetCount, RadarSettings, RadarStats, ScanRun, Source } from "./types";

/**
 * Analytics for the dashboard: volume, distribution and scanning health.
 * Pure functions over the store snapshot so they are trivially unit testable.
 */

const TIMELINE_DAYS = 30;

function dayKey(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return date.toISOString().slice(0, 10);
}

export interface StatsInput {
  articles: Article[];
  sources: Source[];
  alerts: AlertRule[];
  runs: ScanRun[];
  settings: RadarSettings;
  alertEvents: AlertEvent[];
  meta: { lastScanAt: string | null; lastScanTrigger: ScanRun["trigger"] | null; scansCompleted: number };
  schedulerEnabled: boolean;
  nextScanAt: string | null;
}

export function computeStats(input: StatsInput): RadarStats {
  const { articles, sources, alerts, runs, settings } = input;
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const weekAgo = now - 7 * 86_400_000;

  const categoryCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const sentimentCounts = new Map<string, number>();
  const weeklySourceCounts = new Map<string, number>();
  const timeline = new Map<string, { count: number; impact: number }>();

  for (let offset = TIMELINE_DAYS - 1; offset >= 0; offset -= 1) {
    timeline.set(dayKey(new Date(now - offset * 86_400_000)), { count: 0, impact: 0 });
  }

  let unread = 0;
  let breaking = 0;
  let bookmarked = 0;
  let last24h = 0;
  let last7d = 0;

  for (const article of articles) {
    if (article.duplicateOf) continue;
    categoryCounts.set(article.category, (categoryCounts.get(article.category) ?? 0) + 1);
    sourceCounts.set(article.sourceId, (sourceCounts.get(article.sourceId) ?? 0) + 1);
    for (const tag of article.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    sentimentCounts.set(article.sentiment, (sentimentCounts.get(article.sentiment) ?? 0) + 1);
    if (!article.read) unread += 1;
    if (article.isBreaking) breaking += 1;
    if (article.bookmarked) bookmarked += 1;

    const published = Date.parse(article.publishedAt);
    if (published >= dayAgo) last24h += 1;
    if (published >= weekAgo) {
      last7d += 1;
      weeklySourceCounts.set(article.sourceId, (weeklySourceCounts.get(article.sourceId) ?? 0) + 1);
    }

    const key = dayKey(article.publishedAt);
    const bucket = timeline.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.impact += article.impact;
    }
  }

  const sourceLabels = new Map(sources.map((source) => [source.id, source.name]));

  const byCategory: FacetCount[] = CATEGORY_IDS.map((id) => ({
    id,
    label: categoryMeta(id).short,
    count: categoryCounts.get(id) ?? 0,
    accent: categoryMeta(id).accent,
  }));

  const bySource: FacetCount[] = [...sourceCounts.entries()]
    .map(([id, count]) => ({ id, label: sourceLabels.get(id) ?? id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const topTags: FacetCount[] = [...tagCounts.entries()]
    .map(([id, count]) => ({ id, label: id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const healthySources = sources.filter((source) => source.lastStatus === "ok").length;
  const failingSources = sources.filter((source) => source.lastStatus === "error").length;
  const averageScanMs =
    runs.length > 0 ? Math.round(runs.reduce((total, run) => total + run.durationMs, 0) / runs.length) : 0;

  const nonDuplicates = articles.filter((article) => !article.duplicateOf);
  const duplicates = articles.length - nonDuplicates.length;
  const weeklyBySource: FacetCount[] = [...weeklySourceCounts.entries()]
    .map(([id, count]) => ({ id, label: sourceLabels.get(id) ?? id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totals: {
      articles: nonDuplicates.length,
      sources: sources.length,
      enabledSources: sources.filter((source) => source.enabled).length,
      alerts: alerts.filter((rule) => rule.enabled).length,
      unread,
      breaking,
      bookmarked,
    },
    total: nonDuplicates.length,
    unread,
    read: nonDuplicates.length - unread,
    duplicates,
    breaking,
    bookmarked,
    sourcesOk: healthySources,
    sourcesTotal: sources.length,
    last24h,
    last7d,
    byCategory,
    bySource,
    weeklyBySource,
    topTags,
    timeline: [...timeline.entries()].map(([date, value]) => ({
      date,
      count: value.count,
      impact: value.count > 0 ? Math.round(value.impact / value.count) : 0,
    })),
    scanning: {
      lastScanAt: input.meta.lastScanAt,
      lastScanTrigger: input.meta.lastScanTrigger,
      scansCompleted: input.meta.scansCompleted,
      intervalMinutes: settings.scanIntervalMinutes,
      schedulerEnabled: input.schedulerEnabled,
      nextScanAt: input.nextScanAt,
      healthySources,
      failingSources,
      averageScanMs,
    },
    sentiment: [...sentimentCounts.entries()].map(([label, count]) => ({
      label: label as RadarStats["sentiment"][number]["label"],
      count,
    })),
  };
}

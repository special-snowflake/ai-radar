import { applyUpdateQuery } from "./query";
import { schedulerStatus } from "./scheduler";
import { computeStats } from "./stats";
import { getDb, getSettings, getSource } from "./store";
import type {
  AlertEvent,
  AlertRule,
  Article,
  CategoryId,
  RadarSettings,
  RadarStats,
  ScanRun,
  Source,
  SourceHealth,
  UpdateQuery,
  UpdateQueryResult,
} from "./types";
import { categoryMeta } from "./types";
import { SOURCE_KIND_LABEL } from "./format";

/**
 * Server-side data access facade used by the pages, route handlers and the
 * CLI. Keeping it in one place means the UI never touches the store directly
 * and every read benefits from the same derived ordering/analytics.
 */

export function getStatsSnapshot(): RadarStats {
  const db = getDb();
  const scheduler = schedulerStatus();
  return computeStats({
    articles: db.articles,
    sources: db.sources,
    alerts: db.alerts,
    runs: db.runs,
    settings: db.settings,
    alertEvents: db.alertEvents,
    meta: db.meta,
    schedulerEnabled: scheduler.enabled,
    nextScanAt: scheduler.nextRunAt,
  });
}

export function getUpdates(query: UpdateQuery = {}): UpdateQueryResult {
  const db = getDb();
  const settings = db.settings;
  return applyUpdateQuery(db.articles, {
    ...query,
    collapseDuplicates: query.collapseDuplicates ?? settings.collapseDuplicates,
  });
}

export function getBreakingUpdates(limit = 6): Article[] {
  return getUpdates({ breakingOnly: true, sort: "newest", pageSize: limit }).items;
}

export function getSourcesWithHealth(): SourceHealth[] {
  const db = getDb();
  const weekAgo = Date.now() - 7 * 86_400_000;
  const articlesBySource = new Map<string, Article[]>();
  for (const article of db.articles) {
    const bucket = articlesBySource.get(article.sourceId);
    if (bucket) bucket.push(article);
    else articlesBySource.set(article.sourceId, [article]);
  }
  const latenciesBySource = new Map<string, number[]>();
  for (const run of db.runs.slice(0, 8)) {
    for (const result of run.results) {
      const bucket = latenciesBySource.get(result.sourceId);
      if (bucket) bucket.push(result.durationMs);
      else latenciesBySource.set(result.sourceId, [result.durationMs]);
    }
  }

  return [...db.sources]
    .map((source) => {
      const articles = articlesBySource.get(source.id) ?? [];
      const latencies = latenciesBySource.get(source.id) ?? [];
      const beat = source.beats[0] as CategoryId | undefined;
      return {
        ...source,
        articleCount: articles.length,
        articles7d: articles.filter((article) => Date.parse(article.publishedAt) >= weekAgo).length,
        averageLatencyMs:
          latencies.length > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
        category: beat ? categoryMeta(beat).short : (SOURCE_KIND_LABEL[source.kind] ?? source.kind),
        intervalMinutes: Math.max(1, db.settings.scanIntervalMinutes),
      };
    })
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.name.localeCompare(b.name);
    });
}

export function getAlertRules(): AlertRule[] {
  return [...getDb().alerts].sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

export interface AlertEventView {
  event: AlertEvent;
  article: Article | null;
  rule: AlertRule | null;
}

export function getAlertFeed(limit = 60, unreadOnly = false): AlertEventView[] {
  const db = getDb();
  const articlesById = new Map(db.articles.map((article) => [article.id, article]));
  const rulesById = new Map(db.alerts.map((rule) => [rule.id, rule]));
  return db.alertEvents
    .filter((event) => (unreadOnly ? !event.read : true))
    .slice(0, limit)
    .map((event) => ({
      event,
      article: articlesById.get(event.articleId) ?? null,
      rule: rulesById.get(event.ruleId) ?? null,
    }));
}

export function getRecentRuns(limit = 12): ScanRun[] {
  return getDb().runs.slice(0, limit);
}

export function getSettingsSnapshot(): RadarSettings {
  return getSettings();
}

export interface ScanStatusSnapshot {
  scanning: boolean;
  lastScanAt: string | null;
  scansCompleted: number;
  sourcesFailed: number;
  enabled: boolean;
  nextRunAt: string | null;
  intervalMinutes: number;
}

export function getSchedulerSnapshot() {
  return schedulerStatus();
}

/** Shape consumed by the settings panel (scheduler plus the most recent run). */
export function getScanStatusSnapshot(): ScanStatusSnapshot {
  const db = getDb();
  const scheduler = schedulerStatus();
  const lastRun = db.runs[0];
  return {
    scanning: scheduler.running,
    lastScanAt: db.meta.lastScanAt,
    scansCompleted: db.meta.scansCompleted,
    sourcesFailed: lastRun?.sourcesFailed ?? 0,
    enabled: scheduler.enabled,
    nextRunAt: scheduler.nextRunAt,
    intervalMinutes: scheduler.intervalMinutes,
  };
}

export interface ArticleDetail {
  article: Article;
  source: Source | null;
  related: Article[];
  coverage: {
    id: string;
    sourceId: string;
    sourceName: string;
    title: string;
    publishedAt: string;
  }[];
}

export function getArticleDetail(id: string): ArticleDetail | null {
  const db = getDb();
  const article = db.articles.find((candidate) => candidate.id === id);
  if (!article) return null;

  const related = db.articles
    .filter(
      (candidate) =>
        candidate.id !== article.id &&
        !candidate.duplicateOf &&
        (candidate.category === article.category ||
          candidate.tags.some((tag) => article.tags.includes(tag)) ||
          candidate.entities.companies.some((company) => article.entities.companies.includes(company))),
    )
    .sort((a, b) => {
      const shared = (candidate: Article) =>
        candidate.tags.filter((tag) => article.tags.includes(tag)).length +
        candidate.entities.companies.filter((company) => article.entities.companies.includes(company)).length;
      return shared(b) - shared(a) || b.impact - a.impact;
    })
    .slice(0, 5);

  const duplicates = db.articles
    .filter((candidate) => candidate.duplicateOf === article.id || candidate.id === article.duplicateOf)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 8);

  const coverage = [article, ...duplicates]
    .map((item) => ({
      id: item.id,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      title: item.title,
      publishedAt: item.publishedAt,
    }))
    .filter((entry, index, list) => list.findIndex((other) => other.id === entry.id) === index);

  return {
    article,
    source: getSource(article.sourceId) ?? null,
    related,
    coverage,
  };
}

export interface DashboardSnapshot {
  stats: RadarStats;
  settings: RadarSettings;
  scheduler: ReturnType<typeof schedulerStatus>;
  runs: ScanRun[];
  breaking: Article[];
  alertUnread: number;
}

export function getDashboardSnapshot(): DashboardSnapshot {
  return {
    stats: getStatsSnapshot(),
    settings: getSettingsSnapshot(),
    scheduler: getSchedulerSnapshot(),
    runs: getRecentRuns(6),
    breaking: getBreakingUpdates(5),
    alertUnread: getDb().alertEvents.filter((event) => !event.read).length,
  };
}

export interface SourceActivity {
  sourceId: string;
  /** Non-duplicate articles stored for this feed. */
  stored: number;
  /** Stored articles published in the last 7 days. */
  last7d: number;
  /** Mean fetch duration from past sweep runs (0 when never measured). */
  averageLatencyMs: number;
}

/** Per-source volume + latency derived from the stored articles and past runs. */
export function getSourceActivity(): SourceActivity[] {
  const db = getDb();
  const weekAgo = Date.now() - 7 * 86_400_000;
  const stored = new Map<string, number>();
  const weekly = new Map<string, number>();

  for (const article of db.articles) {
    if (article.duplicateOf) continue;
    stored.set(article.sourceId, (stored.get(article.sourceId) ?? 0) + 1);
    if (Date.parse(article.publishedAt) >= weekAgo) {
      weekly.set(article.sourceId, (weekly.get(article.sourceId) ?? 0) + 1);
    }
  }

  const latency = new Map<string, { total: number; count: number }>();
  for (const run of db.runs) {
    for (const result of run.results) {
      const entry = latency.get(result.sourceId) ?? { total: 0, count: 0 };
      entry.total += result.durationMs;
      entry.count += 1;
      latency.set(result.sourceId, entry);
    }
  }

  return db.sources.map((source) => {
    const timing = latency.get(source.id);
    return {
      sourceId: source.id,
      stored: stored.get(source.id) ?? 0,
      last7d: weekly.get(source.id) ?? 0,
      averageLatencyMs: timing && timing.count > 0 ? Math.round(timing.total / timing.count) : 0,
    };
  });
}


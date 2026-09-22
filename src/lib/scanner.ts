import { alertEventId, evaluateAlerts } from "./alerts";
import { classifyArticle, isNoiseText } from "./classify";
import { fetchFeed, parseFeed, type FeedItem } from "./rss";
import {
  ensureStoreLoaded,
  flush,
  getAlertEvents,
  getAlerts,
  getSettings,
  getSources,
  insertArticles,
  recordAlertMatches,
  recordRun,
  updateSource,
} from "./store";
import { summarizeArticle } from "./summarize";
import { canonicalizeUrl, hashId, round, truncate, wordCount } from "./text";
import type { Article, ScanRun, ScanSourceResult, Source } from "./types";

/**
 * Scan orchestration.
 *
 * One pass = fetch every enabled feed (bounded concurrency, per-request
 * timeout) -> normalize + drop noise -> classify/score -> store (which folds
 * cross-source duplicates) -> summarize only the items that were actually new
 * -> evaluate alert rules -> persist + log the run.
 *
 * A pass never overlaps with itself: callers arriving while a scan is in flight
 * simply await the running one.
 */

const MAX_ITEM_AGE_DAYS = 45;
const MAX_CANDIDATES_PER_SCAN = 800;
const DEFAULT_USER_AGENT = "ai-radar/1.0 (+https://localhost/ai-radar)";

export interface ScanOptions {
  trigger: ScanRun["trigger"];
  sourceIds?: string[];
  now?: Date;
}

interface GlobalScanState {
  __aiRadarScan?: Promise<ScanRun> | null;
}

const globalScan = globalThis as unknown as GlobalScanState;

export function isScanRunning(): boolean {
  return Boolean(globalScan.__aiRadarScan);
}

/** Run a scan, reusing the in-flight pass if one is already running. */
export async function runScan(options: ScanOptions): Promise<ScanRun> {
  if (globalScan.__aiRadarScan) return globalScan.__aiRadarScan;
  const promise = executeScan(options).finally(() => {
    globalScan.__aiRadarScan = null;
  });
  globalScan.__aiRadarScan = promise;
  return promise;
}

async function executeScan(options: ScanOptions): Promise<ScanRun> {
  // Scans can be triggered by the CLI or the scheduler before any request has
  // been served, so make sure the store is loaded first.
  await ensureStoreLoaded();

  const startedAt = new Date();
  const settings = getSettings();
  const now = options.now ?? startedAt;
  const fetchedAt = now.toISOString();
  const userAgent = process.env.USER_AGENT?.trim() || DEFAULT_USER_AGENT;

  const targets = getSources().filter((source) => {
    if (options.sourceIds && options.sourceIds.length > 0) {
      return options.sourceIds.includes(source.id);
    }
    return source.enabled;
  });

  const results: ScanSourceResult[] = [];
  const candidates: Article[] = [];

  await mapWithConcurrency(targets, Math.max(1, settings.scanConcurrency), async (source) => {
    const result = await scanSource(source, {
      timeoutMs: settings.fetchTimeoutMs,
      maxItems: settings.maxItemsPerSource,
      userAgent,
      now,
      fetchedAt,
      noiseFilter: settings.noiseFilter,
    });
    results.push(result.summary);
    candidates.push(...result.articles);
  });

  // Newest first, then cap so a first run against a deep archive stays sane.
  candidates.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const insert = insertArticles(candidates.slice(0, MAX_CANDIDATES_PER_SCAN));

  // Summarize only what is genuinely new - the expensive step is skipped for
  // items we already know about.
  for (const article of insert.added) {
    const summary = await summarizeArticle(
      {
        title: article.title,
        body: article.excerpt,
        sourceName: article.sourceName,
        focusTerms: article.tags,
        impact: article.impact,
        useLlm: settings.summarizer === "llm",
      },
      { maxSentences: 3, maxKeyPoints: 3 },
    );
    article.summary = summary.summary;
    article.summaryMethod = summary.method;
    article.keyPoints = summary.keyPoints;
    article.readingMinutes = Math.max(1, Math.round(wordCount(summary.summary) / 200));
    article.updatedAt = new Date().toISOString();
  }

  // Alert rules run against fresh articles only, so notifications are real news.
  const seenEvents = new Set(getAlertEvents().map((event) => alertEventId(event.ruleId, event.articleId)));
  const matches = evaluateAlerts(getAlerts(), insert.added, seenEvents, now);
  const alerted = recordAlertMatches(matches);

  const finishedAt = new Date();
  const run: ScanRun = {
    id: hashId("run", startedAt.toISOString(), options.trigger),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    trigger: options.trigger,
    sourcesAttempted: targets.length,
    sourcesOk: results.filter((result) => result.status === "ok").length,
    sourcesFailed: results.filter((result) => result.status === "error").length,
    itemsSeen: results.reduce((total, result) => total + result.items, 0),
    itemsAdded: insert.added.length,
    itemsMerged: insert.merged,
    breakingFound: insert.added.filter((article) => article.isBreaking).length,
    alerted,
    errors: results
      .filter((result) => result.error)
      .map((result) => ({ sourceId: result.sourceId, message: result.error as string })),
    results: [...results].sort((a, b) => a.sourceName.localeCompare(b.sourceName)),
  };

  recordRun(run);
  await flush();
  return run;
}

interface ScanSourceContext {
  timeoutMs: number;
  maxItems: number;
  userAgent: string;
  now: Date;
  fetchedAt: string;
  noiseFilter: boolean;
}

async function scanSource(
  source: Source,
  context: ScanSourceContext,
): Promise<{ summary: ScanSourceResult; articles: Article[] }> {
  const started = Date.now();
  const response = await fetchFeed(source.url, {
    timeoutMs: context.timeoutMs,
    userAgent: context.userAgent,
  });

  if (!response.ok) {
    updateSource(source.id, {
      lastFetchedAt: new Date().toISOString(),
      lastStatus: "error",
      lastError: response.error,
      consecutiveFailures: source.consecutiveFailures + 1,
      lastItemCount: 0,
    });
    return {
      summary: {
        sourceId: source.id,
        sourceName: source.name,
        status: "error",
        items: 0,
        added: 0,
        merged: 0,
        durationMs: Date.now() - started,
        error: response.error,
      },
      articles: [],
    };
  }

  const feed = parseFeed(response.body, source.url);
  const fresh = feed.items
    .filter((item) => {
      const published = item.publishedAt ? Date.parse(item.publishedAt) : context.now.getTime();
      return (context.now.getTime() - published) / 86_400_000 <= MAX_ITEM_AGE_DAYS;
    })
    .sort((a, b) => {
      const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return bTime - aTime;
    })
    .slice(0, context.maxItems);

  const articles = fresh
    .map((item) => normalizeItem(item, source, context))
    .filter((article): article is Article => article !== null);

  updateSource(source.id, {
    lastFetchedAt: new Date().toISOString(),
    lastStatus: feed.items.length === 0 ? "empty" : "ok",
    lastError: null,
    lastItemCount: feed.items.length,
    consecutiveFailures: 0,
  });

  return {
    summary: {
      sourceId: source.id,
      sourceName: source.name,
      status: feed.items.length === 0 ? "empty" : "ok",
      items: feed.items.length,
      added: 0,
      merged: 0,
      durationMs: Date.now() - started,
      error: null,
    },
    articles,
  };
}

/* -------------------------------------------------------------------------- */
/*  Normalization                                                              */
/* -------------------------------------------------------------------------- */

function normalizeItem(
  item: FeedItem,
  source: Source,
  context: ScanSourceContext,
): Article | null {
  const title = item.title.trim();
  if (title.length < 12) return null;

  const body = item.content || item.excerpt || "";
  if (context.noiseFilter && isNoiseText(title, body)) return null;

  const canonicalUrl = item.canonicalUrl || canonicalizeUrl(item.url);
  if (!canonicalUrl) return null;

  const publishedAt = item.publishedAt ?? context.fetchedAt;
  const classification = classifyArticle(
    {
      title,
      body: `${body} ${item.categories.join(" ")}`,
      tier: source.tier,
      sourceKind: source.kind,
      beats: source.beats,
      publishedAt,
      now: context.now,
    },
    getSettings(),
  );

  const excerpt = truncate(item.excerpt || body || title, 460);
  const words = wordCount(body || excerpt);

  return {
    id: hashId("article", canonicalUrl),
    title,
    url: item.url,
    canonicalUrl,
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    author: item.author,
    publishedAt,
    fetchedAt: context.fetchedAt,
    updatedAt: context.fetchedAt,
    excerpt,
    // Placeholder: replaced with the real summary right after insertion.
    summary: truncate(excerpt || title, 320),
    summaryMethod: "excerpt",
    keyPoints: [],
    category: classification.category,
    secondaryCategories: classification.secondaryCategories,
    categoryConfidence: classification.categoryConfidence,
    tags: classification.tags,
    entities: classification.entities,
    impact: classification.impact,
    signals: classification.signals,
    relevance: classification.relevance,
    sentiment: classification.sentiment,
    isBreaking: classification.isBreaking,
    alsoCoveredBy: [],
    read: false,
    bookmarked: false,
    duplicateOf: null,
    wordCount: words,
    readingMinutes: Math.max(1, Math.round(words / 200)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Concurrency helper                                                         */
/* -------------------------------------------------------------------------- */

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
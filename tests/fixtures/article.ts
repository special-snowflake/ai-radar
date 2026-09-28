/**
 * Article fixture shared by `tests/store-contention.test.ts` and the writer
 * processes it spawns. Kept out of the test file so a child process can import
 * it without pulling in `node:test`.
 */
import type { Article } from "../../src/lib/types";

export function makeArticle(
  input: { id: string; title: string; sourceId: string; publishedAt?: string } & Partial<Article>,
): Article {
  const now = new Date().toISOString();
  const rest: Partial<Article> = { ...input };
  delete rest.id;
  delete rest.title;
  delete rest.sourceId;
  delete rest.publishedAt;
  return {
    id: input.id,
    title: input.title,
    url: `https://example.com/${input.id}`,
    canonicalUrl: `https://example.com/${input.id}`,
    sourceId: input.sourceId,
    sourceName: input.sourceId,
    sourceKind: "media",
    author: null,
    publishedAt: input.publishedAt ?? now,
    fetchedAt: now,
    updatedAt: now,
    excerpt: `${input.title} body`,
    summary: `${input.title} summary`,
    summaryMethod: "excerpt",
    keyPoints: [],
    category: "models",
    secondaryCategories: [],
    categoryConfidence: 0.5,
    tags: ["benchmark"],
    entities: { companies: [], models: [], people: [], technologies: [] },
    impact: 50,
    relevance: 50,
    signals: [],
    sentiment: "neutral",
    isBreaking: false,
    alsoCoveredBy: [],
    read: false,
    bookmarked: false,
    duplicateOf: null,
    wordCount: 120,
    readingMinutes: 1,
    ...rest,
  };
}

/** Document body used to seed `<dataDir>/db.json` before a concurrency test. */
export function emptyDocument(articles: Article[] = []): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    articles,
    sources: [],
    alerts: [],
    alertEvents: [],
    runs: [],
    settings: { scanIntervalMinutes: 20, maxArticles: 4000 },
    meta: { lastScanAt: null, lastScanTrigger: null, scansCompleted: 0, totalArticlesAdded: articles.length },
  };
}

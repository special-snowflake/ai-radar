import { CATEGORY_IDS, categoryMeta } from "./types";
import type { Article, FacetCount, SortKey, UpdateQuery, UpdateQueryResult } from "./types";

/**
 * Search + filter engine for the dashboard.
 *
 * A tiny query DSL sits in front of plain filters, so the search box accepts
 * things like:
 *
 *   agents open weights -opinion source:openai-news category:models impact:>=70 is:breaking
 *
 * Everything is evaluated in memory over the (bounded) article set, which keeps
 * the dashboard instant and dependency-free.
 */

export interface ParsedQuery {
  terms: string[];
  phrases: string[];
  excluded: string[];
  filters: {
    sources: string[];
    categories: string[];
    tags: string[];
    minImpact?: number;
    maxImpact?: number;
    after?: number;
    before?: number;
    breaking?: boolean;
    unread?: boolean;
    bookmarked?: boolean;
  };
  raw: string;
}

const RESERVED = /^(source|category|cat|tag|impact|after|before|is|has):/i;

export function parseSearchQuery(input: string | undefined): ParsedQuery {
  const raw = (input ?? "").trim();
  const parsed: ParsedQuery = {
    terms: [],
    phrases: [],
    excluded: [],
    filters: { sources: [], categories: [], tags: [] },
    raw,
  };
  if (!raw) return parsed;

  // Split on whitespace but keep "quoted phrases" intact.
  const tokens = raw.match(/-?"[^"]+"|\S+/g) ?? [];
  for (const token of tokens) {
    let value = token;
    let negated = false;
    if (value.startsWith("-")) {
      negated = true;
      value = value.slice(1);
    }

    const quoted = value.startsWith('"') && value.endsWith('"') && value.length > 2;
    if (quoted) {
      const phrase = value.slice(1, -1).trim().toLowerCase();
      if (phrase) (negated ? parsed.excluded : parsed.phrases).push(phrase);
      continue;
    }

    if (!negated && RESERVED.test(value)) {
      const separator = value.indexOf(":");
      const key = value.slice(0, separator).toLowerCase();
      const argument = value.slice(separator + 1).trim();
      switch (key) {
        case "source":
          parsed.filters.sources.push(argument.toLowerCase());
          continue;
        case "category":
        case "cat":
          parsed.filters.categories.push(argument.toLowerCase());
          continue;
        case "tag":
          parsed.filters.tags.push(argument.toLowerCase());
          continue;
        case "impact": {
          const parts = argument.match(/^(>=|<=|>|<|=)?\s*(\d+)$/);
          if (parts) {
            const amount = Number.parseInt(parts[2], 10);
            const operator = parts[1] ?? "=";
            if (operator === ">=") parsed.filters.minImpact = amount;
            else if (operator === "<=") parsed.filters.maxImpact = amount;
            else if (operator === ">") parsed.filters.minImpact = amount + 1;
            else if (operator === "<") parsed.filters.maxImpact = amount - 1;
            else {
              parsed.filters.minImpact = amount;
              parsed.filters.maxImpact = amount;
            }
          }
          continue;
        }
        case "after": {
          const stamp = Date.parse(argument.length === 10 ? `${argument}T00:00:00Z` : argument);
          if (Number.isFinite(stamp)) parsed.filters.after = stamp;
          continue;
        }
        case "before": {
          const stamp = Date.parse(argument.length === 10 ? `${argument}T23:59:59Z` : argument);
          if (Number.isFinite(stamp)) parsed.filters.before = stamp;
          continue;
        }
        case "is":
        case "has": {
          const flag = argument.toLowerCase();
          if (flag === "breaking") parsed.filters.breaking = true;
          else if (flag === "unread") parsed.filters.unread = true;
          else if (flag === "bookmarked" || flag === "saved") parsed.filters.bookmarked = true;
          continue;
        }
        default:
          break;
      }
    }

    const term = value.toLowerCase();
    if (term) (negated ? parsed.excluded : parsed.terms).push(term);
  }

  return parsed;
}

/* -------------------------------------------------------------------------- */
/*  Text scoring                                                               */
/* -------------------------------------------------------------------------- */

export interface TextScore {
  score: number;
  reasons: string[];
}

const WEIGHTS = {
  titleExact: 12,
  titleTerm: 5,
  tagTerm: 4,
  entityTerm: 3.5,
  summaryTerm: 2.5,
  keyPointTerm: 2,
  excerptTerm: 1.5,
  phraseTitle: 9,
  phraseBody: 4,
};

function countIn(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function scoreArticle(article: Article, parsed: ParsedQuery): TextScore {
  const title = article.title.toLowerCase();
  const summary = article.summary.toLowerCase();
  const excerpt = article.excerpt.toLowerCase();
  const keyPoints = article.keyPoints.join(" ").toLowerCase();
  const tags = article.tags.join(" ").toLowerCase();
  const entities = [
    article.entities.companies.join(" "),
    article.entities.models.join(" "),
    article.entities.people.join(" "),
    article.entities.technologies.join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  const reasons: string[] = [];

  // A pure filter query (e.g. "category:models is:breaking") matches everything.
  if (parsed.terms.length === 0 && parsed.phrases.length === 0) {
    return { score: 1, reasons };
  }

  const wholeQuery = parsed.raw.replace(/^["']|["']$/g, "").toLowerCase();
  if (wholeQuery && title.includes(wholeQuery)) {
    score += WEIGHTS.titleExact;
    reasons.push(`title="${parsed.raw}"`);
  }

  for (const term of parsed.terms) {
    let termScore = 0;
    if (title.includes(term)) {
      termScore += WEIGHTS.titleTerm * (countIn(title, term) > 1 ? 1.4 : 1);
      reasons.push(`title:${term}`);
    }
    if (tags.includes(term)) {
      termScore += WEIGHTS.tagTerm;
      reasons.push(`tag:${term}`);
    }
    if (entities.includes(term)) termScore += WEIGHTS.entityTerm;
    if (summary.includes(term)) termScore += WEIGHTS.summaryTerm;
    if (keyPoints.includes(term)) termScore += WEIGHTS.keyPointTerm;
    if (excerpt.includes(term)) termScore += WEIGHTS.excerptTerm;
    if (termScore === 0) reasons.push(`weak:${term}`);
    score += termScore;
  }

  for (const phrase of parsed.phrases) {
    if (title.includes(phrase)) {
      score += WEIGHTS.phraseTitle;
      reasons.push(`title~"${phrase}"`);
    } else if (`${summary} ${excerpt} ${keyPoints}`.includes(phrase)) {
      score += WEIGHTS.phraseBody;
      reasons.push(`text~"${phrase}"`);
    }
  }

  // Freshness nudge so equally relevant stories rank by recency.
  const ageDays = (Date.now() - Date.parse(article.publishedAt)) / 86_400_000;
  if (Number.isFinite(ageDays)) score += Math.max(0, 3 - ageDays * 0.25);

  // Nothing matched the free-text part of the query.
  if (score <= 0 && parsed.terms.length > 0) return { score: -1, reasons };
  return { score, reasons };
}

function matchesExcluded(article: Article, excluded: string[]): boolean {
  if (excluded.length === 0) return false;
  const haystack =
    `${article.title} ${article.summary} ${article.excerpt} ${article.tags.join(" ")}`.toLowerCase();
  return excluded.some((needle) => haystack.includes(needle));
}

function inAny(list: string[], values: string[]): boolean {
  if (list.length === 0) return true;
  const lowered = values.map((value) => value.toLowerCase());
  return list.some((entry) => {
    const needle = entry.toLowerCase();
    return lowered.includes(needle) || lowered.some((value) => value.includes(needle));
  });
}

/* -------------------------------------------------------------------------- */
/*  Query execution                                                            */
/* -------------------------------------------------------------------------- */

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

export function applyUpdateQuery(articles: Article[], query: UpdateQuery = {}): UpdateQueryResult {
  const parsed = parseSearchQuery(query.q);

  const categories = query.categories?.length ? query.categories : parsed.filters.categories;
  const sources = query.sources?.length ? query.sources : parsed.filters.sources;
  const tags = query.tags?.length ? query.tags : parsed.filters.tags;
  const minImpact = query.minImpact ?? parsed.filters.minImpact;
  const maxImpact = query.maxImpact ?? parsed.filters.maxImpact;
  const from = query.from ? Date.parse(query.from) : parsed.filters.after;
  const to = query.to ? Date.parse(query.to) : parsed.filters.before;
  const breakingOnly = query.breakingOnly ?? parsed.filters.breaking ?? false;
  const unreadOnly = query.unreadOnly ?? parsed.filters.unread ?? false;
  const bookmarkedOnly = query.bookmarkedOnly ?? parsed.filters.bookmarked ?? false;
  const collapseDuplicates = query.collapseDuplicates ?? true;
  const sort: SortKey = query.sort ?? "newest";
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

  const scored: { article: Article; textScore: number }[] = [];

  for (const article of articles) {
    if (collapseDuplicates && article.duplicateOf) continue;
    if (breakingOnly && !article.isBreaking) continue;
    if (unreadOnly && article.read) continue;
    if (bookmarkedOnly && !article.bookmarked) continue;
    if (typeof minImpact === "number" && article.impact < minImpact) continue;
    if (typeof maxImpact === "number" && article.impact > maxImpact) continue;

    const published = Date.parse(article.publishedAt);
    if (Number.isFinite(published)) {
      if (typeof from === "number" && Number.isFinite(from) && published < from) continue;
      if (typeof to === "number" && Number.isFinite(to) && published > to) continue;
    }

    if (categories.length > 0) {
      const haystack = [article.category, ...article.secondaryCategories];
      if (!inAny(categories, haystack)) continue;
    }
    if (sources.length > 0 && !inAny(sources, [article.sourceId, article.sourceName])) continue;
    if (tags.length > 0 && !inAny(tags, article.tags)) continue;
    if (matchesExcluded(article, parsed.excluded)) continue;

    const textResult = scoreArticle(article, parsed);
    if (textResult.score < 0) continue;
    scored.push({ article, textScore: textResult.score });
  }

  const sorted = [...scored].sort((a, b) => {
    const publishedDelta = Date.parse(b.article.publishedAt) - Date.parse(a.article.publishedAt);
    switch (sort) {
      case "oldest":
        return -publishedDelta;
      case "impact":
        return b.article.impact - a.article.impact || publishedDelta;
      case "relevance":
        return b.article.relevance - a.article.relevance || publishedDelta;
      case "source":
        return a.article.sourceName.localeCompare(b.article.sourceName) || publishedDelta;
      case "newest":
      default:
        if (parsed.terms.length > 0 || parsed.phrases.length > 0) {
          // Free-text searches blend match quality with recency.
          return (b.textScore - a.textScore) * 0.35 + publishedDelta / 86_400_000;
        }
        return publishedDelta;
    }
  });

  const categoryCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const sourceLabels = new Map<string, string>();
  const tagCounts = new Map<string, number>();
  let breaking = 0;
  let last24h = 0;
  let unread = 0;
  let bookmarked = 0;
  let impactSum = 0;
  const dayAgo = Date.now() - 86_400_000;

  for (const { article } of sorted) {
    categoryCounts.set(article.category, (categoryCounts.get(article.category) ?? 0) + 1);
    sourceCounts.set(article.sourceId, (sourceCounts.get(article.sourceId) ?? 0) + 1);
    sourceLabels.set(article.sourceId, article.sourceName);
    for (const tag of article.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    if (article.isBreaking) breaking += 1;
    if (Date.parse(article.publishedAt) >= dayAgo) last24h += 1;
    if (!article.read) unread += 1;
    if (article.bookmarked) bookmarked += 1;
    impactSum += article.impact;
  }

  const categoryFacets: FacetCount[] = CATEGORY_IDS.map((id) => ({
    id,
    label: categoryMeta(id).short,
    count: categoryCounts.get(id) ?? 0,
    accent: categoryMeta(id).accent,
  }));

  const sourceFacets: FacetCount[] = [...sourceCounts.entries()]
    .map(([id, count]) => ({ id, label: sourceLabels.get(id) ?? id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const tagFacets: FacetCount[] = [...tagCounts.entries()]
    .map(([id, count]) => ({ id, label: id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 28);

  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, query.page ?? 1));
  const items = sorted.slice((page - 1) * pageSize, page * pageSize).map((entry) => entry.article);

  return {
    items,
    total,
    page,
    pageSize,
    pageCount,
    facets: { categories: categoryFacets, sources: sourceFacets, tags: tagFacets },
    window: {
      total,
      breaking,
      last24h,
      unread,
      bookmarked,
      avgImpact: total > 0 ? Math.round(impactSum / total) : 0,
    },
    appliedQuery: describeQuery(parsed, {
      categories,
      sources,
      tags,
      minImpact,
      breakingOnly,
      unreadOnly,
      bookmarkedOnly,
    }),
  };
}

function describeQuery(
  parsed: ParsedQuery,
  applied: {
    categories: string[];
    sources: string[];
    tags: string[];
    minImpact?: number;
    breakingOnly: boolean;
    unreadOnly: boolean;
    bookmarkedOnly: boolean;
  },
): string {
  const parts: string[] = [];
  if (parsed.raw) parts.push(parsed.raw);
  if (applied.categories.length) parts.push(`category:${applied.categories.join(",")}`);
  if (applied.sources.length) parts.push(`source:${applied.sources.join(",")}`);
  if (applied.tags.length) parts.push(`tag:${applied.tags.join(",")}`);
  if (typeof applied.minImpact === "number") parts.push(`impact>=${applied.minImpact}`);
  if (applied.breakingOnly) parts.push("is:breaking");
  if (applied.unreadOnly) parts.push("is:unread");
  if (applied.bookmarkedOnly) parts.push("is:bookmarked");
  return parts.join(" ").trim();
}



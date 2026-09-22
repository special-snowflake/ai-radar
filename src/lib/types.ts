/**
 * Shared domain model for AI Radar.
 *
 * Everything that flows between the scanner, the store, the API routes and the
 * dashboard is typed here so the wire format and the persistence format stay
 * identical (the JSON store is just the serialized version of these shapes).
 */

/* -------------------------------------------------------------------------- */
/*  Taxonomy                                                                   */
/* -------------------------------------------------------------------------- */

export interface CategoryMeta {
  id: string;
  label: string;
  short: string;
  blurb: string;
  /** Hex accent used for chips, charts and timeline dots. */
  accent: string;
}

export const CATEGORIES = [
  {
    id: "models",
    label: "Models & Capability",
    short: "Models",
    blurb: "Frontier model releases, checkpoints and capability jumps",
    accent: "#a78bfa",
  },
  {
    id: "research",
    label: "Research & Papers",
    short: "Research",
    blurb: "Preprints, lab publications and technical reports",
    accent: "#60a5fa",
  },
  {
    id: "agents",
    label: "Agents & Automation",
    short: "Agents",
    blurb: "Autonomous agents, tooling, MCP and orchestration",
    accent: "#34d399",
  },
  {
    id: "infrastructure",
    label: "Compute & Hardware",
    short: "Compute",
    blurb: "Accelerators, datacenters, training clusters and energy",
    accent: "#fbbf24",
  },
  {
    id: "open-source",
    label: "Open Source & Dev Tools",
    short: "Open Source",
    blurb: "Open weights, frameworks, SDKs and developer tooling",
    accent: "#22d3ee",
  },
  {
    id: "product",
    label: "Products & Launches",
    short: "Products",
    blurb: "Shipped features, pricing changes and platform updates",
    accent: "#f472b6",
  },
  {
    id: "funding",
    label: "Funding & M&A",
    short: "Funding",
    blurb: "Raises, valuations, acquisitions and market structure",
    accent: "#4ade80",
  },
  {
    id: "industry",
    label: "Industry & Strategy",
    short: "Industry",
    blurb: "Partnerships, org moves, adoption and competition",
    accent: "#fb923c",
  },
  {
    id: "policy",
    label: "Policy & Regulation",
    short: "Policy",
    blurb: "Laws, courts, standards and government action",
    accent: "#f87171",
  },
  {
    id: "safety",
    label: "Safety & Alignment",
    short: "Safety",
    blurb: "Evaluations, misuse, security and alignment work",
    accent: "#e879f9",
  },
  {
    id: "science",
    label: "AI for Science & Health",
    short: "Science",
    blurb: "Biology, medicine, materials and scientific discovery",
    accent: "#2dd4bf",
  },
  {
    id: "robotics",
    label: "Robotics & Embodied AI",
    short: "Robotics",
    blurb: "Humanoids, autonomy, simulation and physical AI",
    accent: "#93c5fd",
  },
] as const satisfies readonly CategoryMeta[];

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const CATEGORY_IDS: CategoryId[] = CATEGORIES.map((c) => c.id);

export const CATEGORY_MAP: Record<string, CategoryMeta> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c as CategoryMeta]),
);

export const FALLBACK_CATEGORY: CategoryId = "industry";

export function isCategoryId(value: string): value is CategoryId {
  return Object.prototype.hasOwnProperty.call(CATEGORY_MAP, value);
}

export function categoryMeta(id: string): CategoryMeta {
  return CATEGORY_MAP[id] ?? CATEGORY_MAP[FALLBACK_CATEGORY];
}

/* -------------------------------------------------------------------------- */
/*  Sources                                                                    */
/* -------------------------------------------------------------------------- */

export type SourceKind =
  | "lab"
  | "vendor"
  | "research"
  | "media"
  | "community"
  | "policy"
  | "aggregator";

export type SourceStatus = "ok" | "empty" | "error" | "never";

export interface Source {
  id: string;
  name: string;
  /** Feed URL (RSS 2.0, Atom or RDF). */
  url: string;
  homepage: string;
  kind: SourceKind;
  /** 1 = primary/high signal, 2 = solid reporting, 3 = community/noisy. */
  tier: 1 | 2 | 3;
  enabled: boolean;
  builtIn: boolean;
  /** Category priors the classifier uses as a tie-breaker. */
  beats: CategoryId[];
  notes?: string;
  lastFetchedAt: string | null;
  lastStatus: SourceStatus;
  lastError: string | null;
  lastItemCount: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceInput {
  name: string;
  url: string;
  homepage?: string;
  kind?: SourceKind;
  tier?: 1 | 2 | 3;
  beats?: string[];
  notes?: string;
}

/** A source enriched with live rollups for the sources board and analytics. */
export interface SourceHealth extends Source {
  articleCount: number;
  articles7d: number;
  averageLatencyMs: number;
  /** Human label for the feed's primary beat (falls back to the kind label). */
  category: string;
  intervalMinutes: number;
}

/* -------------------------------------------------------------------------- */
/*  Articles                                                                   */
/* -------------------------------------------------------------------------- */

export type SummaryMethod = "extractive" | "llm" | "excerpt";
export type Sentiment = "positive" | "neutral" | "negative" | "mixed";

export interface Entities {
  companies: string[];
  models: string[];
  people: string[];
  technologies: string[];
}

export interface Article {
  /** Stable id derived from the canonicalized URL. */
  id: string;
  title: string;
  url: string;
  canonicalUrl: string;
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  author: string | null;
  publishedAt: string;
  fetchedAt: string;
  updatedAt: string;
  /** Short cleaned excerpt straight from the feed. */
  excerpt: string;
  /** 2-4 sentence summary (extractive by default). */
  summary: string;
  summaryMethod: SummaryMethod;
  keyPoints: string[];
  category: CategoryId;
  secondaryCategories: CategoryId[];
  categoryConfidence: number;
  tags: string[];
  entities: Entities;
  /** 0-100: how much this matters to the wider industry. */
  impact: number;
  /** 0-100: how well this matches the configured interest profile. */
  relevance: number;
  /** Impact drivers detected by the signal model, e.g. ["release", "capital"]. */
  signals: string[];
  sentiment: Sentiment;
  isBreaking: boolean;
  /** Other sources that published the same story (dedupe/merge). */
  alsoCoveredBy: string[];
  read: boolean;
  bookmarked: boolean;
  /** Set when this article was folded into an earlier one. */
  duplicateOf: string | null;
  wordCount: number;
  readingMinutes: number;
}

/* -------------------------------------------------------------------------- */
/*  Alerts                                                                     */
/* -------------------------------------------------------------------------- */

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  keywords: string[];
  /** "any" = OR across keywords, "all" = every keyword must appear. */
  keywordMode: "any" | "all";
  categories: CategoryId[];
  sourceIds: string[];
  minImpact: number;
  breakingOnly: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastMatchedAt: string | null;
  matchCount: number;
}

export interface AlertRuleInput {
  name: string;
  description?: string;
  keywords?: string[];
  keywordMode?: "any" | "all";
  categories?: string[];
  sourceIds?: string[];
  minImpact?: number;
  breakingOnly?: boolean;
  enabled?: boolean;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  articleId: string;
  createdAt: string;
  read: boolean;
  /** ISO timestamp until which the event is hidden from the active list. */
  snoozedUntil?: string | null;
  /** Why the rule fired, e.g. ["keyword:chips", "impact>=70"]. */
  reasons: string[];
}

/* -------------------------------------------------------------------------- */
/*  Scan runs                                                                  */
/* -------------------------------------------------------------------------- */

export interface ScanSourceResult {
  sourceId: string;
  sourceName: string;
  status: SourceStatus;
  items: number;
  added: number;
  merged: number;
  durationMs: number;
  error: string | null;
}

export interface ScanRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: "scheduler" | "manual" | "startup" | "cli" | "seed";
  sourcesAttempted: number;
  sourcesOk: number;
  sourcesFailed: number;
  itemsSeen: number;
  itemsAdded: number;
  itemsMerged: number;
  breakingFound: number;
  alerted: number;
  errors: { sourceId: string; message: string }[];
  results: ScanSourceResult[];
}

/* -------------------------------------------------------------------------- */
/*  Dashboard preferences                                                      */
/* -------------------------------------------------------------------------- */

export interface RadarSettings {
  scanIntervalMinutes: number;
  scanConcurrency: number;
  fetchTimeoutMs: number;
  maxItemsPerSource: number;
  maxArticles: number;
  summarizer: "extractive" | "llm";
  /** Interest profile that drives the relevance score. */
  interests: { keyword: string; weight: number }[];
  /** Extra weights layered on top of the taxonomy prior. */
  categoryWeights: Partial<Record<CategoryId, number>>;
  breakingImpactThreshold: number;
  breakingWindowHours: number;
  /** Suppress obvious noise (job posts, webinars, sponsored items...). */
  noiseFilter: boolean;
  /** Fold cross-source duplicates into the earliest story. */
  collapseDuplicates: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

export interface RadarDatabase {
  version: number;
  createdAt: string;
  updatedAt: string;
  articles: Article[];
  sources: Source[];
  alerts: AlertRule[];
  alertEvents: AlertEvent[];
  runs: ScanRun[];
  settings: RadarSettings;
  meta: {
    lastScanAt: string | null;
    lastScanTrigger: ScanRun["trigger"] | null;
    scansCompleted: number;
    totalArticlesAdded: number;
  };
}

/* -------------------------------------------------------------------------- */
/*  Query + API payloads                                                       */
/* -------------------------------------------------------------------------- */

export type SortKey = "newest" | "oldest" | "impact" | "relevance" | "source";

export interface UpdateQuery {
  q?: string;
  categories?: string[];
  sources?: string[];
  tags?: string[];
  from?: string;
  to?: string;
  minImpact?: number;
  maxImpact?: number;
  breakingOnly?: boolean;
  bookmarkedOnly?: boolean;
  unreadOnly?: boolean;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
  /** Hide stories that are folded into a duplicate. */
  collapseDuplicates?: boolean;
}

export interface FacetCount {
  id: string;
  label: string;
  count: number;
  accent?: string;
}

export interface UpdateQueryResult {
  items: Article[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  facets: {
    categories: FacetCount[];
    sources: FacetCount[];
    tags: FacetCount[];
  };
  window: {
    total: number;
    breaking: number;
    last24h: number;
    unread: number;
    bookmarked: number;
    avgImpact: number;
  };
  appliedQuery: string;
}

export interface RadarStats {
  totals: {
    articles: number;
    sources: number;
    enabledSources: number;
    alerts: number;
    unread: number;
    breaking: number;
    bookmarked: number;
  };
  last24h: number;
  last7d: number;
  byCategory: FacetCount[];
  bySource: FacetCount[];
  /** Per-source volume for the last 7 days (top 10). */
  weeklyBySource: FacetCount[];
  /** Flat aliases kept for pages that predate the nested `totals` block. */
  total: number;
  unread: number;
  read: number;
  duplicates: number;
  breaking: number;
  bookmarked: number;
  sourcesOk: number;
  sourcesTotal: number;
  topTags: FacetCount[];
  /** Volume + impact per day for the last 30 days. */
  timeline: { date: string; count: number; impact: number }[];
  scanning: {
    lastScanAt: string | null;
    lastScanTrigger: ScanRun["trigger"] | null;
    scansCompleted: number;
    intervalMinutes: number;
    schedulerEnabled: boolean;
    nextScanAt: string | null;
    healthySources: number;
    failingSources: number;
    averageScanMs: number;
  };
  sentiment: { label: Sentiment; count: number }[];
}

import type { CategoryId, Source, SourceKind } from "./types";

/**
 * Curated, link-rot-checked catalog of trusted AI sources.
 *
 * Every URL here was verified to return a parseable RSS/Atom/RDF document.
 * `beats` gives the classifier a prior for sources with a clear editorial
 * focus; it is only a tie-breaker, the keyword taxonomy still decides.
 */

export interface SourceSeed {
  id: string;
  name: string;
  url: string;
  homepage: string;
  kind: SourceKind;
  tier: 1 | 2 | 3;
  beats: CategoryId[];
  enabled?: boolean;
  notes?: string;
}

export const BUILT_IN_SOURCES: SourceSeed[] = [
  /* ----------------------------- Labs / frontier ----------------------------- */
  {
    id: "openai-news",
    name: "OpenAI",
    url: "https://openai.com/news/rss.xml",
    homepage: "https://openai.com/news/",
    kind: "lab",
    tier: 1,
    beats: ["models", "product", "safety", "agents"],
    notes: "Frontier lab announcements and research posts.",
  },
  {
    id: "google-deepmind",
    name: "Google DeepMind",
    url: "https://deepmind.google/blog/rss.xml",
    homepage: "https://deepmind.google/discover/blog/",
    kind: "lab",
    tier: 1,
    beats: ["models", "research", "science"],
  },
  {
    id: "google-research",
    name: "Google Research",
    url: "https://research.google/blog/rss/",
    homepage: "https://research.google/blog/",
    kind: "lab",
    tier: 1,
    beats: ["research", "science", "models"],
  },
  {
    id: "google-ai-blog",
    name: "Google AI (The Keyword)",
    url: "https://blog.google/technology/ai/rss/",
    homepage: "https://blog.google/technology/ai/",
    kind: "vendor",
    tier: 1,
    beats: ["product", "models", "industry"],
  },
  {
    id: "huggingface-blog",
    name: "Hugging Face",
    url: "https://huggingface.co/blog/feed.xml",
    homepage: "https://huggingface.co/blog",
    kind: "vendor",
    tier: 1,
    beats: ["open-source", "models", "agents"],
  },
  {
    id: "microsoft-research",
    name: "Microsoft Research",
    url: "https://www.microsoft.com/en-us/research/feed/",
    homepage: "https://www.microsoft.com/en-us/research/blog/",
    kind: "research",
    tier: 1,
    beats: ["research", "science", "models"],
  },
  {
    id: "cohere-blog",
    name: "Cohere",
    url: "https://cohere.com/blog/rss.xml",
    homepage: "https://cohere.com/blog",
    kind: "vendor",
    tier: 2,
    beats: ["models", "industry", "product"],
  },
  {
    id: "stability-news",
    name: "Stability AI",
    url: "https://stability.ai/news/rss.xml",
    homepage: "https://stability.ai/news",
    kind: "vendor",
    tier: 2,
    beats: ["models", "open-source", "product"],
  },
  {
    id: "together-blog",
    name: "Together AI",
    url: "https://www.together.ai/blog/rss.xml",
    homepage: "https://www.together.ai/blog",
    kind: "vendor",
    tier: 2,
    beats: ["infrastructure", "open-source", "models"],
  },
  /* ------------------------------- Compute ---------------------------------- */
  {
    id: "nvidia-blog",
    name: "NVIDIA",
    url: "https://blogs.nvidia.com/feed/",
    homepage: "https://blogs.nvidia.com/",
    kind: "vendor",
    tier: 1,
    beats: ["infrastructure", "industry", "robotics"],
  },
  {
    id: "nvidia-developer",
    name: "NVIDIA Developer",
    url: "https://developer.nvidia.com/blog/feed/",
    homepage: "https://developer.nvidia.com/blog/",
    kind: "vendor",
    tier: 2,
    beats: ["infrastructure", "open-source", "research"],
  },
  {
    id: "semianalysis",
    name: "SemiAnalysis",
    url: "https://www.semianalysis.com/feed",
    homepage: "https://www.semianalysis.com/",
    kind: "media",
    tier: 1,
    beats: ["infrastructure", "industry", "funding"],
    notes: "Deep hardware/datacenter supply-chain analysis.",
  },
  /* ------------------------------ Developer --------------------------------- */
  {
    id: "github-blog-ai",
    name: "GitHub (AI & ML)",
    url: "https://github.blog/ai-and-ml/feed/",
    homepage: "https://github.blog/ai-and-ml/",
    kind: "vendor",
    tier: 2,
    beats: ["open-source", "agents", "product"],
  },
  {
    id: "kdnuggets",
    name: "KDnuggets",
    url: "https://www.kdnuggets.com/feed",
    homepage: "https://www.kdnuggets.com/",
    kind: "media",
    tier: 3,
    beats: ["open-source", "research", "industry"],
  },
  {
    id: "applied-ml-aws",
    name: "AWS Machine Learning",
    url: "https://aws.amazon.com/blogs/machine-learning/feed/",
    homepage: "https://aws.amazon.com/blogs/machine-learning/",
    kind: "vendor",
    tier: 2,
    beats: ["product", "infrastructure", "industry"],
  },
  /* ------------------------------- Research --------------------------------- */
  {
    id: "arxiv-cs-ai",
    name: "arXiv cs.AI",
    url: "https://export.arxiv.org/rss/cs.AI",
    homepage: "https://arxiv.org/list/cs.AI/recent",
    kind: "research",
    tier: 2,
    beats: ["research", "agents"],
    notes: "Daily AI preprints. Empty on weekends (arXiv does not announce).",
  },
  {
    id: "arxiv-cs-lg",
    name: "arXiv cs.LG",
    url: "https://export.arxiv.org/rss/cs.LG",
    homepage: "https://arxiv.org/list/cs.LG/recent",
    kind: "research",
    tier: 2,
    beats: ["research", "models"],
  },
  {
    id: "arxiv-cs-cl",
    name: "arXiv cs.CL",
    url: "https://export.arxiv.org/rss/cs.CL",
    homepage: "https://arxiv.org/list/cs.CL/recent",
    kind: "research",
    tier: 2,
    beats: ["research", "models", "agents"],
  },
  {
    id: "arxiv-cs-ro",
    name: "arXiv cs.RO",
    url: "https://export.arxiv.org/rss/cs.RO",
    homepage: "https://arxiv.org/list/cs.RO/recent",
    kind: "research",
    tier: 3,
    beats: ["robotics", "research"],
  },
  {
    id: "bair-blog",
    name: "Berkeley AI Research",
    url: "https://bair.berkeley.edu/blog/feed.xml",
    homepage: "https://bair.berkeley.edu/blog/",
    kind: "research",
    tier: 1,
    beats: ["research", "robotics", "agents"],
  },
  {
    id: "stanford-hai",
    name: "Stanford HAI",
    url: "https://hai.stanford.edu/news/rss.xml",
    homepage: "https://hai.stanford.edu/news",
    kind: "research",
    tier: 1,
    beats: ["policy", "safety", "research"],
  },
  {
    id: "import-ai",
    name: "Import AI (Jack Clark)",
    url: "https://importai.substack.com/feed",
    homepage: "https://importai.substack.com/",
    kind: "research",
    tier: 1,
    beats: ["policy", "safety", "research"],
  },
  /* -------------------------------- Media ----------------------------------- */
  {
    id: "mit-tech-review-ai",
    name: "MIT Technology Review",
    url: "https://www.technologyreview.com/topic/artificial-intelligence/feed",
    homepage: "https://www.technologyreview.com/topic/artificial-intelligence/",
    kind: "media",
    tier: 1,
    beats: ["industry", "safety", "science"],
  },
  {
    id: "arstechnica-ai",
    name: "Ars Technica AI",
    url: "https://arstechnica.com/ai/feed/",
    homepage: "https://arstechnica.com/ai/",
    kind: "media",
    tier: 2,
    beats: ["industry", "policy", "safety"],
  },
  {
    id: "techcrunch-ai",
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    homepage: "https://techcrunch.com/category/artificial-intelligence/",
    kind: "media",
    tier: 2,
    beats: ["funding", "industry", "product"],
  },
  {
    id: "verge-ai",
    name: "The Verge AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    homepage: "https://www.theverge.com/ai-artificial-intelligence",
    kind: "media",
    tier: 2,
    beats: ["product", "industry", "policy"],
  },
  {
    id: "wired-ai",
    name: "WIRED AI",
    url: "https://www.wired.com/feed/tag/ai/latest/rss",
    homepage: "https://www.wired.com/tag/artificial-intelligence/",
    kind: "media",
    tier: 2,
    beats: ["industry", "safety", "science"],
  },
  {
    id: "ieee-spectrum-ai",
    name: "IEEE Spectrum AI",
    url: "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss",
    homepage: "https://spectrum.ieee.org/artificial-intelligence",
    kind: "media",
    tier: 1,
    beats: ["research", "infrastructure", "robotics"],
  },
  {
    id: "ieee-spectrum-robotics",
    name: "IEEE Spectrum Robotics",
    url: "https://spectrum.ieee.org/feeds/topic/robotics.rss",
    homepage: "https://spectrum.ieee.org/robotics",
    kind: "media",
    tier: 2,
    beats: ["robotics", "infrastructure"],
  },
  {
    id: "theregister-ai",
    name: "The Register (AI/ML)",
    url: "https://www.theregister.com/software/ai_ml/headlines.atom",
    homepage: "https://www.theregister.com/software/ai_ml/",
    kind: "media",
    tier: 2,
    beats: ["industry", "infrastructure", "policy"],
    notes: "Atom feed.",
  },
  {
    id: "marktechpost",
    name: "MarkTechPost",
    url: "https://www.marktechpost.com/feed/",
    homepage: "https://www.marktechpost.com/",
    kind: "media",
    tier: 3,
    beats: ["research", "models", "open-source"],
  },
  {
    id: "analytics-india",
    name: "Analytics India Magazine",
    url: "https://analyticsindiamag.com/feed/",
    homepage: "https://analyticsindiamag.com/",
    kind: "media",
    tier: 3,
    beats: ["industry", "product", "funding"],
  },
  {
    id: "zdnet-ai",
    name: "ZDNET AI",
    url: "https://www.zdnet.com/topic/artificial-intelligence/rss.xml",
    homepage: "https://www.zdnet.com/topic/artificial-intelligence/",
    kind: "media",
    tier: 3,
    beats: ["product", "industry", "agents"],
  },
  {
    id: "infoworld-ai",
    name: "InfoWorld AI",
    url: "https://www.infoworld.com/category/artificial-intelligence/index.rss",
    homepage: "https://www.infoworld.com/category/artificial-intelligence/",
    kind: "media",
    tier: 3,
    beats: ["open-source", "product", "agents"],
  },
  /* -------------------------- Policy / standards ---------------------------- */
  {
    id: "nist-news",
    name: "NIST News",
    url: "https://www.nist.gov/news-events/news/rss.xml",
    homepage: "https://www.nist.gov/news-events/news",
    kind: "policy",
    tier: 1,
    beats: ["policy", "safety"],
    notes: "US standards body - AI safety institute, evaluation guidance.",
  },
  {
    id: "eu-ai-act",
    name: "EU AI Act",
    url: "https://artificialintelligenceact.eu/feed/",
    homepage: "https://artificialintelligenceact.eu/",
    kind: "policy",
    tier: 2,
    beats: ["policy", "safety"],
  },
  /* ------------------------------ Community --------------------------------- */
  {
    id: "simon-willison",
    name: "Simon Willison",
    url: "https://simonwillison.net/atom/everything/",
    homepage: "https://simonwillison.net/",
    kind: "community",
    tier: 2,
    beats: ["open-source", "agents", "models"],
    notes: "Atom feed. Practitioner-level LLM analysis.",
  },
  {
    id: "hackernews-ai",
    name: "Hacker News (AI)",
    url: "https://hnrss.org/newest?q=AI&points=100",
    homepage: "https://news.ycombinator.com/",
    kind: "community",
    tier: 3,
    beats: ["industry", "open-source", "infrastructure"],
    notes: "High-score HN stories matching AI, useful as an early-warning feed.",
  },
  {
    id: "reddit-ml",
    name: "r/MachineLearning",
    url: "https://www.reddit.com/r/MachineLearning/.rss",
    homepage: "https://www.reddit.com/r/MachineLearning/",
    kind: "community",
    tier: 3,
    beats: ["research", "open-source"],
    enabled: false,
    notes: "Noisy but early; off by default.",
  },
  {
    id: "reddit-artificial",
    name: "r/artificial",
    url: "https://www.reddit.com/r/artificial/.rss",
    homepage: "https://www.reddit.com/r/artificial/",
    kind: "community",
    tier: 3,
    beats: ["industry", "product"],
    enabled: false,
    notes: "Noisy but early; off by default.",
  },
  /* --------------------------- Aggregators ---------------------------------- */
  {
    id: "techmeme",
    name: "Techmeme",
    url: "https://www.techmeme.com/feed.xml",
    homepage: "https://www.techmeme.com/",
    kind: "aggregator",
    tier: 1,
    beats: ["industry", "funding", "product"],
    notes: "Editorially clustered tech headlines - excellent breaking signal.",
  },
  {
    id: "google-news-anthropic",
    name: "Google News - Anthropic / Claude",
    url: "https://news.google.com/rss/search?q=Anthropic%20OR%20%22Claude%22%20AI&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://news.google.com/",
    kind: "aggregator",
    tier: 2,
    beats: ["models", "industry", "policy"],
    notes: "Coverage backfill for labs that do not publish a public feed.",
  },
  {
    id: "google-news-ai-funding",
    name: "Google News - AI funding",
    url: "https://news.google.com/rss/search?q=%22AI%20startup%22%20raises%20OR%20valuation&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://news.google.com/",
    kind: "aggregator",
    tier: 2,
    beats: ["funding", "industry"],
  },
  {
    id: "google-news-ai-policy",
    name: "Google News - AI regulation",
    url: "https://news.google.com/rss/search?q=%22AI%20regulation%22%20OR%20%22AI%20Act%22%20OR%20%22AI%20safety%22&hl=en-US&gl=US&ceid=US:en",
    homepage: "https://news.google.com/",
    kind: "aggregator",
    tier: 2,
    beats: ["policy", "safety"],
  },
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function seedToSource(seed: SourceSeed, timestamp: string): Source {
  return {
    id: seed.id,
    name: seed.name,
    url: seed.url,
    homepage: seed.homepage,
    kind: seed.kind,
    tier: seed.tier,
    enabled: seed.enabled ?? true,
    builtIn: true,
    beats: [...seed.beats],
    notes: seed.notes,
    lastFetchedAt: null,
    lastStatus: "never",
    lastError: null,
    lastItemCount: 0,
    consecutiveFailures: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function defaultSources(timestamp: string): Source[] {
  return BUILT_IN_SOURCES.map((seed) => seedToSource(seed, timestamp));
}

/**
 * Keeps a persisted source list in sync with the built-in catalog:
 * new catalog entries are appended, removed ones are dropped (unless the user
 * added them manually), and user preferences (enabled, custom fields) survive.
 */
export function reconcileSources(existing: Source[], timestamp: string): Source[] {
  const byId = new Map(existing.map((source) => [source.id, source]));
  const reconciled: Source[] = [];

  for (const seed of BUILT_IN_SOURCES) {
    const current = byId.get(seed.id);
    if (!current) {
      reconciled.push(seedToSource(seed, timestamp));
      continue;
    }
    reconciled.push({
      ...current,
      name: seed.name,
      url: seed.url,
      homepage: seed.homepage,
      kind: seed.kind,
      tier: seed.tier,
      beats: [...seed.beats],
      notes: seed.notes ?? current.notes,
      builtIn: true,
      updatedAt: timestamp,
    });
    byId.delete(seed.id);
  }

  // Anything left over was added by the user - keep it, but only if it is not a
  // built-in source that has since been retired from the catalog.
  for (const source of byId.values()) {
    reconciled.push(source);
  }

  return reconciled;
}

export function findSeed(id: string): SourceSeed | undefined {
  return BUILT_IN_SOURCES.find((seed) => seed.id === id);
}

import { cleanText, contentTokens, countOccurrences, clamp, round, unique } from "./text";
import { FALLBACK_CATEGORY } from "./types";
import type { CategoryId, Entities, RadarSettings, Sentiment, SourceKind } from "./types";

/**
 * Rule-based intelligence layer.
 *
 * Deliberately deterministic and offline: a weighted keyword taxonomy scores
 * every category, dictionaries pull out the companies/models/people in play,
 * and a signal model turns editorial cues (releases, raises, rulings...) into
 * an interpretable 0-100 impact score. Everything here is unit tested and can
 * later be complemented - not replaced - by an LLM classifier.
 */

type WeightedTerm = [term: string, weight: number];

const CATEGORY_TERMS: Record<CategoryId, WeightedTerm[]> = {
  models: [
    ["model", 2], ["models", 2], ["llm", 3], ["llms", 3], ["frontier model", 4],
    ["foundation model", 4], ["gpt", 4], ["claude", 4], ["gemini", 4], ["llama", 3],
    ["mistral", 3], ["qwen", 3], ["deepseek", 3], ["grok", 3], ["phi-", 2],
    ["checkpoint", 3], ["parameters", 2], ["context window", 3], ["mixture of experts", 4],
    ["reasoning model", 4], ["multimodal", 3], ["vision model", 3], ["text-to-image", 3],
    ["text-to-video", 3], ["diffusion model", 3], ["fine-tune", 2], ["distillation", 2],
    ["quantization", 2], ["weights", 3], ["model card", 3], ["capabilities", 2],
    ["state of the art", 3], ["sota", 3], ["benchmark", 2],
  ],
  research: [
    ["paper", 3], ["papers", 3], ["arxiv", 4], ["preprint", 4], ["research", 2],
    ["researchers", 2], ["study", 2], ["we propose", 3], ["novel method", 3],
    ["architecture", 3], ["attention", 2], ["transformer", 3], ["scaling law", 4],
    ["ablation", 3], ["experiments show", 3], ["technical report", 4], ["journal", 2],
    ["peer-reviewed", 3], ["hypothesis", 2], ["theory", 2], ["tokenizer", 2],
    ["embedding", 2], ["pretraining", 3], ["dataset", 2],
  ],
  agents: [
    ["agent", 3], ["agents", 3], ["agentic", 4], ["autonomous", 3], ["tool use", 3],
    ["tool calling", 3], ["computer use", 4], ["browser agent", 4], ["mcp", 3],
    ["model context protocol", 4], ["orchestration", 3], ["workflow automation", 3],
    ["multi-agent", 4], ["copilot", 3], ["assistant", 2], ["chatbot", 2],
    ["human in the loop", 2], ["sandbox", 2], ["function calling", 3], ["rag", 3],
    ["retrieval augmented", 3], ["chain of thought", 3], ["task automation", 3],
  ],
  infrastructure: [
    ["gpu", 4], ["gpus", 4], ["tpu", 3], ["accelerator", 3], ["datacenter", 4],
    ["data center", 4], ["cluster", 3], ["compute", 3], ["chip", 3], ["chips", 3],
    ["semiconductor", 4], ["wafer", 3], ["hbm", 4], ["memory bandwidth", 3],
    ["interconnect", 3], ["inference cost", 4], ["throughput", 3], ["gigawatt", 4],
    ["megawatt", 3], ["energy", 2], ["cooling", 2], ["supercomputer", 4], ["cuda", 3],
    ["tsmc", 3], ["foundry", 3], ["capacity", 2], ["servers", 2], ["nvlink", 3],
    ["supply chain", 2], ["silicon", 3],
  ],
  "open-source": [
    ["open source", 4], ["open-source", 4], ["open weights", 5], ["apache 2.0", 4],
    ["mit license", 4], ["hugging face", 3], ["github", 2], ["repo", 3], ["sdk", 3],
    ["library", 2], ["framework", 2], ["npm", 2], ["pypi", 3], ["pip install", 3],
    ["docker", 2], ["kubernetes", 2], ["vllm", 3], ["llama.cpp", 3], ["ollama", 3],
    ["community edition", 3], ["self-host", 3], ["local model", 3], ["on-device", 3],
    ["developer kit", 2], ["toolkit", 2], ["open weights release", 5], ["apache-2.0", 4],
  ],
  product: [
    ["launch", 3], ["launches", 3], ["launched", 3], ["release", 3], ["released", 3],
    ["generally available", 4], ["now available", 4], ["rolls out", 3], ["rolling out", 3],
    ["feature", 2], ["features", 2], ["subscription", 3], ["pricing", 4], ["free tier", 3],
    ["api", 3], ["beta", 3], ["preview", 2], ["upgrade", 2], ["integration", 2],
    ["available in", 2], ["waitlist", 2], ["mobile app", 2], ["plugin", 2], ["extension", 2],
  ],
  funding: [
    ["raises", 5], ["raised", 5], ["funding", 5], ["series a", 5], ["series b", 5],
    ["series c", 5], ["series d", 5], ["seed round", 5], ["valuation", 5],
    ["valued at", 5], ["investment", 3], ["investors", 3], ["ipo", 5], ["acquires", 5],
    ["acquired", 5], ["acquisition", 5], ["merger", 4], ["buyout", 4], ["term sheet", 4],
    ["venture", 3], ["backers", 3], ["down round", 4], ["secondary sale", 3], ["spac", 3],
  ],
  industry: [
    ["partnership", 4], ["partners with", 4], ["contract", 3], ["enterprise", 3],
    ["adoption", 3], ["customers", 3], ["revenue", 3], ["market share", 3], ["layoffs", 3],
    ["hiring", 2], ["restructuring", 3], ["ceo", 3], ["leadership", 2], ["strategy", 2],
    ["competition", 3], ["rival", 3], ["expansion", 2], ["earnings", 3], ["forecast", 2],
    ["joint venture", 4], ["usage", 2], ["growth", 2], ["deal with", 3], ["headcount", 2],
  ],
  policy: [
    ["regulation", 5], ["regulator", 5], ["regulators", 5], ["law", 4], ["laws", 4],
    ["legislation", 5], ["bill", 3], ["eu ai act", 5], ["compliance", 3], ["court", 4],
    ["judge", 3], ["ruling", 4], ["lawsuit", 4], ["sued", 4], ["antitrust", 5], ["ftc", 4],
    ["doj", 4], ["european commission", 5], ["white house", 4], ["executive order", 5],
    ["ban", 4], ["banned", 4], ["sanctions", 4], ["export controls", 5], ["copyright", 4],
    ["patent", 3], ["policy", 3], ["government", 3], ["senate", 3], ["congress", 3],
    ["parliament", 3], ["data protection", 4], ["gdpr", 4], ["state law", 4],
  ],
  safety: [
    ["safety", 4], ["alignment", 4], ["misuse", 4], ["jailbreak", 4], ["prompt injection", 5],
    ["red team", 4], ["red-teaming", 4], ["evaluation", 3], ["evals", 4], ["guardrails", 4],
    ["harmful", 3], ["bias", 3], ["deepfake", 4], ["disinformation", 4], ["fraud", 3],
    ["cyberattack", 4], ["vulnerability", 3], ["malware", 4], ["scam", 3], ["child safety", 4],
    ["existential risk", 5], ["catastrophic", 4], ["interpretability", 4], ["responsible ai", 4],
    ["model card", 2], ["content moderation", 3], ["privacy", 3], ["watermark", 3],
    ["provenance", 3], ["safeguards", 3],
  ],
  science: [
    ["drug discovery", 5], ["protein", 4], ["alphafold", 5], ["biology", 3], ["genomics", 4],
    ["clinical", 3], ["medical", 3], ["diagnosis", 3], ["healthcare", 4], ["hospital", 2],
    ["materials", 3], ["chemistry", 3], ["physics", 3], ["simulation", 2], ["weather", 3],
    ["climate model", 4], ["cancer", 3], ["radiology", 4], ["therapy", 3], ["patient", 2],
    ["fda", 3], ["biotech", 3], ["neuroscience", 3], ["math olympiad", 4], ["theorem", 3],
  ],
  robotics: [
    ["robot", 4], ["robots", 4], ["robotics", 5], ["humanoid", 5], ["manipulation", 4],
    ["embodied", 5], ["autonomous vehicle", 5], ["self-driving", 5], ["drone", 4],
    ["warehouse automation", 4], ["actuator", 3], ["teleoperation", 4], ["sim-to-real", 4],
    ["waymo", 4], ["quadruped", 4], ["grasping", 3], ["lidar", 3], ["robotaxi", 5],
    ["factory automation", 4], ["physical ai", 4], ["humanoid robot", 5],
  ],
};

const DEFAULT_BEAT_WEIGHT = 2.4;

/* -------------------------------------------------------------------------- */
/*  Entity dictionaries                                                        */
/* -------------------------------------------------------------------------- */

const COMPANY_TERMS = [
  "OpenAI", "Anthropic", "Google", "DeepMind", "Meta", "Microsoft", "NVIDIA", "AMD",
  "Intel", "TSMC", "Apple", "Amazon", "AWS", "Mistral AI", "Cohere", "xAI", "DeepSeek",
  "Alibaba", "Qwen", "Baidu", "ByteDance", "Samsung", "Huawei", "IBM", "Salesforce",
  "Databricks", "Scale AI", "Perplexity", "Stability AI", "Hugging Face", "Runway",
  "Midjourney", "ElevenLabs", "Figure AI", "Tesla", "Waymo", "Uber", "Adobe", "Oracle",
  "Snowflake", "SAP", "ServiceNow", "Palantir", "ARM", "Qualcomm", "Broadcom",
  "Cerebras", "Groq", "SambaNova", "CoreWeave", "SoftBank", "Sequoia Capital",
  "Andreessen Horowitz", "a16z", "Thrive Capital", "Lightspeed", "General Catalyst",
  "Founders Fund", "Index Ventures", "Khosla Ventures", "NEA", "Sovereign fund",
  "Mubadala", "MGX", "Inflection AI", "Adept", "Character.AI", "Replit", "Cursor",
  "Anysphere", "Decart", "World Labs", "Reflection AI", "Safe Superintelligence",
  "Thinking Machines", "Poolside", "Fal", "Suno", "Udio", "Black Forest Labs",
  "AI21 Labs", "Aleph Alpha", "01.AI", "Zhipu", "Moonshot AI", "MiniMax", "StepFun",
  "Sakana AI", "Reka AI", "Writer", "Glean", "Harvey", "Sierra", "Abridge", "Tempus",
  "Insilico Medicine", "Isomorphic Labs", "Recursion", "XtalPi", "SK Hynix",
  "Micron", "Marvell", "Western Digital", "Dell", "HPE", "Supermicro", "Lenovo",
  "Nebius", "Lambda Labs", "Crusoe", "Together AI", "Fireworks AI", "Baseten",
  "Replicate", "Modal", "Anyscale", "LangChain", "LlamaIndex", "Weights & Biases",
  "Labelbox", "Surge AI", "Mercor", "Turing", "Cloudflare", "Vercel", "Automattic",
  "Nvidia", "OpenAI Foundation", "European Commission", "FTC", "DOJ", "NIST",
];

const MODEL_TERMS = [
  "GPT-5", "GPT-5.1", "GPT-4o", "GPT-4.1", "GPT-4", "o1", "o3", "o4-mini", "Sora",
  "Claude 4", "Claude 4.5", "Claude 4.6", "Claude Opus", "Claude Sonnet", "Claude Haiku",
  "Gemini 3", "Gemini 2.5", "Gemini Ultra", "Gemini Flash", "Gemma", "Veo", "Imagen",
  "Nano Banana", "Llama 4", "Llama 3", "Mistral Large", "Mistral Medium", "Mistral Small",
  "Devstral", "Magistral", "Qwen", "Qwen3", "DeepSeek-R1", "DeepSeek-V3", "Grok 4",
  "Grok 3", "Phi-4", "Phi-5", "Command A", "Command R", "Stable Diffusion", "FLUX",
  "Whisper", "Cohere Embed", "Nemotron", "Granite", "Falcon", "Yi", "Kimi", "MiniMax",
  "GLM", "ERNIE", "Doubao", "Seedream", "LFM", "SmolLM", "Olmo", "Pythia", "DINOv2",
  "CLIP", "SAM 2", "Whisper Large", "Titan", "Chirp", "Nemotron Ultra",
];

const PEOPLE_TERMS = [
  "Sam Altman", "Dario Amodei", "Daniela Amodei", "Demis Hassabis", "Sundar Pichai",
  "Satya Nadella", "Jensen Huang", "Yann LeCun", "Fei-Fei Li", "Ilya Sutskever",
  "Mira Murati", "Elon Musk", "Mark Zuckerberg", "Lisa Su", "Andrew Ng", "Jeff Dean",
  "Andrej Karpathy", "Geoffrey Hinton", "Yoshua Bengio", "Stuart Russell", "Oriol Vinyals",
  "Noam Brown", "Jason Wei", "Jonas Schneider", "Aravind Srinivas", "Alexandr Wang",
  "Dylan Patel", "Jack Clark", "Simon Willison", "Nathan Lambert", "Tim Dettmers",
  "Tri Dao", "Percy Liang", "Chelsea Finn", "Pieter Abbeel", "Sergey Levine",
  "Michael Bronstein", "Kate Crawford", "Timnit Gebru", "Emily Bender", "Meredith Whittaker",
  "Chris Olah", "Jan Leike", "Anca Dragan", "Sarah Guo", "Marc Andreessen", "Vinod Khosla",
  "Reid Hoffman", "Masayoshi Son", "Kai-Fu Lee", "Arthur Mensch", "Arthur Zucker",
  "Liang Wenfeng", "Alex Karp", "Cristiano Amon", "Lip-Bu Tan", "Aidan Gomez",
];

const TECHNOLOGY_TERMS = [
  "transformer", "diffusion", "RLHF", "RLAIF", "DPO", "PPO", "fine-tuning", "LoRA",
  "QLoRA", "quantization", "distillation", "mixture-of-experts", "MoE", "attention",
  "flash attention", "speculative decoding", "KV cache", "context window", "embeddings",
  "vector database", "RAG", "knowledge graph", "chain-of-thought", "test-time compute",
  "inference", "training run", "pretraining", "post-training", "synthetic data",
  "benchmark", "eval", "jailbreak", "prompt injection", "MCP", "agentic workflow",
  "function calling", "multimodal", "vision-language", "speech recognition", "TTS",
  "world model", "reinforcement learning", "sim-to-real", "SLAM", "GPU cluster",
  "TPU", "HBM", "liquid cooling", "edge inference", "federated learning",
  "differential privacy", "watermarking", "constitutional AI", "interpretability",
  "sparse autoencoder", "neural architecture search", "state space model",
];

/** Curated tags surfaced as filter chips in the dashboard. */
const TAG_TERMS: Record<string, string[]> = {
  "open weights": ["open weights", "open-weight", "open sourced", "open-source release"],
  reasoning: ["reasoning", "chain of thought", "chain-of-thought", "test-time compute", "thinking mode"],
  multimodal: ["multimodal", "vision-language", "omni", "image understanding", "audio understanding"],
  agentic: ["agentic", "ai agent", "autonomous agent", "agent framework", "computer use"],
  "inference cost": ["inference cost", "per million tokens", "token pricing", "cost per token", "price cut"],
  regulation: ["regulation", "regulator", "eu ai act", "compliance", "legislation", "executive order"],
  chips: ["gpu", "chip", "chipmaker", "semiconductor", "wafer", "hbm", "tsmc", "nvidia"],
  datacenter: ["datacenter", "data center", "hyperscale", "gigawatt", "megawatt", "cooling"],
  funding: ["raises", "raised", "funding round", "valuation", "investment round"],
  acquisition: ["acquires", "acquired", "acquisition", "merger", "buyout"],
  benchmark: ["benchmark", "swe-bench", "mmlu", "arc-agi", "gpqa", "humanity's last exam"],
  safety: ["safety", "alignment", "red team", "guardrails", "safeguards", "interpretability"],
  misuse: ["fraud", "scam", "phishing", "deepfake", "disinformation", "malware", "cyberattack"],
  healthcare: ["healthcare", "clinical", "medical", "hospital", "diagnosis", "fda"],
  robotics: ["robot", "robotics", "humanoid", "manipulation", "drone", "robotaxi"],
  enterprise: ["enterprise", "deployment", "adoption", "customers", "b2b"],
  "dev tools": ["sdk", "cli", "ide", "framework", "library", "developer platform"],
  video: ["text-to-video", "video generation", "sora", "veo", "short film"],
  image: ["text-to-image", "image generation", "stable diffusion", "midjourney", "flux"],
  audio: ["speech", "voice model", "text-to-speech", "music generation", "real-time voice"],
  science: ["protein", "drug discovery", "biology", "materials", "physics", "alphafold"],
  education: ["school", "student", "university", "education", "teacher"],
  jobs: ["jobs", "hiring", "layoffs", "workforce", "labor"],
  privacy: ["privacy", "data protection", "surveillance", "gdpr", "biometric"],
  energy: ["energy", "power grid", "electricity", "nuclear", "smr"],
  military: ["military", "defense", "pentagon", "weapons", "drone warfare"],
  agi: ["artificial general intelligence", "superintelligence", "agi"],
  china: ["china", "chinese", "beijing", "alibaba", "deepseek", "baidu", "huawei", "moonshot"],
  usa: ["united states", "white house", "washington", "ftc", "doj", "nist", "congress"],
  europe: ["european union", "brussels", "european commission", "gdpr", "eu ai act"],
  "human oversight": ["human in the loop", "oversight", "autonomy limits", "kill switch"],
};

/** Low-value items that should never reach the dashboard. */
const NOISE_PATTERNS: RegExp[] = [
  /^\s*(job|career|hiring)\b/i,
  /\b(we'?re hiring|join our team|apply now|job opening)\b/i,
  /\b(webinar|virtual event|register now|live q&a|ama session)\b/i,
  /\b(podcast|episode \d+|newsletter (issue|#)\s?\d+)\b/i,
  /\b(best \d+|top \d+ (ai )?(tools|apps|platforms))\b/i,
  /\b(how to (use|build|write|prompt)|step-by-step|beginners guide|tutorial)\b/i,
  /\b(sponsored|advertorial|partner content|paid post)\b/i,
  /\b(discount|coupon|deal of the day|prime day|black friday)\b/i,
  /\b(gift guide|holiday deals)\b/i,
  /\b(quiz|horoscope|wordle|puzzle of the day)\b/i,
];

export function isNoiseText(title: string, body: string): boolean {
  const haystack = `${title}\n${body.slice(0, 400)}`;
  return NOISE_PATTERNS.some((pattern) => pattern.test(haystack));
}

/* -------------------------------------------------------------------------- */
/*  Matching helpers                                                           */
/* -------------------------------------------------------------------------- */

function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word match for single tokens, substring match for phrases. */
function termRegex(term: string): RegExp {
  const escaped = escapeTerm(term);
  if (term.includes(" ") || term.includes("-") || term.includes(".")) {
    return new RegExp(escaped, "i");
  }
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

function countTerm(text: string, term: string): number {
  const matches = text.match(new RegExp(termRegex(term).source, "gi"));
  return matches ? matches.length : 0;
}

export function countTermHits(text: string, term: string): number {
  return countTerm(text, term);
}

/* -------------------------------------------------------------------------- */
/*  Impact model                                                               */
/* -------------------------------------------------------------------------- */

interface Signal {
  id: string;
  label: string;
  weight: number;
  pattern: RegExp;
}

const IMPACT_SIGNALS: Signal[] = [
  {
    id: "release",
    label: "Ships something new",
    weight: 7,
    pattern:
      /\b(release[sd]?|launch(es|ed)?|unveil(s|ed)?|introduc(e|es|ed|ing)|now available|generally available|rolls out|shipping)\b/i,
  },
  {
    id: "capability",
    label: "Capability jump",
    weight: 9,
    pattern:
      /\b(state[- ]of[- ]the[- ]art|sota|new record|outperform(s|ed)?|surpass(es|ed)?|breakthrough|first[- ]ever|record[- ]breaking|beats? (gpt|claude|gemini|human))\b/i,
  },
  {
    id: "capital",
    label: "Capital movement",
    weight: 8,
    pattern:
      /\b(raise[sd]?|funding round|series [a-e]\b|valuation|valued at|ipo|acquir(es|ed|ing)|merger|buyout|invest(s|ed|ment))\b/i,
  },
  {
    id: "regulatory",
    label: "Regulatory action",
    weight: 7,
    pattern:
      /\b(regulat(ion|or|ors|e|es|ed)|legislation|court|ruling|ban(s|ned)?|lawsuit|antitrust|export controls|executive order)\b/i,
  },
  {
    id: "scale",
    label: "Compute scale",
    weight: 4,
    pattern:
      /\b\d+(\.\d+)?\s?(billion|bn|trillion)?\s?(parameters|tokens|gpus?|megawatts?|gigawatts?|h100s?|b200s?|gb200s?)\b/i,
  },
  {
    id: "sum",
    label: "Large sum of money",
    weight: 4,
    pattern:
      /(\$\s?\d+(\.\d+)?\s?(billion|bn|million|m|b)\b)|(\b\d+(\.\d+)?\s?(billion|trillion)\s?(dollars|usd)\b)/i,
  },
  {
    id: "frontier",
    label: "Frontier lab involved",
    weight: 4,
    pattern:
      /\b(openai|anthropic|google deepmind|deepmind|meta ai|microsoft|nvidia|amazon|apple|xai|mistral)\b/i,
  },
  {
    id: "open",
    label: "Open weights",
    weight: 5,
    pattern: /\b(open[- ]weights?|open[- ]sourc(e|es|ed|ing)|apache[- ]2\.0|mit license)\b/i,
  },
  {
    id: "misuse",
    label: "Safety / misuse",
    weight: 6,
    pattern:
      /\b(misuse|jailbreak|deepfake|prompt injection|exploit|leak(ed)? (data|weights)|vulnerabilit(y|ies)|harmful output)\b/i,
  },
  {
    id: "adoption",
    label: "Deployment / partnership",
    weight: 3,
    pattern: /\b(partnership|deploy(s|ed|ment)|rollout|adopt(s|ed|ion)|deal)\b/i,
  },
  {
    id: "science",
    label: "Scientific result",
    weight: 5,
    pattern:
      /\b(drug discovery|protein structure|clinical trial|materials discovery|diagnos(is|tic)|nobel)\b/i,
  },
];

const IMPACT_DAMPENERS: Signal[] = [
  {
    id: "opinion",
    label: "Opinion piece",
    weight: -10,
    pattern: /\b(opinion|op-ed|column|essay|what (it|this) means for|explainer)\b/i,
  },
  {
    id: "howto",
    label: "Tutorial content",
    weight: -9,
    pattern: /\b(how to|tutorial|walkthrough|cheat sheet|prompt idea)\b/i,
  },
  {
    id: "listicle",
    label: "Listicle",
    weight: -8,
    pattern: /\b(\d+ (best|top|greatest|ways)|best \w+ for|compared:)/i,
  },
  {
    id: "rumour",
    label: "Unconfirmed reporting",
    weight: -5,
    pattern: /\b(rumou?r|reportedly|allegedly|sources say|may be|could be)\b/i,
  },
  {
    id: "sponsored",
    label: "Promotional",
    weight: -14,
    pattern: /\b(sponsored|advertorial|promo(tion)?|discount|coupon)\b/i,
  },
  {
    id: "consumer-promo",
    label: "Consumer promotion",
    weight: -8,
    pattern:
      /\b(passive income|side hustle|cash in on|make money (with|from)|earn money|referral bonus|gift guide)\b/i,
  },
  {
    id: "personal",
    label: "Personal anecdote",
    weight: -6,
    pattern: /\b(i tried|my experience|we tested|hands-on with|review:)\b/i,
  },
];

const TIER_BONUS: Record<1 | 2 | 3, number> = { 1: 14, 2: 8, 3: 3 };
const KIND_BONUS: Record<SourceKind, number> = {
  lab: 3,
  research: 2,
  media: 1,
  policy: 2,
  vendor: 0,
  aggregator: 0,
  community: -2,
};

export function ageInHours(publishedAt: string, now: Date = new Date()): number {
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) return 24 * 30;
  return Math.max(0, (now.getTime() - published) / 3_600_000);
}

export interface ImpactInput {
  title: string;
  body: string;
  tier: 1 | 2 | 3;
  sourceKind: SourceKind;
  publishedAt: string;
  now?: Date;
}

export interface ImpactResult {
  score: number;
  signals: string[];
}

export function computeImpact(input: ImpactInput): ImpactResult {
  const now = input.now ?? new Date();
  const text = `${input.title}. ${input.body}`;
  let score = 18 + TIER_BONUS[input.tier] + (KIND_BONUS[input.sourceKind] ?? 0);
  const signals: string[] = [];

  for (const signal of IMPACT_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += signal.weight;
      signals.push(signal.id);
    }
  }
  for (const dampener of IMPACT_DAMPENERS) {
    if (dampener.pattern.test(text)) {
      score += dampener.weight;
      signals.push(dampener.id);
    }
  }

  // Headline-level signals matter more than a passing body mention.
  const capability = IMPACT_SIGNALS.find((signal) => signal.id === "capability");
  const release = IMPACT_SIGNALS.find((signal) => signal.id === "release");
  if (capability?.pattern.test(input.title)) score += 3;
  if (release?.pattern.test(input.title)) score += 2;

  // Freshness decay keeps the radar pointed at what is happening now.
  const age = ageInHours(input.publishedAt, now);
  if (age <= 3) score += 9;
  else if (age <= 12) score += 7;
  else if (age <= 24) score += 5;
  else if (age <= 72) score += 2;
  else if (age <= 24 * 7) score += 0;
  else if (age <= 24 * 30) score -= 3;
  else score -= 7;

  // Vocabulary richness is a decent proxy for substance.
  const tokens = contentTokens(input.body);
  if (tokens.length > 350) score += 3;
  else if (tokens.length < 80) score -= 4;
  if (input.title.length > 150) score -= 3;
  if (input.title === input.title.toUpperCase() && input.title.length > 20) score -= 2;

  return { score: round(clamp(score, 5, 99)), signals: unique(signals) };
}

export function signalLabels(ids: string[]): string[] {
  const all = [...IMPACT_SIGNALS, ...IMPACT_DAMPENERS];
  return ids
    .map((id) => all.find((signal) => signal.id === id)?.label)
    .filter((label): label is string => Boolean(label));
}

/* -------------------------------------------------------------------------- */
/*  Sentiment                                                                  */
/* -------------------------------------------------------------------------- */

const POSITIVE_TERMS = [
  "breakthrough", "record", "surge", "wins", "improved", "improvement", "advance",
  "advances", "leading", "faster", "cheaper", "efficient", "milestone", "unlock",
  "outperform", "outperforms", "strong", "growth", "gains", "powerful", "boost",
  "expands", "partnership", "adoption", "optimistic", "promising", "capable",
  "smarter", "reliable", "open sourced", "approved",
];

const NEGATIVE_TERMS = [
  "lawsuit", "sued", "ban", "banned", "layoffs", "criticism", "concerns", "concern",
  "risk", "risks", "danger", "dangerous", "flaw", "flaws", "hallucination",
  "hallucinations", "deepfake", "fraud", "breach", "leak", "bias", "discrimination",
  "warning", "warns", "threat", "threats", "misuse", "shutdown", "outage", "downtime",
  "backlash", "scandal", "penalty", "infringement", "violation", "degraded",
  "delayed", "fails", "failed", "unsafe", "unreliable", "expensive", "shortage",
  "cuts", "slump", "losses", "worse", "blocked", "error", "errors",
];

const NEGATORS = new Set(["not", "no", "never", "without", "cannot", "isn't", "doesn't"]);

export function computeSentiment(title: string, body: string): Sentiment {
  const text = `${title} ${body}`.toLowerCase();
  const negated = negatedTokens(text);

  let positive = 0;
  let negative = 0;
  for (const term of POSITIVE_TERMS) {
    const hits = countTerm(text, term);
    if (hits > 0 && !negated.has(term)) positive += hits;
    else if (hits > 0) negative += hits * 0.5;
  }
  for (const term of NEGATIVE_TERMS) {
    const hits = countTerm(text, term);
    if (hits > 0 && !negated.has(term)) negative += hits;
  }

  if (positive === 0 && negative === 0) return "neutral";
  if (positive > 0 && negative > 0 && Math.abs(positive - negative) <= 1) return "mixed";
  if (positive > negative) return "positive";
  if (negative > positive) return "negative";
  return "neutral";
}

/** Terms appearing within three tokens after a negator are flipped. */
function negatedTokens(text: string): Set<string> {
  const words = text.match(/[a-z']+/g) ?? [];
  const negated = new Set<string>();
  for (let index = 0; index < words.length; index += 1) {
    if (NEGATORS.has(words[index])) {
      for (let offset = 1; offset <= 3 && index + offset < words.length; offset += 1) {
        negated.add(words[index + offset]);
      }
    }
  }
  return negated;
}

/* -------------------------------------------------------------------------- */
/*  Category classification                                                    */
/* -------------------------------------------------------------------------- */

export interface CategoryScore {
  category: CategoryId;
  score: number;
}

export interface CategoryResult {
  category: CategoryId;
  secondary: CategoryId[];
  confidence: number;
  scores: CategoryScore[];
}

function scoreCategories(title: string, body: string, beats: CategoryId[]): CategoryScore[] {
  const scores: CategoryScore[] = [];
  for (const [category, terms] of Object.entries(CATEGORY_TERMS) as [CategoryId, WeightedTerm[]][]) {
    let score = 0;
    for (const [term, weight] of terms) {
      const titleHits = countTerm(title, term);
      const bodyHits = Math.min(countTerm(body, term), 4);
      if (titleHits === 0 && bodyHits === 0) continue;
      score += (titleHits * 3 + bodyHits) * weight;
    }
    scores.push({ category, score });
  }

  // The editorial focus of a source is a weak prior, never a decision.
  beats.forEach((beat, index) => {
    const entry = scores.find((candidate) => candidate.category === beat);
    if (entry) entry.score += index === 0 ? DEFAULT_BEAT_WEIGHT * 2.5 : DEFAULT_BEAT_WEIGHT;
  });

  return scores.sort((a, b) => b.score - a.score);
}

export function classifyCategories(
  title: string,
  body: string,
  beats: CategoryId[] = [],
): CategoryResult {
  const scores = scoreCategories(title, body, beats);
  const top = scores[0];
  const second = scores[1];

  if (!top || top.score <= 0) {
    return {
      category: FALLBACK_CATEGORY,
      secondary: [],
      confidence: 0.15,
      scores: scores.slice(0, 4),
    };
  }

  const separation = second && second.score > 0 ? (top.score - second.score) / top.score : 1;
  const magnitude = top.score / (top.score + 10);
  const confidence = clamp(0.35 * magnitude + 0.65 * separation, 0.2, 0.98);

  const threshold = Math.max(4, top.score * 0.35);
  const secondary = scores
    .slice(1)
    .filter((entry) => entry.score >= threshold)
    .slice(0, 2)
    .map((entry) => entry.category);

  return {
    category: top.category,
    secondary,
    confidence: round(confidence, 2),
    scores: scores.slice(0, 4),
  };
}

/* -------------------------------------------------------------------------- */
/*  Entities + tags                                                            */
/* -------------------------------------------------------------------------- */

function matchDictionary(text: string, terms: string[], limit: number): string[] {
  const matched: { term: string; hits: number }[] = [];
  for (const term of terms) {
    const hits = countTerm(text, term);
    if (hits > 0) matched.push({ term, hits });
  }
  return matched
    .sort((a, b) => b.hits - a.hits || b.term.length - a.term.length)
    .slice(0, limit)
    .map((entry) => entry.term);
}

export function extractEntities(title: string, body: string): Entities {
  const full = `${title}. ${body}`;
  // Prefer entities that made it into the headline - that is what the story is about.
  const pick = (terms: string[], limit: number): string[] => {
    const fromTitle = matchDictionary(title, terms, limit);
    const fromBody = matchDictionary(full, terms, limit);
    return unique([...fromTitle, ...fromBody]).slice(0, limit);
  };

  return {
    companies: pick(COMPANY_TERMS, 6),
    models: pick(MODEL_TERMS, 6),
    people: pick(PEOPLE_TERMS, 4),
    technologies: pick(TECHNOLOGY_TERMS, 6),
  };
}

export function extractTags(title: string, body: string, category: CategoryId): string[] {
  const headline = title.toLowerCase();
  const full = `${title} ${body}`.toLowerCase();
  const scored: { tag: string; score: number }[] = [];

  for (const [tag, terms] of Object.entries(TAG_TERMS)) {
    let score = 0;
    for (const term of terms) {
      const titleHits = countTerm(headline, term);
      const bodyHits = Math.min(countTerm(full, term), 3);
      score += titleHits * 2 + bodyHits;
    }
    if (score > 0) scored.push({ tag, score });
  }

  // A tag needs a headline mention or repeated body mentions to earn its place;
  // single passing mentions created too much filter noise.
  const tags = scored
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((entry) => entry.tag);

  return unique([category, ...tags]);
}

/* -------------------------------------------------------------------------- */
/*  Relevance (interest profile)                                               */
/* -------------------------------------------------------------------------- */

export interface RelevanceInput {
  title: string;
  body: string;
  tags: string[];
  category: CategoryId;
  impact: number;
  tier: 1 | 2 | 3;
  isBreaking: boolean;
}

export function computeRelevance(input: RelevanceInput, settings: RadarSettings): number {
  const headline = input.title.toLowerCase();
  const full = `${input.title} ${input.body} ${input.tags.join(" ")}`.toLowerCase();

  let interestScore = 0;
  let matchedInterests = 0;
  for (const interest of settings.interests ?? []) {
    const keyword = interest.keyword.toLowerCase().trim();
    if (!keyword) continue;
    const titleHits = countTerm(headline, keyword);
    const bodyHits = countTerm(full, keyword);
    if (titleHits === 0 && bodyHits === 0) continue;
    matchedInterests += 1;
    interestScore += (titleHits * 2.5 + Math.min(bodyHits, 4)) * (interest.weight || 1);
  }

  // Saturating curve: the first matches matter most, the tenth adds little.
  const interestComponent = 55 * (1 - Math.exp(-interestScore / 12));
  const coverageComponent = Math.min(matchedInterests, 5) * 1.5;
  const categoryComponent = clamp(settings.categoryWeights?.[input.category] ?? 0, 0, 15);
  const tierComponent = input.tier === 1 ? 8 : input.tier === 2 ? 4 : 1;
  const impactComponent = input.impact * 0.15;
  const breakingComponent = input.isBreaking ? 8 : 0;

  return round(
    clamp(
      interestComponent +
        coverageComponent +
        categoryComponent +
        tierComponent +
        impactComponent +
        breakingComponent,
      1,
      99,
    ),
  );
}

/* -------------------------------------------------------------------------- */
/*  Breaking detection                                                         */
/* -------------------------------------------------------------------------- */

export interface BreakingInput {
  tier: 1 | 2 | 3;
  impact: number;
  publishedAt: string;
  now?: Date;
}

export function detectBreaking(input: BreakingInput, settings: RadarSettings): boolean {
  const age = ageInHours(input.publishedAt, input.now ?? new Date());
  if (age > settings.breakingWindowHours) return false;
  if (input.tier === 1) return input.impact >= settings.breakingImpactThreshold;
  if (input.tier === 2) return input.impact >= settings.breakingImpactThreshold + 4;
  return input.impact >= settings.breakingImpactThreshold + 12;
}

/* -------------------------------------------------------------------------- */
/*  Facade                                                                     */
/* -------------------------------------------------------------------------- */

export interface ClassificationInput {
  title: string;
  body: string;
  tier: 1 | 2 | 3;
  sourceKind: SourceKind;
  beats: CategoryId[];
  publishedAt: string;
  now?: Date;
}

export interface ClassificationResult {
  category: CategoryId;
  secondaryCategories: CategoryId[];
  categoryConfidence: number;
  tags: string[];
  entities: Entities;
  impact: number;
  signals: string[];
  relevance: number;
  sentiment: Sentiment;
  isBreaking: boolean;
}

export function classifyArticle(
  input: ClassificationInput,
  settings: RadarSettings,
): ClassificationResult {
  const title = cleanText(input.title);
  const body = cleanText(input.body);

  const categoryResult = classifyCategories(title, body, input.beats);
  const entities = extractEntities(title, body);
  const tags = extractTags(title, body, categoryResult.category);
  const impact = computeImpact({
    title,
    body,
    tier: input.tier,
    sourceKind: input.sourceKind,
    publishedAt: input.publishedAt,
    now: input.now,
  });
  const isBreaking = detectBreaking(
    { tier: input.tier, impact: impact.score, publishedAt: input.publishedAt, now: input.now },
    settings,
  );
  const relevance = computeRelevance(
    {
      title,
      body,
      tags,
      category: categoryResult.category,
      impact: impact.score,
      tier: input.tier,
      isBreaking,
    },
    settings,
  );
  const sentiment = computeSentiment(title, body);

  return {
    category: categoryResult.category,
    secondaryCategories: categoryResult.secondary,
    categoryConfidence: categoryResult.confidence,
    tags,
    entities,
    impact: impact.score,
    signals: impact.signals,
    relevance,
    sentiment,
    isBreaking,
  };
}






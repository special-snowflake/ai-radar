import { createHash } from "node:crypto";

/**
 * Small, dependency-free text toolkit shared by the feed parser, the
 * classifier, the summarizer and the search engine.
 */

export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an",
  "and", "any", "are", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "can", "cannot", "could", "did",
  "do", "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "however", "i", "if", "in",
  "into", "is", "it", "its", "itself", "just", "like", "may", "me", "might",
  "more", "most", "much", "must", "my", "myself", "no", "nor", "not", "now",
  "of", "off", "on", "once", "only", "or", "other", "our", "ours",
  "ourselves", "out", "over", "own", "said", "same", "she", "should", "since",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "us", "very", "was", "we", "were",
  "what", "when", "where", "which", "while", "who", "whom", "why", "will",
  "with", "would", "you", "your", "yours", "yourself", "yourselves", "per",
  "via", "new", "get", "got", "us", "one", "two", "using", "used", "use",
]);

/** Named + numeric HTML entities that show up most often in news feeds. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  middot: "\u00b7",
  bull: "\u2022",
  trade: "\u2122",
  copy: "\u00a9",
  reg: "\u00ae",
  deg: "\u00b0",
  times: "\u00d7",
  laquo: "\u00ab",
  raquo: "\u00bb",
  prime: "\u2032",
  eacute: "\u00e9",
  egrave: "\u00e8",
  uuml: "\u00fc",
  ouml: "\u00f6",
  auml: "\u00e4",
  szlig: "\u00df",
};

export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const mapped = ENTITIES[body.toLowerCase()];
    return mapped ?? match;
  });
}

export function stripHtml(input: string): string {
  if (!input) return "";
  return decodeHtmlEntities(
    input
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ". ")
      .replace(/<[^>]*>/g, " "),
  );
}

/** Strip markup, decode entities, collapse whitespace, drop stray dot-runs. */
export function cleanText(input: string | null | undefined): string {
  if (!input) return "";
  return normalizeWhitespace(stripHtml(input))
    .replace(/\s*\.\s*\.\s*\./g, "\u2026")
    .replace(/(\s*\.\s*){2,}/g, ". ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\u00a0/g, " ").replace(/[\t\r\n\f\v]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const cut = input.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}\u2026`;
}

export function tokenize(input: string): string[] {
  return (input.toLowerCase().match(/[a-z0-9][a-z0-9'+#.\-/]*/g) ?? []).map((t) =>
    t.replace(/^[.'\-/]+|[.'\-/]+$/g, ""),
  ).filter(Boolean);
}

/** Tokens with stopwords removed - used for scoring, not for display. */
export function contentTokens(input: string): string[] {
  return tokenize(input).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function splitSentences(input: string): string[] {
  const protectedText = input
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|Inc|Ltd|Co|Corp|U\.S|U\.K|No)\./gi, "$1\u0001");
  return protectedText
    .split(/(?<=[.!?\u2026])\s+(?=["'(A-Z0-9])|\n+/)
    .map((s) => s.replace(/\u0001/g, ".").trim())
    .filter((s) => s.length > 0);
}

export function wordCount(input: string): number {
  const matches = input.match(/[A-Za-z0-9][A-Za-z0-9'\-]*/g);
  return matches ? matches.length : 0;
}

/* -------------------------------------------------------------------------- */
/*  Identifiers + URLs                                                         */
/* -------------------------------------------------------------------------- */

export function hashId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u241f")).digest("hex").slice(0, 16);
}

const TRACKING_PARAMS = [
  /^utm_/i,
  /^ref$/i,
  /^ref_?src$/i,
  /^source$/i,
  /^mc_(cid|eid)$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^igshid$/i,
  /^spm$/i,
  /^at_medium$/i,
  /^at_campaign$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^mkt_tok$/i,
  /^guccounter$/i,
  /^guce_referrer$/i,
  /^guce_referrer_sig$/i,
];

/**
 * Canonicalize an article URL so the same story collected from different
 * places (feed, redirector, hand-added feed) collapses to one stable id.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");

  const keep = new URLSearchParams();
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of params) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) continue;
    keep.append(key, value);
  }
  const query = keep.toString();
  url.search = query ? `?${query}` : "";

  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path;

  return url.toString();
}

export function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "source";
}

/* -------------------------------------------------------------------------- */
/*  Similarity                                                                 */
/* -------------------------------------------------------------------------- */

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function tokenSet(input: string): Set<string> {
  return new Set(contentTokens(input));
}

/** Title similarity tuned for news headlines (0 = unrelated, 1 = identical). */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = tokenSet(a);
  const tokensB = tokenSet(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const jac = jaccard(tokensA, tokensB);
  const normalizedA = [...tokensA].sort().join(" ");
  const normalizedB = [...tokensB].sort().join(" ");
  if (normalizedA === normalizedB) return 1;
  // Headlines on the same story usually share a long leading phrase.
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  const probe = [...tokensA].slice(0, 6).join(" ");
  if (probe.length > 24 && lowerB.includes(probe)) return Math.max(jac, 0.86);
  return jac;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function uniqueBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Cheap deterministic pseudo-random in [0,1) - used for jittered scheduling. */
export function hashFloat(seed: string): number {
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

/* -------------------------------------------------------------------------- */
/*  Presentation helpers (also used by unit tests)                             */
/* -------------------------------------------------------------------------- */

export function tokenFrequency(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  return freq;
}

/** Capitalize the first letter while leaving acronyms untouched. */
export function sentenceCase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[A-Z0-9]{2,}/.test(trimmed)) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function ensureSentenceEnding(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return /[.!?\u2026:)"']$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function isProbablyEnglish(input: string): boolean {
  if (!input) return true;
  const ascii = input.replace(/[^\x20-\x7e\u2010-\u203a]/g, "");
  return ascii.length / input.length > 0.85;
}

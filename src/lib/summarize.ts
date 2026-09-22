import {
  cleanText,
  contentTokens,
  ensureSentenceEnding,
  sentenceCase,
  splitSentences,
  titleSimilarity,
  tokenFrequency,
  truncate,
  wordCount,
} from "./text";
import type { SummaryMethod } from "./types";

/**
 * Summarization.
 *
 * The default provider is fully offline: a TextRank-flavoured extractive
 * summarizer (tf-weighted sentence scoring + maximal-marginal-relevance
 * de-duplication) that works on whatever a feed gives us - often just a title
 * plus a description. When an LLM key is configured and the item is important
 * enough, the scanner can opt into `llm` summaries instead; every failure path
 * falls back to the extractive result so the dashboard never shows an empty
 * card.
 */

const BOILERPLATE = [
  /\bread more\b/i,
  /\bcontinue reading\b/i,
  /\bsubscribe\b/i,
  /\bsign up for\b/i,
  /\bnewsletter\b/i,
  /\ball rights reserved\b/i,
  /\bshare this\b/i,
  /\bfollow us on\b/i,
  /\badvertisement\b/i,
  /\bsponsored (content|post|by)\b/i,
  /\bappeared first on\b/i,
  /\bthis (post|article) .{0,40}appeared\b/i,
  /\bclick here\b/i,
  /\b(read|watch|listen) (the )?(full|more)\b/i,
  /\bphoto(graph)?(:| by)\b/i,
  /\bimage (credit|source)s?\b/i,
  /\bgetty images\b/i,
  /\bterms of service\b/i,
  /\bprivacy policy\b/i,
  /\bcookie(s)? (policy|settings)\b/i,
  /\bthe views expressed\b/i,
  /\bdisclosure\b/i,
  /\bjob (posting|opening)\b/i,
  /\bwe are hiring\b/i,
  /\bregister (now|today)\b/i,
  /\bwebinar\b/i,
  /\bpress release\b/i,
];

/** Phrases that carry editorial weight in AI/tech reporting. */
const CUE_PHRASES = [
  "announced",
  "announces",
  "launched",
  "launches",
  "released",
  "releases",
  "introduced",
  "unveiled",
  "open sourced",
  "open-sourced",
  "raised",
  "raises",
  "valued at",
  "acquired",
  "acquisition",
  "according to",
  "the study",
  "researchers found",
  "benchmark",
  "state of the art",
  "state-of-the-art",
  "outperforms",
  "beats",
  "pricing",
  "available today",
  "generally available",
  "regulation",
  "ruling",
  "lawsuit",
  "the company said",
];

export interface SummarizeOptions {
  /** How many sentences the abstract may contain. */
  maxSentences?: number;
  /** How many bullets to return in `keyPoints`. */
  maxKeyPoints?: number;
  /** Category/tag hints that bias sentence scoring. */
  focusTerms?: string[];
  sourceName?: string;
}

export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  method: SummaryMethod;
}

/* -------------------------------------------------------------------------- */
/*  Offline extractive summarizer                                              */
/* -------------------------------------------------------------------------- */

function isUsableSentence(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.length < 45) return false;
  if (trimmed.length > 420) return false;
  if (wordCount(trimmed) < 8) return false;
  if (BOILERPLATE.some((pattern) => pattern.test(trimmed))) return false;
  // Mostly a link list, byline or navigation junk.
  if (/https?:\/\//.test(trimmed) && trimmed.split(" ").length < 12) return false;
  if (/^[A-Z0-9 ,.&'\-:]+$/.test(trimmed) && trimmed.length < 70) return false;
  if ((trimmed.match(/\|/g) ?? []).length >= 2) return false;
  return true;
}

function scoreSentences(sentences: string[], title: string, focusTerms: string[]): number[] {
  const freq = tokenFrequency(contentTokens(sentences.join(" ")));
  const maxFreq = Math.max(1, ...freq.values());
  const titleTokens = new Set(contentTokens(title));
  const focus = focusTerms.map((term) => term.toLowerCase()).filter(Boolean);

  return sentences.map((sentence, index) => {
    const tokens = contentTokens(sentence);
    if (tokens.length === 0) return 0;

    // Term-frequency weight, normalised so long sentences do not dominate.
    let tfScore = 0;
    for (const token of tokens) tfScore += (freq.get(token) ?? 0) / maxFreq;
    let score = (tfScore / tokens.length) * 10;

    // Prefer sentences that restate the headline (that is the lead).
    const overlap = tokens.filter((token) => titleTokens.has(token)).length;
    score += (overlap / tokens.length) * 6;

    // Strong lead bias, decaying.
    if (index === 0) score += 3.2;
    else if (index === 1) score += 2.1;
    else if (index === 2) score += 1.2;
    else if (index < 6) score += 0.5;

    const lower = sentence.toLowerCase();
    for (const cue of CUE_PHRASES) {
      if (lower.includes(cue)) score += 0.6;
    }
    for (const term of focus) {
      if (term.length > 2 && lower.includes(term)) score += 0.5;
    }

    // Quantities matter in this domain (funding, params, benchmarks, dates).
    if (/[$€£]\s?\d|\b\d+(\.\d+)?\s?(billion|million|bn)%?\b|\b\d+(\.\d+)?%/i.test(sentence)) {
      score += 0.9;
    }
    // Penalise quote-heavy, first-person and question sentences.
    if (/^["']/.test(sentence.trim())) score -= 0.4;
    if (/\b(we|our)\b/i.test(sentence) && !/\bwe believe\b/i.test(sentence)) score -= 0.5;
    if (sentence.trim().endsWith("?")) score -= 0.6;
    // Very long sentences are usually clause soup.
    if (tokens.length > 45) score -= 0.8;

    return score;
  });
}

/** Greedy maximal-marginal-relevance selection. */
function selectSentences(
  sentences: string[],
  scores: number[],
  limit: number,
  minSimilarity = 0.55,
): number[] {
  const picked: number[] = [];
  const candidates = sentences.map((_, index) => index).sort((a, b) => scores[b] - scores[a]);

  for (const index of candidates) {
    if (picked.length >= limit) break;
    if (scores[index] <= 0) continue;
    const redundant = picked.some(
      (chosen) => titleSimilarity(sentences[chosen], sentences[index]) > minSimilarity,
    );
    if (!redundant) picked.push(index);
  }

  // If de-duplication removed everything, fall back to raw top scores.
  if (picked.length === 0) {
    return candidates.slice(0, Math.max(1, Math.min(limit, candidates.length)));
  }
  return picked.sort((a, b) => a - b);
}

function toBullet(sentence: string): string {
  const bullet = cleanText(sentence)
    .replace(/^(and|but|so|also|meanwhile|however|in addition|additionally)\s+/i, "")
    .replace(/^(that|which)\s+/i, "")
    .replace(/\s*\([^)]{0,80}\)\s*$/, "")
    .trim();
  return sentenceCase(ensureSentenceEnding(truncate(bullet, 170)));
}

export function summarizeExtractive(
  title: string,
  body: string,
  options: SummarizeOptions = {},
): SummaryResult {
  const maxSentences = options.maxSentences ?? 3;
  const maxKeyPoints = options.maxKeyPoints ?? 3;
  const cleanedTitle = cleanText(title);
  const cleanedBody = cleanText(body);
  const focusTerms = options.focusTerms ?? [];

  const sentences = splitSentences(cleanedBody).filter(isUsableSentence);

  if (sentences.length === 0) {
    const fallback = truncate(cleanedBody || cleanedTitle, 260);
    return {
      summary: ensureSentenceEnding(fallback),
      keyPoints: [],
      method: "excerpt",
    };
  }

  const scores = scoreSentences(sentences, cleanedTitle, focusTerms);
  const chosen = selectSentences(sentences, scores, maxSentences);
  const summary = chosen.map((index) => ensureSentenceEnding(sentences[index])).join(" ");

  const bulletIndexes = selectSentences(sentences, scores, maxSentences + maxKeyPoints, 0.45)
    .filter((index) => !chosen.includes(index))
    .slice(0, maxKeyPoints);

  const keyPoints = bulletIndexes.map((index) => toBullet(sentences[index])).filter(Boolean);

  return {
    summary: summary.length > 20 ? summary : ensureSentenceEnding(truncate(cleanedBody, 260)),
    keyPoints,
    method: "extractive",
  };
}

/* -------------------------------------------------------------------------- */
/*  Optional LLM summarizer                                                    */
/* -------------------------------------------------------------------------- */

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function llmConfigFromEnv(): LlmConfig | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  };
}

const LLM_SYSTEM_PROMPT = [
  "You are the summarization engine of an AI industry intelligence radar.",
  'Return STRICT JSON of the shape {"summary": string, "keyPoints": string[]}.',
  "summary: 2-3 sentences, factual, no marketing language, no preamble, at most 420 characters.",
  "keyPoints: at most 3 bullets, each under 140 characters, concrete (numbers, model names, dates).",
  "Never invent facts that are not present in the supplied text. Use plain ASCII punctuation.",
].join(" ");

export async function summarizeWithLlm(
  title: string,
  body: string,
  config: LlmConfig,
  options: SummarizeOptions = {},
): Promise<SummaryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: LLM_SYSTEM_PROMPT },
          {
            role: "user",
            content: `SOURCE: ${options.sourceName ?? "unknown"}\nTITLE: ${title}\n\nCONTENT:\n${truncate(
              cleanText(body),
              6000,
            )}`,
          },
        ],
      }),
    });

    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned no content");

    const parsed = JSON.parse(content) as { summary?: string; keyPoints?: unknown };
    const summary = cleanText(parsed.summary ?? "");
    if (summary.length < 20) throw new Error("LLM summary too short");

    const keyPoints = Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.filter(
          (point): point is string => typeof point === "string" && point.trim().length > 0,
        )
      : [];

    return {
      summary: truncate(summary, 480),
      keyPoints: keyPoints.slice(0, 4).map((point) => truncate(cleanText(point), 180)),
      method: "llm",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* -------------------------------------------------------------------------- */
/*  Facade used by the scanner                                                 */
/* -------------------------------------------------------------------------- */

export interface SummarizeRequest {
  title: string;
  body: string;
  sourceName: string;
  focusTerms?: string[];
  /** Article impact, used to decide whether an LLM call is worth it. */
  impact?: number;
  useLlm?: boolean;
}

export async function summarizeArticle(
  request: SummarizeRequest,
  options: SummarizeOptions = {},
): Promise<SummaryResult> {
  const offline = summarizeExtractive(request.title, request.body, {
    ...options,
    sourceName: request.sourceName,
    focusTerms: request.focusTerms,
  });

  if (!request.useLlm) return offline;

  const config = llmConfigFromEnv();
  if (!config) return offline;

  const minImpact = Number.parseInt(process.env.LLM_SUMMARY_MIN_IMPACT ?? "70", 10);
  if ((request.impact ?? 0) < minImpact) return offline;

  try {
    const llmResult = await summarizeWithLlm(request.title, request.body, config, {
      ...options,
      sourceName: request.sourceName,
    });
    return {
      summary: llmResult.summary,
      keyPoints: llmResult.keyPoints.length > 0 ? llmResult.keyPoints : offline.keyPoints,
      method: "llm",
    };
  } catch (error) {
    console.warn(
      `[ai-radar] LLM summary failed for "${truncate(request.title, 60)}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return offline;
  }
}


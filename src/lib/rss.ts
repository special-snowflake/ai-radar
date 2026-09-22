import { XMLParser } from "fast-xml-parser";
import { canonicalizeUrl, cleanText, isProbablyEnglish, truncate } from "./text";

/**
 * Feed ingestion: HTTP fetch with timeout/retry plus a tolerant RSS 2.0 /
 * Atom / RDF parser. Real-world feeds are messy - namespaced tags, CDATA,
 * `<link>` as an attribute instead of a node, dates in five formats - so the
 * parser normalizes everything into one `FeedItem` shape and skips anything it
 * cannot make sense of instead of throwing.
 */

export interface FeedItem {
  title: string;
  url: string;
  canonicalUrl: string;
  author: string | null;
  publishedAt: string | null;
  excerpt: string;
  content: string;
  categories: string[];
}

export interface ParsedFeed {
  feedTitle: string;
  siteUrl: string | null;
  items: FeedItem[];
}

export interface FetchFeedOptions {
  timeoutMs?: number;
  userAgent?: string;
  retries?: number;
}

export interface FetchFeedResult {
  ok: boolean;
  status: number;
  body: string;
  error: string | null;
  durationMs: number;
  notModified?: boolean;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; ai-radar/1.0; +https://github.com/ai-radar)";

/** Fetch a feed document with a hard timeout and one bounded retry. */
export async function fetchFeed(url: string, options: FetchFeedOptions = {}): Promise<FetchFeedResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 1;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const started = Date.now();
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": userAgent,
          accept:
            "application/rss+xml, application/atom+xml, application/xml, application/json;q=0.8, text/xml;q=0.8, */*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
        },
      });
      const body = await response.text();
      clearTimeout(timer);
      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`.trim();
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return { ok: false, status: response.status, body, error: lastError, durationMs: Date.now() - started };
        }
        continue;
      }
      return { ok: true, status: response.status, body, error: null, durationMs: Date.now() - started };
    } catch (error) {
      clearTimeout(timer);
      lastError =
        error instanceof Error
          ? error.name === "AbortError"
            ? `timed out after ${timeoutMs}ms`
            : error.message
          : String(error);
      // Small backoff before the retry, keeps us friendly to rate limits.
      if (attempt < retries) await sleep(600 * (attempt + 1));
    }
  }

  return { ok: false, status: 0, body: "", error: lastError ?? "unknown error", durationMs: Date.now() - started };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  cdataPropName: "__cdata",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry"].includes(name.toLowerCase()),
});

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Pull text out of the many shapes fast-xml-parser can produce. */
function nodeText(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) {
    for (const entry of node) {
      const text = nodeText(entry);
      if (text) return text;
    }
    return null;
  }
  if (typeof node === "object") {
    const record = node as XmlNode;
    const candidates = [
      record["#text"],
      record.__cdata,
      record["@_href"],
      record["@_url"],
      record["@_term"],
    ];
    for (const candidate of candidates) {
      const text = nodeText(candidate);
      if (text) return text;
    }
  }
  return null;
}

function firstField(record: XmlNode, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function extractLink(record: XmlNode, keys: string[]): string | null {
  const raw = firstField(record, keys);
  if (!raw) return null;
  const entries = asArray(raw);
  // Atom feeds often expose <link rel="self"> or an enclosure alongside the
  // canonical <link rel="alternate">, so prefer the alternate one.
  const preferred =
    entries.find((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const rel = (entry as XmlNode)["@_rel"];
      return rel === undefined || rel === "alternate";
    }) ?? entries[0];
  const href =
    typeof preferred === "object" && preferred !== null
      ? nodeText((preferred as XmlNode)["@_href"]) ?? nodeText(preferred)
      : nodeText(preferred);
  return href ? href.trim() : null;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  const parsed = Date.parse(cleaned);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  // Some feeds emit "2026-09-19 14:03:00 +0000" which Date.parse dislikes.
  const normalized = cleaned.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, "$1T$2");
  const retry = Date.parse(normalized);
  if (Number.isFinite(retry)) return new Date(retry).toISOString();
  const retry2 = Date.parse(normalized.replace(/\s+([+-]\d{4})$/, "+00:00"));
  return Number.isFinite(retry2) ? new Date(retry2).toISOString() : null;
}

function firstBody(record: XmlNode): string {
  const candidates = ["encoded", "content", "description", "summary", "subtitle", "body"];
  let best = "";
  for (const key of candidates) {
    const text = nodeText(record[key]);
    if (text && text.length > best.length) best = text;
  }
  return best;
}

/** Parse an RSS 2.0, RDF or Atom document into normalized items. */
export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const trimmed = xml.trim();
  if (!trimmed) return { feedTitle: feedUrl, siteUrl: null, items: [] };
  if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, feedUrl);

  let document: XmlNode;
  try {
    document = parser.parse(trimmed) as XmlNode;
  } catch {
    return { feedTitle: feedUrl, siteUrl: null, items: [] };
  }

  const rss = document.rss as XmlNode | undefined;
  const rdf = document.RDF as XmlNode | undefined;
  const atom = document.feed as XmlNode | undefined;
  const channel = rss?.channel as XmlNode | undefined;

  const container: XmlNode = channel ?? rdf ?? atom ?? document;
  const feedTitle = nodeText(firstField(container, ["title", "name"])) ?? feedUrl;
  const siteUrl = extractLink(container, ["link"]) ?? nodeText(firstField(container, ["id"]));

  const rawItems = [
    ...asArray(channel?.item as XmlNode | XmlNode[] | undefined),
    ...asArray(rdf?.item as XmlNode | XmlNode[] | undefined),
    ...asArray(atom?.entry as XmlNode | XmlNode[] | undefined),
  ];

  const items: FeedItem[] = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const title = cleanText(nodeText(firstField(rawItem, ["title", "name"])));
    const link = extractLink(rawItem, ["link", "guid", "id", "origLink"]);
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;

    const body = cleanText(firstBody(rawItem));
    const excerpt = truncate(body, 460);
    const authorRaw = nodeText(firstField(rawItem, ["creator", "author", "byline"]));
    const publishedAt = parseDate(
      nodeText(firstField(rawItem, ["pubDate", "published", "updated", "date", "issued"])),
    );
    const categories = asArray(firstField(rawItem, ["category", "subject", "keywords"]))
      .map((entry) => cleanText(nodeText(entry)))
      .filter((value): value is string => Boolean(value))
      .slice(0, 8);

    if (!isProbablyEnglish(`${title} ${excerpt}`)) continue;

    items.push({
      title,
      url: link,
      canonicalUrl: canonicalizeUrl(link),
      author: authorRaw ? cleanText(authorRaw).slice(0, 120) : null,
      publishedAt,
      excerpt,
      content: body,
      categories,
    });
  }

  return { feedTitle: cleanText(feedTitle), siteUrl: siteUrl ?? null, items };
}

interface JsonFeedEntry {
  title?: string;
  url?: string;
  external_url?: string;
  date_published?: string;
  date_modified?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  author?: { name?: string };
  tags?: string[];
}

function parseJsonFeed(raw: string, feedUrl: string): ParsedFeed {
  try {
    const document = JSON.parse(raw) as {
      title?: string;
      home_page_url?: string;
      items?: JsonFeedEntry[];
    };
    const items: FeedItem[] = [];
    for (const entry of document.items ?? []) {
      const title = cleanText(entry.title ?? "");
      const link = entry.url ?? entry.external_url;
      if (!title || !link) continue;
      const body = cleanText(entry.content_text ?? entry.content_html ?? entry.summary ?? "");
      items.push({
        title,
        url: link,
        canonicalUrl: canonicalizeUrl(link),
        author: entry.author?.name ? cleanText(entry.author.name).slice(0, 120) : null,
        publishedAt: parseDate(entry.date_published ?? entry.date_modified ?? null),
        excerpt: truncate(body, 460),
        content: body,
        categories: (entry.tags ?? []).slice(0, 8),
      });
    }
    return {
      feedTitle: cleanText(document.title ?? feedUrl),
      siteUrl: document.home_page_url ?? null,
      items,
    };
  } catch {
    return { feedTitle: feedUrl, siteUrl: null, items: [] };
  }
}

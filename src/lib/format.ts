import type { Sentiment, SourceKind, SourceStatus, SummaryMethod } from "./types";

/**
 * Presentation helpers shared by server and client components.
 * No Node APIs here - this file is imported from the browser bundle.
 */

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "unknown";
  const delta = now - timestamp;
  if (delta < 0) return "scheduled";
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < 30 * DAY) return `${Math.floor(delta / (7 * DAY))}w ago`;
  return `${Math.floor(delta / (30 * DAY))}mo ago`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "-";
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export interface Band {
  label: string;
  className: string;
  ring: string;
}

export function impactBand(score: number): Band {
  if (score >= 85) {
    return {
      label: "Critical",
      className: "bg-rose-500/15 text-rose-300 border-rose-500/30",
      ring: "#fb7185",
    };
  }
  if (score >= 70) {
    return {
      label: "High",
      className: "bg-amber-500/15 text-amber-300 border-amber-500/30",
      ring: "#fbbf24",
    };
  }
  if (score >= 50) {
    return {
      label: "Notable",
      className: "bg-sky-500/15 text-sky-300 border-sky-500/30",
      ring: "#38bdf8",
    };
  }
  return {
    label: "Routine",
    className: "bg-slate-500/15 text-slate-300 border-slate-500/30",
    ring: "#94a3b8",
  };
}

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  lab: "Lab",
  vendor: "Vendor",
  research: "Research",
  media: "Media",
  community: "Community",
  policy: "Policy",
  aggregator: "Aggregator",
};

export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  ok: "OK",
  empty: "No items",
  error: "Error",
  never: "Not scanned",
};

export const SOURCE_STATUS_CLASS: Record<SourceStatus, string> = {
  ok: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  empty: "text-slate-300 bg-slate-500/10 border-slate-500/30",
  error: "text-rose-300 bg-rose-500/10 border-rose-500/30",
  never: "text-amber-300 bg-amber-500/10 border-amber-500/30",
};

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  mixed: "Mixed",
};

export const SENTIMENT_CLASS: Record<Sentiment, string> = {
  positive: "text-emerald-300",
  neutral: "text-slate-400",
  negative: "text-rose-300",
  mixed: "text-amber-300",
};

export const SUMMARY_METHOD_LABEL: Record<SummaryMethod, string> = {
  extractive: "Extractive summary",
  llm: "LLM summary",
  excerpt: "Feed excerpt",
};

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

export function truncateMiddle(input: string, max = 60): string {
  if (input.length <= max) return input;
  const half = Math.floor((max - 1) / 2);
  return `${input.slice(0, half)}\u2026${input.slice(-half)}`;
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function pct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

export const TIER_LABELS: Record<1 | 2 | 3, string> = {
  1: "Primary sources",
  2: "Solid reporting",
  3: "Community",
};

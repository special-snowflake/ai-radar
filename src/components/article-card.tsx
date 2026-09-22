"use client";

import Link from "next/link";
import { useState } from "react";
import { ImpactBadge, SourceAvatar, TagChip } from "@/components/ui";
import { cn, relativeTime, SENTIMENT_CLASS } from "@/lib/format";
import type { Article } from "@/lib/types";
import { categoryMeta } from "@/lib/types";

export interface ArticleCardProps {
  article: Article;
  homepage?: string | null;
  sourceLabel: string;
  selected?: boolean;
  selectionMode?: boolean;
  onSelect?: (id: string, selected: boolean) => void;
  onToggleRead?: (article: Article) => void;
  onToggleBookmark?: (article: Article) => void;
  onTagClick?: (tag: string) => void;
  onCategoryClick?: (category: string) => void;
  onOpen?: (article: Article) => void;
}

export function ArticleCard({
  article,
  homepage,
  sourceLabel,
  selected = false,
  selectionMode = false,
  onSelect,
  onToggleRead,
  onToggleBookmark,
  onTagClick,
  onCategoryClick,
  onOpen,
}: ArticleCardProps) {
  const [copied, setCopied] = useState(false);
  const meta = categoryMeta(article.category);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(article.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article
      className={cn(
        "panel panel-hover relative overflow-hidden p-4",
        selected && "border-radar-400/70",
        !article.read && "shadow-[inset_3px_0_0_0_rgba(124,140,255,0.9)]",
      )}
    >
      {article.isBreaking ? (
        <span className="absolute right-0 top-0 rounded-bl-lg bg-rose-500/20 px-2 py-0.5 text-[0.62rem] font-bold tracking-[0.14em] text-rose-200 uppercase">
          breaking
        </span>
      ) : null}

      <div className="flex gap-3">
        {selectionMode ? (
          <label className="flex items-start pt-1">
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onSelect?.(article.id, event.target.checked)}
              className="h-4 w-4 accent-indigo-400"
              aria-label={`Select ${article.title}`}
            />
          </label>
        ) : null}

        <div className="flex w-12 shrink-0 flex-col items-center gap-1.5">
          <ImpactBadge score={article.impact} />
          <span
            className="rounded px-1 py-0.5 text-[0.58rem] font-semibold tracking-wide text-slate-400"
            title={`Relevance to your interest profile: ${article.relevance}/100`}
          >
            rel {article.relevance}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <SourceAvatar name={sourceLabel} homepage={homepage} size={14} />
              <span className="text-slate-300">{sourceLabel}</span>
            </span>
            <span aria-hidden className="text-slate-600">
              ·
            </span>
            <time dateTime={article.publishedAt} suppressHydrationWarning>
              {relativeTime(article.publishedAt)}
            </time>
            <span aria-hidden className="text-slate-600">
              ·
            </span>
            <button
              type="button"
              onClick={() => onCategoryClick?.(article.category)}
              className="inline-flex items-center gap-1 rounded px-1 hover:bg-white/10"
              title={meta.blurb}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.accent }} aria-hidden />
              {meta.short}
            </button>
            <span className={cn("text-[0.7rem]", SENTIMENT_CLASS[article.sentiment])}>
              {article.sentiment}
            </span>
            {article.summaryMethod === "llm" ? (
              <span className="rounded border border-violet-500/30 bg-violet-500/10 px-1 text-[0.62rem] text-violet-200">
                AI summary
              </span>
            ) : null}
          </div>

          <h3 className="mt-1.5 text-[0.98rem] font-semibold leading-snug text-slate-100">
            <Link
              href={`/article/${article.id}`}
              onClick={() => onOpen?.(article)}
              className="hover:text-white hover:underline decoration-radar-400/60 underline-offset-2"
            >
              {article.title}
            </Link>
          </h3>

          <p className="mt-1.5 text-[0.83rem] leading-relaxed text-slate-400 line-clamp-3-custom">
            {article.summary || article.excerpt}
          </p>

          {article.keyPoints.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {article.keyPoints.slice(0, 3).map((point) => (
                <li key={point} className="flex gap-2 text-[0.78rem] text-slate-400">
                  <span className="mt-[0.35rem] h-1 w-1 shrink-0 rounded-full bg-radar-400" aria-hidden />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {article.tags.slice(0, 5).map((tag) => (
              <button key={tag} type="button" onClick={() => onTagClick?.(tag)} className="cursor-pointer">
                <TagChip tag={tag} />
              </button>
            ))}
            {article.alsoCoveredBy.length > 0 ? (
              <span className="chip border-amber-500/25 bg-amber-500/10 text-[0.68rem] text-amber-200">
                also on {article.alsoCoveredBy.length} source{article.alsoCoveredBy.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {article.entities.companies.length > 0 || article.entities.models.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1 text-[0.68rem] text-slate-500">
              {[...article.entities.companies, ...article.entities.models].slice(0, 6).map((entity) => (
                <span key={entity} className="rounded bg-white/5 px-1.5 py-0.5">
                  {entity}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex w-8 shrink-0 flex-col items-center gap-1.5">
          <button
            type="button"
            className={cn(
              "rounded-md px-1.5 py-1 text-sm leading-none transition",
              article.bookmarked ? "bg-amber-500/20 text-amber-200" : "text-slate-500 hover:bg-white/10",
            )}
            onClick={() => onToggleBookmark?.(article)}
            title={article.bookmarked ? "Remove bookmark" : "Bookmark"}
            aria-pressed={article.bookmarked}
          >
            {article.bookmarked ? "\u2605" : "\u2606"}
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-1.5 py-1 text-xs leading-none transition",
              article.read ? "text-slate-600 hover:bg-white/10" : "bg-radar-500/20 text-radar-100",
            )}
            onClick={() => onToggleRead?.(article)}
            title={article.read ? "Mark unread" : "Mark read"}
            aria-pressed={article.read}
          >
            {article.read ? "\u25cb" : "\u25cf"}
          </button>
          <a
            href={article.url}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-white/10 hover:text-slate-200"
            title="Open original article"
          >
            {"\u2197"}
          </a>
          <button
            type="button"
            onClick={copyLink}
            className="rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-white/10 hover:text-slate-200"
            title="Copy link"
          >
            {copied ? "\u2713" : "\u29c9"}
          </button>
        </div>
      </div>
    </article>
  );
}

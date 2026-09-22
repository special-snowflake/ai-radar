import Link from "next/link";
import { notFound } from "next/navigation";
import { ArticleActions } from "@/components/article-actions";
import { CategoryChip, ImpactBadge, SourceAvatar, StatusPill, TagChip } from "@/components/ui";
import { signalLabels } from "@/lib/classify";
import {
  SENTIMENT_CLASS,
  SUMMARY_METHOD_LABEL,
  formatDateTime,
  hostLabel,
  relativeTime,
} from "@/lib/format";
import { getArticleDetail } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";
import { categoryMeta } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureStoreLoaded();
  const detail = getArticleDetail(id);
  if (!detail) notFound();

  const { article, source, related, coverage } = detail;
  const meta = categoryMeta(article.category);
  const signals = signalLabels(article.signals);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-white">
          ← back to radar
        </Link>
        <span className="text-slate-600">/</span>
        <span className="font-mono">{hostLabel(article.canonicalUrl)}</span>
        {article.isBreaking ? <StatusPill tone="error">breaking</StatusPill> : null}
        {article.read ? <StatusPill tone="neutral">read</StatusPill> : <StatusPill tone="warn">unread</StatusPill>}
      </div>

      <article className="panel space-y-5 p-5">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <SourceAvatar name={article.sourceName} homepage={source?.homepage ?? null} size={16} />
              <a
                href={source?.homepage ?? article.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-slate-200 hover:text-white"
              >
                {article.sourceName}
              </a>
            </span>
            <span className="text-slate-600">·</span>
            <time dateTime={article.publishedAt} suppressHydrationWarning>
              {formatDateTime(article.publishedAt)} ({relativeTime(article.publishedAt)})
            </time>
            <Link href={`/?categories=${article.category}`}>
              <CategoryChip id={article.category} label={meta.label} active />
            </Link>
            <span className={`text-[0.72rem] ${SENTIMENT_CLASS[article.sentiment]}`}>
              {article.sentiment}
            </span>
            <span className="chip">{SUMMARY_METHOD_LABEL[article.summaryMethod]}</span>
          </div>

          <h1 className="text-xl font-semibold leading-snug text-white sm:text-2xl">{article.title}</h1>

          <div className="flex flex-wrap items-center gap-3">
            <ImpactBadge score={article.impact} />
            <span className="text-xs text-slate-400">
              relevance <span className="font-mono text-slate-200">{article.relevance}</span>
            </span>
            <span className="text-xs text-slate-400">
              confidence{" "}
              <span className="font-mono text-slate-200">{Math.round(article.categoryConfidence * 100)}%</span>
            </span>
            {article.author ? <span className="text-xs text-slate-400">by {article.author}</span> : null}
            <span className="text-xs text-slate-500">
              {article.wordCount} words · {article.readingMinutes} min read
            </span>
          </div>
        </header>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Summary</h2>
          <p className="text-[0.92rem] leading-relaxed text-slate-200">{article.summary}</p>
          {article.keyPoints.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {article.keyPoints.map((point) => (
                <li key={point} className="flex gap-2 text-[0.85rem] text-slate-400">
                  <span className="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full bg-radar-400" aria-hidden />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {signals.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
              Why it scored {article.impact}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {signals.map((signal) => (
                <span key={signal} className="chip text-slate-300">
                  {signal}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Entities</h2>
          <div className="space-y-2 text-[0.85rem]">
            <EntityRow label="Companies" items={article.entities.companies} />
            <EntityRow label="Models" items={article.entities.models} />
            <EntityRow label="People" items={article.entities.people} />
            <EntityRow label="Technologies" items={article.entities.technologies} />
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Tags</h2>
          <div className="flex flex-wrap gap-1.5">
            {article.tags.map((tag) => (
              <Link key={tag} href={`/?tags=${encodeURIComponent(tag)}`}>
                <TagChip tag={tag} />
              </Link>
            ))}
            {article.tags.length === 0 ? <span className="text-xs text-slate-500">none extracted</span> : null}
          </div>
        </section>

        {coverage.length > 1 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
              Also covered by ({coverage.length - 1})
            </h2>
            <ul className="space-y-1.5 text-[0.85rem]">
              {coverage
                .filter((item) => item.id !== article.id)
                .map((item) => (
                  <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
                    <Link href={`/article/${item.id}`} className="text-radar-300 hover:text-radar-200">
                      {item.sourceName}
                    </Link>
                    <span className="text-slate-400">{item.title}</span>
                    <time
                      dateTime={item.publishedAt}
                      suppressHydrationWarning
                      className="text-xs text-slate-500"
                    >
                      {relativeTime(item.publishedAt)}
                    </time>
                  </li>
                ))}
            </ul>
            <p className="text-xs text-slate-500">
              Cross-source dedupe folded these reports into this record; the source mix is a rough signal of how
              widely the story is being carried.
            </p>
          </section>
        ) : null}

        {related.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
              Related updates
            </h2>
            <ul className="space-y-1.5 text-[0.85rem]">
              {related.map((item) => (
                <li key={item.id}>
                  <Link href={`/article/${item.id}`} className="text-slate-300 hover:text-white">
                    <span className="font-mono text-xs text-slate-500">{item.impact}</span> {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="grid gap-2 border-t border-slate-800/70 pt-4 text-xs text-slate-500 sm:grid-cols-2">
          <p>fetched {formatDateTime(article.fetchedAt)}</p>
          <p className="sm:text-right">stored id {article.id}</p>
          <p className="sm:col-span-2 break-all">canonical: {article.canonicalUrl}</p>
        </section>

        <ArticleActions
          articleId={article.id}
          url={article.url}
          initialRead={article.read}
          initialBookmarked={article.bookmarked}
        />
      </article>
    </div>
  );
}

function EntityRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-slate-500">{label}</span>
      {items.length > 0 ? (
        <span className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Link key={item} href={`/?q=${encodeURIComponent(`"${item}"`)}`} className="chip text-slate-300">
              {item}
            </Link>
          ))}
        </span>
      ) : (
        <span className="text-xs text-slate-600">—</span>
      )}
    </div>
  );
}

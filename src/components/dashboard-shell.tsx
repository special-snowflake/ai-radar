"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArticleCard } from "@/components/article-card";
import { FilterRail, type SourceOption } from "@/components/filter-rail";
import { RadarRail } from "@/components/radar-rail";
import { buildUpdateParams, type DashboardQueryState } from "@/lib/dashboard-query";
import { BarList, EmptyState, MetricCard, SectionHeading, Sparkline, StatusPill } from "@/components/ui";
import { useRadarLive } from "@/hooks/use-radar-live";
import { cn, formatNumber, relativeTime } from "@/lib/format";
import type { RadarStats, ScanRun, UpdateQueryResult } from "@/lib/types";

export interface DashboardShellProps {
  initialData: UpdateQueryResult;
  initialQuery: DashboardQueryState;
  sources: SourceOption[];
  stats: RadarStats;
  runs: ScanRun[];
  scheduler: { enabled: boolean; nextRunAt: string | null; intervalMinutes: number; running: boolean };
}

export function DashboardShell({
  initialData,
  initialQuery,
  sources,
  stats,
  runs,
  scheduler,
}: DashboardShellProps) {
  const router = useRouter();
  const [query, setQuery] = useState<DashboardQueryState>(initialQuery);
  const [data, setData] = useState<UpdateQueryResult>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);
  const firstRun = useRef(true);

  // Keep the URL shareable without triggering a Next.js navigation.
  useEffect(() => {
    const params = buildUpdateParams(query);
    window.history.replaceState(null, "", params ? `/?${params}` : "/");
  }, [query]);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/updates?${buildUpdateParams(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`request failed (${response.status})`);
        setData((await response.json()) as UpdateQueryResult);
        setError(null);
      } catch (fetchError) {
        if (controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : "request failed");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, nonce]);

  const live = useRadarLive(() => setNonce((value) => value + 1));

  const sourceIndex = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);

  const patchQuery = useCallback((patch: Partial<DashboardQueryState>) => {
    setQuery((previous) => ({ ...previous, ...patch }));
  }, []);

  const resetQuery = useCallback(() => {
    setQuery({
      ...initialQuery,
      q: "",
      categories: [],
      sources: [],
      tags: [],
      minImpact: 0,
      breakingOnly: false,
      unreadOnly: false,
      bookmarkedOnly: false,
      window: "all",
      page: 1,
    });
  }, [initialQuery]);

  const patchArticle = useCallback(
    async (id: string, patch: { read?: boolean; bookmarked?: boolean }) => {
      setData((previous) => ({
        ...previous,
        items: previous.items.map((article) => (article.id === id ? { ...article, ...patch } : article)),
      }));
      try {
        await fetch(`/api/updates/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
      } catch {
        setError("could not save that change");
      }
    },
    [],
  );

  const bulk = useCallback(
    async (action: string) => {
      try {
        await fetch("/api/updates/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, ids: selected }),
        });
        setSelected([]);
        setNonce((value) => value + 1);
        router.refresh();
      } catch {
        setError("bulk action failed");
      }
    },
    [router, selected],
  );

  const activeFilters =
    query.categories.length +
    query.sources.length +
    query.tags.length +
    (query.minImpact > 0 ? 1 : 0) +
    (query.breakingOnly ? 1 : 0) +
    (query.unreadOnly ? 1 : 0) +
    (query.bookmarkedOnly ? 1 : 0) +
    (query.window !== "all" ? 1 : 0) +
    (query.q.trim() ? 1 : 0);

  const timeline = stats.timeline.map((point) => point.count);
  const lastRun = runs[0];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="Indexed"
          value={formatNumber(stats.totals.articles)}
          hint={`${stats.last24h} in the last 24h`}
        />
        <MetricCard
          label="In view"
          value={formatNumber(data.window.total)}
          hint={`avg impact ${data.window.avgImpact}`}
          accent="#22d3ee"
        />
        <MetricCard
          label="Breaking"
          value={data.window.breaking}
          hint={scheduler.enabled ? `sweep every ${scheduler.intervalMinutes}m` : "scheduler off"}
          accent="#fb7185"
        />
        <MetricCard
          label="Unread"
          value={formatNumber(data.window.unread)}
          hint={`${data.window.bookmarked} bookmarked`}
          accent="#fbbf24"
        />
        <MetricCard
          label="Sources"
          value={`${stats.scanning.healthySources}/${stats.totals.enabledSources}`}
          hint={`${stats.scanning.failingSources} failing`}
          accent="#4ade80"
        />
        <MetricCard
          label="Last sweep"
          value={relativeTime(stats.scanning.lastScanAt)}
          hint={live.connected ? (live.scanning ? "scanning now" : "stream connected") : "reconnecting"}
          accent="#a78bfa"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <StatusPill tone={scheduler.enabled ? "ok" : "warn"}>
          {scheduler.enabled ? `auto-scan every ${scheduler.intervalMinutes}m` : "auto-scan disabled"}
        </StatusPill>
        {scheduler.nextRunAt ? (
          <span className="text-slate-500">next sweep {relativeTime(scheduler.nextRunAt)}</span>
        ) : null}
        {lastRun ? (
          <span className="text-slate-500">
            last run {relativeTime(lastRun.finishedAt)}: {lastRun.itemsAdded} new / {lastRun.itemsMerged} merged /{" "}
            {lastRun.sourcesFailed} feed errors
          </span>
        ) : null}
        {loading ? <span className="text-radar-300">refreshing…</span> : null}
        {error ? <span className="text-rose-300">{error}</span> : null}
        <a className="ml-auto text-slate-400 hover:text-white" href="/api/digest?hours=24">
          export last 24h digest →
        </a>
      </div>

      <div className="grid gap-4 xl:grid-cols-[290px_minmax(0,1fr)_310px]">
        <div className="xl:sticky xl:top-24 xl:max-h-[calc(100vh-8rem)] xl:self-start xl:overflow-y-auto">
          <FilterRail
            query={query}
            facets={data.facets}
            sources={sources}
            total={data.total}
            onChange={patchQuery}
            onReset={resetQuery}
          />
        </div>

        <div className="min-w-0 space-y-3">
          <div className="panel flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-xs text-slate-400">
            <span className="font-mono text-slate-200">{data.total}</span>
            <span>updates match</span>
            {activeFilters > 0 ? <span className="text-slate-500">({activeFilters} filters active)</span> : null}
            <button
              type="button"
              className={cn("chip ml-auto", selectionMode && "chip-active")}
              onClick={() => {
                setSelectionMode(!selectionMode);
                setSelected([]);
              }}
            >
              {selectionMode ? "exit multi-select" : "multi-select"}
            </button>
            {selectionMode ? (
              <>
                <button type="button" className="chip" onClick={() => bulk("read")} disabled={selected.length === 0}>
                  mark read
                </button>
                <button type="button" className="chip" onClick={() => bulk("unread")} disabled={selected.length === 0}>
                  mark unread
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => bulk("bookmark")}
                  disabled={selected.length === 0}
                >
                  bookmark
                </button>
                <button type="button" className="chip" onClick={() => bulk("read-all")}>
                  mark everything read
                </button>
              </>
            ) : null}
            {data.appliedQuery ? (
              <span className="w-full font-mono text-[0.68rem] text-slate-500">query: {data.appliedQuery}</span>
            ) : null}
          </div>

          {data.items.length === 0 ? (
            <EmptyState
              title="Nothing matches those filters yet"
              hint={
                stats.totals.articles === 0
                  ? "The store is empty. Run a scan to pull the latest AI updates from the tracked feeds."
                  : "Try widening the time window, lowering the impact floor or clearing a filter."
              }
            />
          ) : (
            data.items.map((article) => (
              <ArticleCard
                key={article.id}
                article={article}
                sourceLabel={article.sourceName}
                homepage={sourceIndex.get(article.sourceId)?.homepage ?? null}
                selectionMode={selectionMode}
                selected={selected.includes(article.id)}
                onSelect={(id, isSelected) =>
                  setSelected((previous) =>
                    isSelected ? [...previous, id] : previous.filter((value) => value !== id),
                  )
                }
                onToggleRead={(target) => patchArticle(target.id, { read: !target.read })}
                onToggleBookmark={(target) => patchArticle(target.id, { bookmarked: !target.bookmarked })}
                onOpen={(target) => {
                  if (!target.read) patchArticle(target.id, { read: true });
                }}
                onTagClick={(tag) =>
                  patchQuery({
                    tags: query.tags.includes(tag)
                      ? query.tags.filter((entry) => entry !== tag)
                      : [...query.tags, tag],
                    page: 1,
                  })
                }
                onCategoryClick={(category) =>
                  patchQuery({
                    categories: query.categories.includes(category)
                      ? query.categories.filter((entry) => entry !== category)
                      : [...query.categories, category],
                    page: 1,
                  })
                }
              />
            ))
          )}

          {data.pageCount > 1 ? (
            <div className="flex items-center justify-between gap-3 pt-1 text-xs text-slate-400">
              <button
                type="button"
                className="btn"
                disabled={data.page <= 1}
                onClick={() => patchQuery({ page: data.page - 1 })}
              >
                ← previous
              </button>
              <span className="font-mono">
                page {data.page} / {data.pageCount}
              </span>
              <button
                type="button"
                className="btn"
                disabled={data.page >= data.pageCount}
                onClick={() => patchQuery({ page: data.page + 1 })}
              >
                next →
              </button>
            </div>
          ) : null}
        </div>

        <aside className="space-y-4">
          <RadarRail
            stats={stats}
            runs={runs}
            timeline={timeline}
            facets={data.facets}
            activeTags={query.tags}
            onToggleTag={(tag) =>
              patchQuery({
                tags: query.tags.includes(tag)
                  ? query.tags.filter((entry) => entry !== tag)
                  : [...query.tags, tag],
                page: 1,
              })
            }
          />
        </aside>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { CategoryChip } from "@/components/ui";
import { cn } from "@/lib/format";
import type { DashboardQueryState } from "@/lib/dashboard-query";
import type { SortKey, UpdateQueryResult } from "@/lib/types";

export type { DashboardQueryState } from "@/lib/dashboard-query";

export interface SourceOption {
  id: string;
  name: string;
  tier: number;
  enabled: boolean;
  lastStatus: string;
  homepage: string;
}

const WINDOWS: { id: DashboardQueryState["window"]; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];

const SORTS: { id: SortKey; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "impact", label: "Highest impact" },
  { id: "relevance", label: "Best interest match" },
  { id: "source", label: "By source" },
  { id: "oldest", label: "Oldest first" },
];

export function FilterRail({
  query,
  facets,
  sources,
  total,
  onChange,
  onReset,
}: {
  query: DashboardQueryState;
  facets: UpdateQueryResult["facets"];
  sources: SourceOption[];
  total: number;
  onChange: (patch: Partial<DashboardQueryState>) => void;
  onReset: () => void;
}) {
  const [sourceFilter, setSourceFilter] = useState("");

  const visibleSources = useMemo(() => {
    const needle = sourceFilter.trim().toLowerCase();
    return sources.filter((source) => !needle || source.name.toLowerCase().includes(needle));
  }, [sources, sourceFilter]);

  function toggleInList(key: "categories" | "sources" | "tags", value: string) {
    const current = query[key];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onChange({ [key]: next, page: 1 } as Partial<DashboardQueryState>);
  }

  const categoryCounts = new Map(facets.categories.map((facet) => [facet.id, facet.count]));
  const sourceCounts = new Map(facets.sources.map((facet) => [facet.id, facet.count]));

  return (
    <div className="space-y-4">
      <div className="panel space-y-4 p-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Filters</h2>
          <button type="button" className="text-[0.7rem] text-slate-400 hover:text-white" onClick={onReset}>
            reset
          </button>
        </div>

        <div>
          <label className="mb-1 block text-[0.7rem] text-slate-500" htmlFor="rail-search">
            Query
          </label>
          <input
            id="rail-search"
            className="input"
            value={query.q}
            placeholder="claude changelog -opinion"
            onChange={(event) => onChange({ q: event.target.value, page: 1 })}
          />
          <p className="mt-1 text-[0.65rem] leading-relaxed text-slate-500">
            Supports <span className="font-mono">source:</span>, <span className="font-mono">category:</span>,{" "}
            <span className="font-mono">tag:</span>, <span className="font-mono">impact:&gt;=70</span>,{" "}
            <span className="font-mono">after:2026-09-01</span>, <span className="font-mono">is:breaking</span>,{" "}
            <span className="font-mono">-exclude</span>, <span className="font-mono">&quot;phrases&quot;</span>
          </p>
        </div>

        <div>
          <span className="mb-1 block text-[0.7rem] text-slate-500">Time window</span>
          <div className="flex flex-wrap gap-1.5">
            {WINDOWS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={cn("chip", query.window === option.id && "chip-active")}
                onClick={() => onChange({ window: option.id, page: 1 })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-[0.7rem] text-slate-500">
            <span>Minimum impact</span>
            <span className="font-mono text-slate-300">{query.minImpact}</span>
          </div>
          <input
            type="range"
            min={0}
            max={95}
            step={5}
            value={query.minImpact}
            onChange={(event) => onChange({ minImpact: Number(event.target.value), page: 1 })}
            className="w-full accent-indigo-400"
            aria-label="Minimum impact score"
          />
          <p className="mt-1 text-[0.65rem] text-slate-500">{total} updates match the current filters</p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={cn("chip", query.breakingOnly && "chip-active")}
            onClick={() => onChange({ breakingOnly: !query.breakingOnly, page: 1 })}
          >
            breaking
          </button>
          <button
            type="button"
            className={cn("chip", query.unreadOnly && "chip-active")}
            onClick={() => onChange({ unreadOnly: !query.unreadOnly, page: 1 })}
          >
            unread
          </button>
          <button
            type="button"
            className={cn("chip", query.bookmarkedOnly && "chip-active")}
            onClick={() => onChange({ bookmarkedOnly: !query.bookmarkedOnly, page: 1 })}
          >
            bookmarked
          </button>
          <button
            type="button"
            className={cn("chip", query.showDuplicates && "chip-active")}
            onClick={() => onChange({ showDuplicates: !query.showDuplicates, page: 1 })}
            title="Include stories that were folded into an earlier entry"
          >
            show duplicates
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="text-[0.7rem] text-slate-500">
            Sort
            <select
              className="input mt-1"
              value={query.sort}
              onChange={(event) => onChange({ sort: event.target.value as SortKey, page: 1 })}
            >
              {SORTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[0.7rem] text-slate-500">
            Per page
            <select
              className="input mt-1"
              value={query.pageSize}
              onChange={(event) => onChange({ pageSize: Number(event.target.value), page: 1 })}
            >
              {[10, 20, 40, 60].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="panel space-y-2 p-3.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Categories</h2>
        <div className="flex flex-wrap gap-1.5">
          {facets.categories.map((facet) => (
            <button key={facet.id} type="button" onClick={() => toggleInList("categories", facet.id)}>
              <CategoryChip
                id={facet.id}
                label={facet.label}
                count={categoryCounts.get(facet.id) ?? 0}
                active={query.categories.includes(facet.id)}
              />
            </button>
          ))}
        </div>
      </div>

      <div className="panel space-y-2 p-3.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Topic tags</h2>
        <div className="flex flex-wrap gap-1.5">
          {facets.tags.slice(0, 24).map((facet) => (
            <button
              key={facet.id}
              type="button"
              className={cn("chip", query.tags.includes(facet.id) && "chip-active")}
              onClick={() => toggleInList("tags", facet.id)}
            >
              #{facet.id}
              <span className="text-slate-500">{facet.count}</span>
            </button>
          ))}
          {facets.tags.length === 0 ? <p className="text-xs text-slate-500">no tags in this slice</p> : null}
        </div>
      </div>

      <div className="panel space-y-2 p-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Sources</h2>
          <button
            type="button"
            className="text-[0.7rem] text-slate-400 hover:text-white"
            onClick={() => onChange({ sources: [], page: 1 })}
          >
            all
          </button>
        </div>
        <input
          className="input"
          placeholder="filter sources"
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value)}
        />
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {visibleSources.map((source) => (
            <label
              key={source.id}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-[0.78rem] text-slate-300 hover:bg-white/5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-400"
                  checked={query.sources.includes(source.id)}
                  onChange={() => toggleInList("sources", source.id)}
                />
                <span className="truncate">{source.name}</span>
                {!source.enabled ? <span className="text-[0.62rem] text-slate-500">paused</span> : null}
                {source.lastStatus === "error" ? (
                  <span className="text-[0.62rem] text-rose-300">error</span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[0.65rem] text-slate-500">
                <span className="font-mono">T{source.tier}</span>
                <span className="font-mono">{sourceCounts.get(source.id) ?? 0}</span>
              </span>
            </label>
          ))}
          {visibleSources.length === 0 ? <p className="text-xs text-slate-500">no matches</p> : null}
        </div>
      </div>
    </div>
  );
}

"use client";

import { BarList, SectionHeading, Sparkline, StatusPill } from "@/components/ui";
import { cn, relativeTime } from "@/lib/format";
import type { RadarStats, ScanRun, UpdateQueryResult } from "@/lib/types";

/**
 * Right-hand intelligence rail on the dashboard: volume trend, category mix,
 * source leaderboard, fast-moving tags and radar health.
 */
export function RadarRail({
  stats,
  runs,
  timeline,
  facets,
  activeTags,
  onToggleTag,
}: {
  stats: RadarStats;
  runs: ScanRun[];
  timeline: number[];
  facets: UpdateQueryResult["facets"];
  activeTags: string[];
  onToggleTag: (tag: string) => void;
}) {
  const tags = facets.tags.length > 0 ? facets.tags : stats.topTags;

  return (
    <>
      <div className="panel space-y-2 p-3.5">
        <SectionHeading title="30-day volume" hint={`${stats.last7d} updates in the last 7 days`} />
        <Sparkline values={timeline} />
        <div className="flex items-center justify-between text-[0.7rem] text-slate-500">
          <span>{stats.timeline[0]?.date ?? ""}</span>
          <span>{stats.timeline[stats.timeline.length - 1]?.date ?? ""}</span>
        </div>
      </div>

      <div className="panel space-y-3 p-3.5">
        <SectionHeading title="Category mix" hint="across all indexed updates" />
        <BarList items={stats.byCategory.filter((facet) => facet.count > 0)} />
      </div>

      <div className="panel space-y-3 p-3.5">
        <SectionHeading title="Top sources" hint="who is producing the signal" />
        <BarList items={stats.bySource} />
      </div>

      <div className="panel space-y-3 p-3.5">
        <SectionHeading title="Fastest-moving tags" hint="click to filter the feed" />
        <div className="flex flex-wrap gap-1.5">
          {tags.slice(0, 16).map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={cn("chip", activeTags.includes(tag.id) && "chip-active")}
              onClick={() => onToggleTag(tag.id)}
            >
              #{tag.id}
              <span className="text-slate-500">{tag.count}</span>
            </button>
          ))}
          {tags.length === 0 ? <p className="text-xs text-slate-500">no tags yet</p> : null}
        </div>
      </div>

      <div className="panel space-y-3 p-3.5">
        <SectionHeading
          title="Radar health"
          hint={`${stats.scanning.scansCompleted} sweeps completed - avg ${
            Math.round(stats.scanning.averageScanMs / 100) / 10
          }s`}
        />
        <ul className="space-y-2 text-[0.74rem]">
          {runs.slice(0, 5).map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-slate-300">
                <StatusPill tone={run.sourcesFailed > 0 ? "warn" : "ok"}>{run.trigger}</StatusPill>
                <time dateTime={run.finishedAt} suppressHydrationWarning className="text-slate-500">
                  {relativeTime(run.finishedAt)}
                </time>
              </span>
              <span className="font-mono text-slate-400">
                +{run.itemsAdded} / {Math.round(run.durationMs / 1000)}s
              </span>
            </li>
          ))}
          {runs.length === 0 ? <li className="text-slate-500">no sweeps recorded yet</li> : null}
        </ul>
        <div className="flex flex-wrap gap-1.5">
          {stats.sentiment.map((entry) => (
            <span key={entry.label} className="chip text-slate-300">
              {entry.label}
              <span className="text-slate-500">{entry.count}</span>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

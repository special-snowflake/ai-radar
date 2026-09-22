import Link from "next/link";
import { BarList, MetricCard, SectionHeading, Sparkline, StatusPill } from "@/components/ui";
import { formatDateTime, formatNumber, pct, TIER_LABELS } from "@/lib/format";
import { getDashboardSnapshot, getSourceActivity, getSourcesWithHealth } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Analytics: read-only overview computed from the store snapshot - volume,
 * category/source distribution, signal mix and per-feed productivity.
 */
export default async function AnalyticsPage() {
  await ensureStoreLoaded();
  const snapshot = getDashboardSnapshot();
  const stats = snapshot.stats;
  const sources = getSourcesWithHealth();
  const timeline = stats.timeline.map((point) => point.count);

  const coverage7d = pct(
    getSourceActivity().filter((entry) => entry.last7d > 0).length,
    Math.max(1, sources.length),
  );
  const topCategory = stats.byCategory[0];
  const bookmarkRate = pct(stats.bookmarked, Math.max(1, stats.total));

  const productive = stats.weeklyBySource.slice(0, 10).map((facet) => ({
    id: facet.id,
    label: facet.label,
    count: facet.count,
  }));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-white">Analytics</h1>
        <p className="text-xs text-slate-400">
          snapshot · {formatNumber(stats.total)} updates indexed
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total updates" value={formatNumber(stats.total)} hint={`${stats.last24h} in last 24h`} />
        <MetricCard
          label="7-day volume"
          value={formatNumber(stats.last7d)}
          hint={`avg ${Math.round(stats.last7d / 7)}/day`}
        />
        <MetricCard
          label="Breaking stored"
          value={formatNumber(stats.breaking)}
          hint="high-severity items kept flagged"
        />
        <MetricCard
          label="Bookmarks"
          value={formatNumber(stats.bookmarked)}
          hint={`${bookmarkRate}% of the archive`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="panel space-y-3 p-4">
          <SectionHeading title="30-day volume" hint={`${stats.last7d} updates in the last 7 days`} />
          <Sparkline values={timeline} />
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 sm:grid-cols-4">
            <p>
              unread <span className="font-mono text-slate-200">{stats.unread}</span>
            </p>
            <p>
              duplicates folded <span className="font-mono text-slate-200">{stats.duplicates}</span>
            </p>
            <p>
              reads <span className="font-mono text-slate-200">{stats.read}</span>
            </p>
            <p>
              sources <span className="font-mono text-slate-200">{stats.sourcesOk}/{stats.sourcesTotal}</span>
            </p>
          </div>
        </div>

        <div className="panel space-y-3 p-4">
          <SectionHeading title="Category mix" hint="all indexed updates" />
          <BarList items={stats.byCategory.filter((facet) => facet.count > 0)} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="panel space-y-3 p-4">
          <SectionHeading title="Top producers (7d)" hint="updates per feed" />
          <BarList items={productive} />
        </div>
        <div className="panel space-y-3 p-4">
          <SectionHeading title="Fastest-moving tags" hint="top tag frequency" />
          <BarList
            items={stats.topTags
              .slice(0, 10)
              .map((tag) => ({ id: tag.id, label: tag.label, count: tag.count }))}
          />
        </div>
        <div className="panel space-y-3 p-4">
          <SectionHeading title="Signal mix" hint="sentiment distribution" />
          <div className="space-y-2">
            {stats.sentiment.map((entry) => (
              <div key={entry.label} className="flex items-center gap-2 text-xs text-slate-300">
                <span className="w-20 shrink-0 capitalize">{entry.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-radar-400"
                    style={{ width: `${pct(entry.count, Math.max(1, stats.total))}%` }}
                  />
                </div>
                <span className="w-10 text-right font-mono text-slate-400">{entry.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel space-y-3 p-4">
        <SectionHeading title="Scanner health" hint={`${stats.scanning.scansCompleted} sweeps completed`} />
        <div className="grid gap-3 text-xs text-slate-300 sm:grid-cols-3">
          <p>
            avg sweep{" "}
            <span className="font-mono text-slate-100">{Math.round(stats.scanning.averageScanMs / 100) / 10}s</span>
          </p>
          <p>
            last sweep <span className="font-mono text-slate-100">{formatDateTime(stats.scanning.lastScanAt)}</span>
          </p>
          <p className="flex items-center gap-2">
            scheduler{" "}
            <StatusPill tone={snapshot.scheduler.enabled ? "ok" : "warn"}>
              {snapshot.scheduler.enabled ? "enabled" : "manual"}
            </StatusPill>
          </p>
        </div>
        <ul className="space-y-1.5 text-xs">
          {snapshot.runs.slice(0, 8).map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2 text-slate-400">
              <time dateTime={run.finishedAt} suppressHydrationWarning className="font-mono text-slate-500">
                {formatDateTime(run.finishedAt)}
              </time>
              <span className="chip">{run.trigger}</span>
              <span>
                {run.sourcesOk} ok · {run.sourcesFailed} failed · +{run.itemsAdded} new ·{" "}
                {Math.round(run.durationMs / 100) / 10}s
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span>
          most active category: <span className="text-slate-200">{topCategory?.id ?? "n/a"}</span>
        </span>
        <span className="text-slate-600">|</span>
        <span>
          feed coverage (7d): <span className="text-slate-200">{coverage7d}%</span>
        </span>
        <span className="text-slate-600">|</span>
        <span>
          tier-1 feeds:{" "}
          <span className="text-slate-200">
            {sources.filter((source) => source.tier === 1).length} ({TIER_LABELS[1]})
          </span>
        </span>
        <Link href="/sources" className="text-radar-300 hover:text-radar-200">
          manage feeds →
        </Link>
      </div>
    </div>
  );
}


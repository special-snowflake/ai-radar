"use client";

import { useMemo, useState } from "react";
import { ScanButton } from "@/components/scan-button";
import { SectionHeading, SourceAvatar, StatusPill } from "@/components/ui";
import { SOURCE_KIND_LABEL, cn, formatDateTime, relativeTime } from "@/lib/format";
import type { Source } from "@/lib/types";
import type { SourceActivity } from "@/lib/runtime";

type Filter = "all" | "enabled" | "tier1" | "failing";

interface ScanResponse {
  run?: { itemsAdded: number; itemsMerged: number; sourcesFailed: number; durationMs: number };
  error?: string;
}

/**
 * Feed management board: health table with enable/disable toggles, an add-feed
 * form and a retry sweep for feeds whose last fetch errored.
 * Talks to /api/sources, /api/sources/:id and /api/scan.
 */
export function SourcesBoard({
  initialSources,
  activity,
}: {
  initialSources: Source[];
  activity: SourceActivity[];
}) {
  const [sources, setSources] = useState(initialSources);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const activityById = useMemo(
    () => new Map(activity.map((entry) => [entry.sourceId, entry])),
    [activity],
  );

  const summary = useMemo(() => {
    const enabled = sources.filter((source) => source.enabled).length;
    const tier1 = sources.filter((source) => source.tier === 1).length;
    const failing = sources.filter((source) => source.lastStatus === "error").length;
    const stored = activity.reduce((total, entry) => total + entry.stored, 0);
    return { total: sources.length, enabled, tier1, failing, stored };
  }, [sources, activity]);

  const visible = useMemo(
    () =>
      sources.filter((source) => {
        if (filter === "enabled" && !source.enabled) return false;
        if (filter === "tier1" && source.tier !== 1) return false;
        if (filter === "failing" && source.lastStatus !== "error") return false;
        const needle = search.trim().toLowerCase();
        if (needle && !`${source.name} ${source.url} ${source.kind}`.toLowerCase().includes(needle)) return false;
        return true;
      }),
    [sources, filter, search],
  );

  async function toggleSource(source: Source) {
    setBusy(true);
    try {
      const response = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !source.enabled }),
      });
      const payload = (await response.json()) as { source?: Source; error?: string };
      if (!response.ok || !payload.source) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setSources((current) => current.map((entry) => (entry.id === source.id ? (payload.source as Source) : entry)));
      setMessage({ tone: "ok", text: `${source.name} ${source.enabled ? "paused" : "resumed"}` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "update failed" });
    } finally {
      setBusy(false);
    }
  }

  async function addSource(event: React.FormEvent) {
    event.preventDefault();
    const feed = url.trim();
    const label = name.trim();
    if (!feed || !label) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: label, url: feed }),
      });
      const payload = (await response.json()) as { source?: Source; error?: string };
      if (!response.ok || !payload.source) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setSources((current) => [payload.source as Source, ...current]);
      setName("");
      setUrl("");
      setMessage({ tone: "ok", text: `tracking "${payload.source.name}" - it joins the next sweep` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "add failed" });
    } finally {
      setBusy(false);
    }
  }

  async function retryFailing() {
    const failingIds = sources.filter((source) => source.enabled && source.lastStatus === "error").map((s) => s.id);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sources: failingIds, trigger: "manual" }),
      });
      const payload = (await response.json()) as ScanResponse;
      if (!response.ok || !payload.run) throw new Error(payload.error ?? `HTTP ${response.status}`);
      const refreshed = await fetch("/api/sources", { cache: "no-store" });
      const next = (await refreshed.json()) as { sources: Source[] };
      setSources(next.sources);
      setMessage({
        tone: payload.run.sourcesFailed > 0 ? "error" : "ok",
        text: `retry sweep: +${payload.run.itemsAdded} new, ${payload.run.sourcesFailed} feeds still failing`,
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "sweep failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Feed sources</h1>
          <p className="text-xs text-slate-400">
            {summary.enabled}/{summary.total} enabled · {summary.tier1} tier-1 · {summary.failing} failing ·{" "}
            {summary.stored} stored updates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ScanButton compact />
          <button type="button" className="btn" disabled={busy || summary.failing === 0} onClick={retryFailing}>
            {busy ? "Working..." : `Retry ${summary.failing} failing`}
          </button>
        </div>
      </header>

      <form onSubmit={addSource} className="panel flex flex-wrap items-center gap-2 p-3.5">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Feed name"
          className="w-40 rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-radar-400"
        />
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/feed.xml"
          className="min-w-64 flex-1 rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-radar-400"
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !url.trim() || !name.trim()}>
          Add feed
        </button>
        {message ? (
          <span className={cn("text-xs", message.tone === "ok" ? "text-emerald-300" : "text-rose-300")}>
            {message.text}
          </span>
        ) : null}
      </form>


      <div className="flex flex-wrap items-center gap-2">
        {(["all", "enabled", "tier1", "failing"] as Filter[]).map((entry) => (
          <button
            key={entry}
            type="button"
            className={cn("chip", filter === entry && "chip-active")}
            onClick={() => setFilter(entry)}
          >
            {entry}
          </button>
        ))}
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="search feeds…"
          className="ml-auto w-48 rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-radar-400"
        />
      </div>

      <div className="panel divide-y divide-slate-800/70">
        {visible.map((source) => {
          const stats = activityById.get(source.id);
          return (
            <div key={source.id} className="flex flex-wrap items-center gap-3 p-3">
              <SourceAvatar name={source.name} homepage={source.homepage} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={source.homepage || source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sm font-medium text-slate-100 hover:text-white"
                  >
                    {source.name}
                  </a>
                  <span className="chip">tier {source.tier}</span>
                  <span className="text-[0.7rem] text-slate-500">{SOURCE_KIND_LABEL[source.kind]}</span>
                  {source.builtIn ? null : (
                    <span className="chip border-radar-400/30 bg-radar-500/10 text-radar-200">custom</span>
                  )}
                </div>
                <p className="truncate text-xs text-slate-500">{source.url}</p>
                {source.lastError ? (
                  <p className="truncate text-xs text-rose-300/80" title={source.lastError}>
                    {source.lastError}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span className="font-mono" title="stored updates">
                  {stats?.stored ?? 0} stored
                </span>
                <span className="font-mono" title="updates in the last 7 days">
                  {stats?.last7d ?? 0}/7d
                </span>
                <span className="font-mono" title="average fetch time">
                  {stats?.averageLatencyMs ?? 0}ms
                </span>
                <span suppressHydrationWarning title={source.lastFetchedAt ?? "never fetched"}>
                  {source.lastFetchedAt ? relativeTime(source.lastFetchedAt) : "never"}
                </span>
                <StatusPill
                  tone={
                    source.lastStatus === "ok" ? "ok" : source.lastStatus === "error" ? "error" : "neutral"
                  }
                >
                  {source.lastStatus}
                </StatusPill>
                {source.consecutiveFailures > 1 ? (
                  <span className="font-mono text-rose-300/80">{source.consecutiveFailures} misses</span>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  title={source.lastFetchedAt ? formatDateTime(source.lastFetchedAt) : "never fetched"}
                  className={cn("chip", source.enabled ? "chip-active" : "text-slate-400")}
                  onClick={() => toggleSource(source)}
                >
                  {source.enabled ? "active" : "paused"}
                </button>
              </div>
            </div>
          );
        })}
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">no feeds match this filter</p>
        ) : null}
      </div>

      <SectionHeading title="How sweeps treat feeds" hint="paused feeds keep their stored updates" />
      <p className="text-xs text-slate-500">
        Dedupe, classification and impact scoring run on every sweep. Pausing a tier-1 feed lowers breaking-news
        coverage. The retry button sweeps only the enabled feeds whose last fetch errored, and custom feeds are
        fetched with the same timeout and item cap as the built-in catalog.
      </p>
    </div>
  );
}


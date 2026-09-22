"use client";

import { useMemo, useState } from "react";
import { EmptyState, SectionHeading, StatusPill } from "@/components/ui";
import { cn, formatDateTime, relativeTime } from "@/lib/format";
import { CATEGORY_MAP } from "@/lib/types";
import type { AlertEventView } from "@/lib/runtime";
import type { AlertRule } from "@/lib/types";

type Tab = "feed" | "rules";

/**
 * Alert center: the matched-event feed (mark read / snooze) plus the keyword
 * rules that produce it. Talks to /api/alerts, /api/alerts/:id and
 * /api/alerts/events.
 */
export function AlertsBoard({
  initialRules,
  initialEvents,
  unread,
}: {
  initialRules: AlertRule[];
  initialEvents: AlertEventView[];
  unread: number;
}) {
  const [tab, setTab] = useState<Tab>("feed");
  const [rules, setRules] = useState(initialRules);
  const [events, setEvents] = useState(initialEvents);
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [minImpact, setMinImpact] = useState(70);
  const [breakingOnly, setBreakingOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const stats = useMemo(
    () => ({
      rules: rules.length,
      activeRules: rules.filter((rule) => rule.enabled).length,
      matches: events.length,
      unread,
      today: events.filter((entry) => Date.now() - Date.parse(entry.event.createdAt) < 86_400_000).length,
    }),
    [rules, events, unread],
  );

  async function patchRule(rule: AlertRule, patch: Partial<AlertRule>) {
    setBusy(true);
    try {
      const response = await fetch(`/api/alerts/${rule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = (await response.json()) as { rule?: AlertRule; error?: string };
      if (!response.ok || !payload.rule) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setRules((current) => current.map((entry) => (entry.id === rule.id ? (payload.rule as AlertRule) : entry)));
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "rule update failed" });
    } finally {
      setBusy(false);
    }
  }

  async function createRule(event: React.FormEvent) {
    event.preventDefault();
    const label = name.trim();
    const words = keywords
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean);
    if (label.length < 2 || words.length === 0) {
      setMessage({ tone: "error", text: "a name and at least one keyword are required" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: label, keywords: words, minImpact, breakingOnly }),
      });
      const payload = (await response.json()) as { rule?: AlertRule; error?: string };
      if (!response.ok || !payload.rule) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setRules((current) => [payload.rule as AlertRule, ...current]);
      setName("");
      setKeywords("");
      setMessage({ tone: "ok", text: `rule "${payload.rule.name}" added - backfill to see past matches` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "could not create rule" });
    } finally {
      setBusy(false);
    }
  }

  async function updateEvents(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch("/api/alerts/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const refreshed = await fetch("/api/alerts?events=1&limit=60", { cache: "no-store" });
      const payload = (await refreshed.json()) as { events: AlertEventView[] };
      setEvents(payload.events);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "event update failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Alerts</h1>
          <p className="text-xs text-slate-400">
            {stats.unread} unread · {stats.matches} recent matches · {stats.activeRules}/{stats.rules} rules armed ·{" "}
            {stats.today} matched in 24h
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(["feed", "rules"] as Tab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              className={cn("chip", tab === entry && "chip-active")}
              onClick={() => setTab(entry)}
            >
              {entry}
            </button>
          ))}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void updateEvents({ action: "read-all" })}
          >
            Mark all read
          </button>
        </div>
      </header>

      {message ? (
        <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-300" : "text-rose-300")}>{message.text}</p>
      ) : null}

      {tab === "feed" ? (
        <div className="space-y-2">
          {events.map((entry) => (
            <div
              key={entry.event.id}
              className={cn("panel flex flex-wrap items-center gap-3 p-3", entry.event.read && "opacity-60")}
            >
              <StatusPill tone={entry.event.read ? "neutral" : "ok"}>{entry.rule?.name ?? entry.event.ruleName}</StatusPill>
              <div className="min-w-0 flex-1">
                <a
                  href={`/article/${entry.event.articleId}`}
                  className="text-sm text-slate-100 hover:text-white hover:underline underline-offset-2"
                >
                  {entry.article?.title ?? `article ${entry.event.articleId}`}
                </a>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                  <span>{entry.article?.sourceName ?? "unknown source"}</span>
                  {typeof entry.article?.impact === "number" ? (
                    <span className="font-mono">impact {entry.article.impact}</span>
                  ) : null}
                  {entry.event.reasons.slice(0, 3).map((reason) => (
                    <span key={reason} className="chip text-[0.65rem]">
                      {reason}
                    </span>
                  ))}
                  {entry.event.snoozedUntil ? (
                    <span className="text-amber-200/80">
                      snoozed until {formatDateTime(entry.event.snoozedUntil)}
                    </span>
                  ) : null}
                </p>
              </div>
              <time
                dateTime={entry.event.createdAt}
                suppressHydrationWarning
                className="text-xs text-slate-500"
                title={formatDateTime(entry.event.createdAt)}
              >
                {relativeTime(entry.event.createdAt)}
              </time>
              <div className="flex items-center gap-2">
                {entry.event.read ? null : (
                  <button
                    type="button"
                    className="chip chip-active"
                    disabled={busy}
                    onClick={() => void updateEvents({ action: "read", ids: [entry.event.id] })}
                  >
                    read
                  </button>
                )}
                <button
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() =>
                    void updateEvents({
                      action: "snooze",
                      ids: [entry.event.id],
                      until: entry.event.snoozedUntil ? null : new Date(Date.now() + 3_600_000).toISOString(),
                    })
                  }
                >
                  {entry.event.snoozedUntil ? "unsnooze" : "snooze 1h"}
                </button>
              </div>
            </div>
          ))}
          {events.length === 0 ? (
            <EmptyState
              title="no alert matches yet"
              hint="rules run against every new update during a sweep - add a rule or backfill existing articles."
            />
          ) : null}
        </div>
      ) : null}


      {tab === "rules" ? (
        <div className="space-y-4">
          <form onSubmit={createRule} className="panel space-y-3 p-4">
            <SectionHeading title="New rule" hint="matched against every incoming update" />
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Rule name"
                className="w-48 rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-radar-400"
              />
              <input
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder="keywords, comma separated (e.g. gpt-5, chips act)"
                className="min-w-64 flex-1 rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-radar-400"
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-300">
              <label className="flex items-center gap-2">
                min impact
                <input
                  type="range"
                  min={0}
                  max={95}
                  step={5}
                  value={minImpact}
                  onChange={(event) => setMinImpact(Number(event.target.value))}
                  className="w-40 accent-[#7c8cff]"
                />
                <span className="font-mono text-radar-300">{minImpact}</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={breakingOnly}
                  onChange={(event) => setBreakingOnly(event.target.checked)}
                />
                breaking only
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Add rule
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void updateEvents({ action: "backfill" })}
              >
                Backfill recent articles
              </button>
            </div>
          </form>

          <div className="panel divide-y divide-slate-800/70">
            {rules.map((rule) => (
              <div key={rule.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-100">{rule.name}</span>
                    <span className="chip">{rule.keywordMode}</span>
                    <span className="text-[0.7rem] text-slate-500">impact ≥ {rule.minImpact}</span>
                    {rule.breakingOnly ? <span className="chip text-rose-200">breaking</span> : null}
                    {rule.categories.map((category) => (
                      <span key={category} className="text-[0.7rem] text-slate-500">
                        {CATEGORY_MAP[category]?.short ?? category}
                      </span>
                    ))}
                  </div>
                  <p className="truncate text-xs text-slate-500">
                    {rule.keywords.length > 0 ? rule.keywords.map((word) => `#${word}`).join(" ") : "no keywords"}
                    {rule.matchCount > 0 ? ` · ${rule.matchCount} matches` : ""}
                  </p>
                </div>
                <span suppressHydrationWarning className="text-xs text-slate-500">
                  {rule.lastMatchedAt ? relativeTime(rule.lastMatchedAt) : "never matched"}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  className={cn("chip", rule.enabled ? "chip-active" : "text-slate-400")}
                  onClick={() => void patchRule(rule, { enabled: !rule.enabled })}
                >
                  {rule.enabled ? "armed" : "muted"}
                </button>
              </div>
            ))}
            {rules.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-500">no rules yet - add one above</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <p className="text-xs text-slate-500">
        Rules are evaluated once per update during sweeps, so an article that matches two rules raises two events.
        Snoozing only silences the event, never the rule.
      </p>
    </div>
  );
}


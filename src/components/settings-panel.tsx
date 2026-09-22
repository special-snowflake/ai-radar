"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionHeading, StatusPill } from "@/components/ui";
import { cn, formatDateTime, relativeTime } from "@/lib/format";
import type { ScanStatusSnapshot } from "@/lib/runtime";
import { CATEGORIES } from "@/lib/types";
import type { RadarSettings } from "@/lib/types";

const SUMMARY_METHODS: RadarSettings["summarizer"][] = ["extractive", "llm"];

interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

/**
 * Settings panel: edits the runtime store config through PATCH /api/settings,
 * toggles the auto-scan loop and polls the scanner state once a scan runs.
 */
export function SettingsPanel({
  initial,
  scanState,
  storeLabel,
}: {
  initial: RadarSettings;
  scanState: ScanStatusSnapshot;
  /** Where the JSON document lives right now (data/db.json locally, Vercel Blob in production). */
  storeLabel: string;
}) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState(scanState);
  const [interests, setInterests] = useState(
    initial.interests.map((interest) => `${interest.keyword}:${interest.weight}`).join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function update<K extends keyof RadarSettings>(key: K, value: RadarSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  const parsedInterests = useMemo(
    () =>
      interests
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [keyword, weight] = line.split(":");
          return { keyword: (keyword ?? "").trim(), weight: Number(weight ?? 1) };
        })
        .filter((interest) => interest.keyword.length > 0),
    [interests],
  );

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/scan", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          scanning: boolean;
          scheduler: ScanStatusSnapshot;
        };
        setStatus((current) => ({
          ...current,
          scanning: payload.scanning,
          enabled: payload.scheduler.enabled,
          intervalMinutes: payload.scheduler.intervalMinutes,
          nextRunAt: payload.scheduler.nextRunAt,
        }));
      } catch {
        /* the header simply keeps the last known state */
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...settings, interests: parsedInterests }),
      });
      const payload = (await response.json()) as {
        settings?: RadarSettings;
        rescored?: number;
        error?: string;
      };
      if (!response.ok || !payload.settings) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setSettings(payload.settings);
      setInterests(payload.settings.interests.map((entry) => `${entry.keyword}:${entry.weight}`).join("\n"));
      setMessage({
        tone: "ok",
        text:
          typeof payload.rescored === "number" && payload.rescored > 0
            ? `saved - ${payload.rescored} stored updates were re-scored`
            : "saved",
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleScheduler() {
    setBusy(true);
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: status.enabled ? "scheduler-stop" : "scheduler-start" }),
      });
      const payload = (await response.json()) as { scheduler?: ScanStatusSnapshot; error?: string };
      if (!response.ok || !payload.scheduler) throw new Error(payload.error ?? `HTTP ${response.status}`);
      const next = payload.scheduler;
      setStatus((current) => ({
        ...current,
        enabled: next.enabled,
        intervalMinutes: next.intervalMinutes,
        nextRunAt: next.nextRunAt,
      }));
      setMessage({ tone: "ok", text: next.enabled ? "auto-scan resumed" : "auto-scan paused" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "scheduler toggle failed" });
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(action: "read-all" | "unread-all") {
    setBusy(true);
    try {
      const response = await fetch("/api/updates/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { changed?: number; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setMessage({ tone: "ok", text: `${action}: ${payload.changed ?? 0} updates changed` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "bulk update failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Settings</h1>
          <p className="text-xs text-slate-400">
            {status.scanning ? "sweeping now" : "idle"} · last sweep{" "}
            <span suppressHydrationWarning>
              {status.lastScanAt ? relativeTime(status.lastScanAt) : "never"}
            </span>{" "}
            · {status.scansCompleted} sweeps
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={status.enabled ? "ok" : "warn"}>
            {status.enabled ? "auto-scan on" : "auto-scan off"}
          </StatusPill>
          <StatusPill tone={status.sourcesFailed > 0 ? "error" : "neutral"}>
            last run: {status.sourcesFailed} feed error{status.sourcesFailed === 1 ? "" : "s"}
          </StatusPill>
          <button type="button" className="btn" disabled={busy} onClick={toggleScheduler}>
            {status.enabled ? "Pause auto-scan" : "Resume auto-scan"}
          </button>
        </div>
      </header>

      {message ? (
        <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-300" : "text-rose-300")}>{message.text}</p>
      ) : null}

      <SectionHeading title="Scanning" hint={`next sweep ${status.nextRunAt ? formatDateTime(status.nextRunAt) : "not scheduled"}`} />
      <div className="panel grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
        <NumberField
          label="scan interval (minutes)"
          value={settings.scanIntervalMinutes}
          min={1}
          max={1440}
          onChange={(value) => update("scanIntervalMinutes", value)}
        />
        <NumberField
          label="concurrent fetches"
          value={settings.scanConcurrency}
          min={1}
          max={16}
          onChange={(value) => update("scanConcurrency", value)}
        />
        <NumberField
          label="fetch timeout (ms)"
          value={settings.fetchTimeoutMs}
          min={3000}
          max={60000}
          step={1000}
          onChange={(value) => update("fetchTimeoutMs", value)}
        />
        <NumberField
          label="items per feed"
          value={settings.maxItemsPerSource}
          min={5}
          max={100}
          onChange={(value) => update("maxItemsPerSource", value)}
        />
        <NumberField
          label="max stored articles"
          value={settings.maxArticles}
          min={200}
          max={20000}
          step={100}
          onChange={(value) => update("maxArticles", value)}
        />
        <label className="flex flex-col gap-1 text-sm text-slate-300">
          summarizer
          <select
            value={settings.summarizer}
            onChange={(event) => update("summarizer", event.target.value as RadarSettings["summarizer"])}
            className="rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-radar-400"
          >
            {SUMMARY_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>
      </div>

      <SectionHeading title="Signal tuning" hint="changes re-score everything already stored" />
      <div className="panel space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <NumberField
            label="breaking impact threshold"
            value={settings.breakingImpactThreshold}
            min={40}
            max={99}
            onChange={(value) => update("breakingImpactThreshold", value)}
          />
          <NumberField
            label="breaking window (hours)"
            value={settings.breakingWindowHours}
            min={1}
            max={72}
            onChange={(value) => update("breakingWindowHours", value)}
          />
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-slate-300">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.noiseFilter}
              onChange={(event) => update("noiseFilter", event.target.checked)}
            />
            noise filter (jobs, webinars, sponsored posts)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.collapseDuplicates}
              onChange={(event) => update("collapseDuplicates", event.target.checked)}
            />
            fold cross-source duplicates
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm text-slate-300">
          interest profile — one <span className="font-mono text-[0.72rem]">keyword:weight</span> per line
          <textarea
            value={interests}
            onChange={(event) => setInterests(event.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-radar-400"
          />
        </label>
        <p className="text-xs text-slate-500">
          {parsedInterests.length} weighted keyword{parsedInterests.length === 1 ? "" : "s"} drive the relevance
          score. Category priors:{" "}
          {CATEGORIES.map((category) => `${category.short} ${settings.categoryWeights[category.id] ?? 1}`).join(" · ")}
        </p>
      </div>


      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
          Save settings
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setSettings(initial);
            setInterests(initial.interests.map((entry) => `${entry.keyword}:${entry.weight}`).join("\n"));
            setMessage({ tone: "ok", text: "reverted to the last saved values" });
          }}
        >
          Revert
        </button>
      </div>

      <SectionHeading title="Archive" hint="bulk actions over every stored update" />
      <div className="panel flex flex-wrap items-center gap-3 p-4">
        <button type="button" className="btn" disabled={busy} onClick={() => void runBulk("read-all")}>
          Mark everything read
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void runBulk("unread-all")}>
          Mark everything unread
        </button>
        <p className="text-xs text-slate-500">
          The store is a single JSON document (<span className="font-mono">{storeLabel}</span>); settings that affect
          scoring re-run the classifier over stored updates, and interval changes re-plan the sweep loop.
        </p>
      </div>
    </div>
  );
}

function NumberField({ label, hint, value, min, max, step = 1, onChange }: NumberFieldProps) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-300">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-radar-400"
      />
      {hint ? <span className="text-[0.7rem] text-slate-500">{hint}</span> : null}
    </label>
  );
}


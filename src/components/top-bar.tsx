"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MobileNav, type NavCounts } from "@/components/sidebar-nav";
import { ScanButton } from "@/components/scan-button";
import { useRadarLive } from "@/hooks/use-radar-live";
import { relativeTime } from "@/lib/format";

/**
 * Sticky command bar: quick search, radar liveness (SSE), manual scan and the
 * digest export. The search pushes `/?q=` so the dashboard's filter state stays
 * linkable and shareable.
 */
export function TopBar({ counts }: { counts: NavCounts }) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const live = useRadarLive(() => router.refresh());

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const query = term.trim();
    router.push(query ? `/?q=${encodeURIComponent(query)}` : "/");
  }

  const statusLabel = !live.connected
    ? "reconnecting"
    : live.scanning
      ? "scanning feeds"
      : live.lastScanAt
        ? `last sweep ${relativeTime(live.lastScanAt)}`
        : "waiting for first sweep";

  return (
    <header className="sticky top-0 z-30 border-b border-white/8 bg-ink-950/80 px-4 py-3 backdrop-blur-md sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/" className="flex items-center gap-2 lg:hidden">
          <span className="radar-dot" aria-hidden />
          <span className="text-xs font-semibold tracking-[0.2em] uppercase">AI Radar</span>
        </Link>

        <form onSubmit={submit} className="order-3 flex min-w-0 flex-1 items-center gap-2 sm:order-1">
          <div className="relative min-w-0 flex-1">
            <input
              className="input pl-9"
              placeholder='Search updates, models, labs...  try: agents impact:>=70 is:breaking -opinion'
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              aria-label="Search updates"
            />
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden>
              /
            </span>
          </div>
          <button type="submit" className="btn">
            Search
          </button>
        </form>

        <div className="order-2 ml-auto flex items-center gap-3">
          <span
            className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 sm:flex"
            title={live.nextScanAt ? `next sweep ${relativeTime(live.nextScanAt)}` : "scheduler idle"}
          >
            <span className={live.scanning ? "radar-dot" : "radar-dot radar-dot-idle"} aria-hidden />
            {statusLabel}
          </span>
          <Link href="/alerts" className="btn relative hidden sm:inline-flex">
            Alerts
            {counts.alerts > 0 ? (
              <span className="ml-1 rounded-full bg-rose-500/20 px-1.5 text-[0.65rem] text-rose-200">
                {counts.alerts}
              </span>
            ) : null}
          </Link>
          <ScanButton label="Scan" />
        </div>
      </div>

      <div className="mt-3 sm:hidden">
        <MobileNav counts={counts} />
      </div>
    </header>
  );
}

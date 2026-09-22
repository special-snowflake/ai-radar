"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ScanRun } from "@/lib/types";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/format";

interface ScanButtonProps {
  className?: string;
  label?: string;
  compact?: boolean;
  onFinished?: (run: ScanRun) => void;
}

interface ScanResponse {
  run?: ScanRun;
  error?: string;
}

/** Triggers POST /api/scan and reports the run summary back to the caller. */
export function ScanButton({ className, label = "Scan now", compact = false, onFinished }: ScanButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runScan() {
    setBusy(true);
    setError(null);
    setMessage("contacting feeds...");
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
      });
      const payload = (await response.json()) as ScanResponse;
      if (!response.ok || !payload.run) throw new Error(payload.error ?? `scan failed (${response.status})`);

      const run = payload.run;
      setMessage(
        `${run.itemsAdded} new - ${run.itemsMerged} merged - ${run.sourcesFailed} feed errors - ${formatDuration(run.durationMs)}`,
      );
      onFinished?.(run);
      router.refresh();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "scan failed");
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <button type="button" className="btn btn-primary" onClick={runScan} disabled={busy}>
        <span aria-hidden>{busy ? "\u25cf" : "\u21bb"}</span>
        {busy ? "Scanning..." : label}
      </button>
      {busy ? <span className="h-1 w-24 overflow-hidden rounded-full bg-white/10 sweep-bar" /> : null}
      {message ? <span className="text-xs text-slate-400">{message}</span> : null}
      {error ? <span className="text-xs text-rose-300">{error}</span> : null}
    </div>
  );
}

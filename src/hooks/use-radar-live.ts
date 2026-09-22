"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Server-Sent Events client for /api/stream.
 *
 * Reports whether the radar is currently scanning, when the last scan finished
 * and lets callers refresh their data whenever the store changes - which is
 * what makes the dashboard feel live without polling.
 */
export interface RadarLiveState {
  connected: boolean;
  scanning: boolean;
  lastScanAt: string | null;
  scansCompleted: number;
  schedulerEnabled: boolean;
  nextScanAt: string | null;
  /** Increments every time the server store changes. */
  revision: number;
  error: string | null;
}

const INITIAL: RadarLiveState = {
  connected: false,
  scanning: false,
  lastScanAt: null,
  scansCompleted: 0,
  schedulerEnabled: false,
  nextScanAt: null,
  revision: 0,
  error: null,
};

interface StreamPayload {
  scanning?: boolean;
  lastScanAt?: string | null;
  scansCompleted?: number;
  scheduler?: { enabled?: boolean; nextRunAt?: string | null };
}

export function useRadarLive(onChange?: () => void): RadarLiveState {
  const [state, setState] = useState<RadarLiveState>(INITIAL);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const handle = useCallback((payload: StreamPayload, first: boolean) => {
    setState((previous) => ({
      connected: true,
      scanning: Boolean(payload.scanning),
      lastScanAt: payload.lastScanAt ?? previous.lastScanAt,
      scansCompleted: payload.scansCompleted ?? previous.scansCompleted,
      schedulerEnabled: payload.scheduler?.enabled ?? previous.schedulerEnabled,
      nextScanAt: payload.scheduler?.nextRunAt ?? previous.nextScanAt,
      revision: previous.revision + (first ? 0 : 1),
      error: null,
    }));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const source = new EventSource("/api/stream");

    source.addEventListener("ready", (event) => {
      try {
        handle(JSON.parse((event as MessageEvent).data) as StreamPayload, true);
      } catch {
        /* ignore malformed frame */
      }
    });

    source.addEventListener("update", (event) => {
      try {
        handle(JSON.parse((event as MessageEvent).data) as StreamPayload, false);
        changeRef.current?.();
      } catch {
        /* ignore malformed frame */
      }
    });

    source.onerror = () => {
      setState((previous) => ({
        ...previous,
        connected: false,
        error: "stream disconnected",
      }));
    };

    return () => source.close();
  }, [handle]);

  return state;
}

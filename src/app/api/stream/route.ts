import { ensureStoreLoaded, getDb } from "@/lib/store";
import { isScanRunning } from "@/lib/scanner";
import { getSchedulerSnapshot } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/stream - Server-Sent Events feed.
 *
 * Emits a snapshot whenever the store changes (new scan results, alert
 * matches, ...) plus a heartbeat every 20s. The dashboard subscribes to this to
 * stay live without polling.
 */
export async function GET(request: Request) {
  await ensureStoreLoaded();
  const encoder = new TextEncoder();
  let interval: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastSignature = "";

      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const snapshot = () => {
        const db = getDb();
        return {
          time: new Date().toISOString(),
          updatedAt: db.updatedAt,
          articles: db.articles.length,
          alertEvents: db.alertEvents.length,
          lastScanAt: db.meta.lastScanAt,
          scansCompleted: db.meta.scansCompleted,
          scanning: isScanRunning(),
          scheduler: getSchedulerSnapshot(),
        };
      };

      send("ready", snapshot());

      interval = setInterval(() => {
        const current = snapshot();
        const signature = `${current.updatedAt}|${current.articles}|${current.alertEvents}|${current.scanning}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          send("update", current);
        }
      }, 5_000);

      heartbeat = setInterval(() => {
        send("heartbeat", { time: new Date().toISOString() });
      }, 20_000);

      request.signal.addEventListener("abort", () => {
        if (interval) clearInterval(interval);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (interval) clearInterval(interval);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

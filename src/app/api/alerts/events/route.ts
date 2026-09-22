import { NextResponse } from "next/server";
import {
  ensureStoreLoaded,
  flush,
  getAlerts,
  getDb,
  markAlertEventsRead,
  recordAlertMatches,
  snoozeAlertEvents,
} from "@/lib/store";
import { evaluateAlerts, alertEventId } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/** GET /api/alerts/events?unread=1&limit=50 */
export async function GET(request: Request) {
  await ensureStoreLoaded();
  const params = new URL(request.url).searchParams;
  const limit = Math.min(200, Math.max(1, Number.parseInt(params.get("limit") ?? "50", 10) || 50));
  const db = getDb();
  const events = db.alertEvents
    .filter((event) => (params.get("unread") === "1" ? !event.read : true))
    .slice(0, limit);
  return NextResponse.json({
    events,
    unread: db.alertEvents.filter((event) => !event.read).length,
  });
}

/**
 * POST /api/alerts/events
 *
 * { action: "read", ids?: string[] }  -> mark specific events (or all) as read
 * { action: "backfill" }              -> replay existing articles through the
 *                                        current rules (used after creating a
 *                                        new rule so the feed is not empty)
 */
export async function POST(request: Request) {
  await ensureStoreLoaded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const payload = (body ?? {}) as { action?: string; ids?: unknown; until?: unknown };

  if (payload.action === "backfill") {
    const db = getDb();
    const seen = new Set(db.alertEvents.map((event) => alertEventId(event.ruleId, event.articleId)));
    const recent = db.articles
      .filter((article) => !article.duplicateOf)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, 400);
    const matches = evaluateAlerts(getAlerts(), recent, seen);
    const created = recordAlertMatches(matches);
    await flush();
    return NextResponse.json({ created });
  }

  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter((id): id is string => typeof id === "string")
    : undefined;
  if (payload.action === "snooze" && ids && ids.length > 0) {
    const until = typeof payload.until === "string" ? payload.until : null;
    const changed = snoozeAlertEvents(ids, until);
    await flush();
    return NextResponse.json({ changed });
  }
  if (payload.action === "read-all") {
    const changed = markAlertEventsRead();
    await flush();
    return NextResponse.json({ changed });
  }
  const changed = markAlertEventsRead(ids);
  await flush();
  return NextResponse.json({ changed });
}

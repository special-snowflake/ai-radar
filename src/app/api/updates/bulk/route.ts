import { NextResponse } from "next/server";
import { ensureStoreLoaded, flush, getDb, mutate, updateArticle } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/updates/bulk
 *
 * { action: "read" | "unread" | "bookmark" | "unbookmark" | "read-all", ids?: string[] }
 *
 * Used by the dashboard's multi-select toolbar.
 */
export async function POST(request: Request) {
  await ensureStoreLoaded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as { action?: string; ids?: unknown };
  const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === "string") : [];

  switch (payload.action) {
    case "read-all": {
      const changed = mutate((db) => {
        let count = 0;
        for (const article of db.articles) {
          if (!article.read) {
            article.read = true;
            count += 1;
          }
        }
        return count;
      });
      await flush();
      return NextResponse.json({ changed });
    }
    case "read":
    case "unread": {
      const value = payload.action === "read";
      let changed = 0;
      for (const id of ids) {
        const article = updateArticle(id, { read: value });
        if (article) changed += 1;
      }
      await flush();
      return NextResponse.json({ changed });
    }
    case "bookmark":
    case "unbookmark": {
      const value = payload.action === "bookmark";
      let changed = 0;
      for (const id of ids) {
        const article = updateArticle(id, { bookmarked: value });
        if (article) changed += 1;
      }
      await flush();
      return NextResponse.json({ changed });
    }
    case "unread-all": {
      const changed = mutate((db) => {
        let count = 0;
        for (const article of db.articles) {
          if (article.read) {
            article.read = false;
            count += 1;
          }
        }
        return count;
      });
      await flush();
      return NextResponse.json({ changed });
    }
    case "delete": {
      const removed = mutate((db) => {
        const before = db.articles.length;
        const keep = db.articles.filter((article) => !ids.includes(article.id));
        db.articles = keep;
        return before - keep.length;
      });
      await flush();
      return NextResponse.json({ changed: removed });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}

/** Convenience: bookmark count for the toolbar badge. */
export async function GET() {
  await ensureStoreLoaded();
  const db = getDb();
  return NextResponse.json({
    bookmarked: db.articles.filter((article) => article.bookmarked).length,
    unread: db.articles.filter((article) => !article.read).length,
    total: db.articles.length,
  });
}

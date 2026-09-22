import { NextResponse } from "next/server";
import { getAlertRules, getAlertFeed } from "@/lib/runtime";
import { createAlert, ensureStoreLoaded, flush } from "@/lib/store";
import { isCategoryId } from "@/lib/types";
import type { AlertRuleInput } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/alerts - rules plus the most recent matches, or `?events=1` for events only. */
export async function GET(request: Request) {
  await ensureStoreLoaded();
  const params = new URL(request.url).searchParams;
  if (params.get("events") === "1" || params.get("events") === "true") {
    const limit = Number.parseInt(params.get("limit") ?? "60", 10);
    return NextResponse.json({
      events: getAlertFeed(Math.min(200, Math.max(1, limit)), params.get("unread") === "1"),
    });
  }
  return NextResponse.json({
    rules: getAlertRules(),
    events: getAlertFeed(60),
    unread: getAlertFeed(200, true).length,
  });
}

/**
 * POST /api/alerts
 *
 * { name, keywords?: string[], keywordMode?: "any"|"all", categories?: CategoryId[],
 *   sourceIds?: string[], minImpact?: number, breakingOnly?: boolean, enabled?: boolean }
 */
export async function POST(request: Request) {
  await ensureStoreLoaded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name.length < 2) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const input: AlertRuleInput = {
    name,
    description: typeof payload.description === "string" ? payload.description : undefined,
    keywords: Array.isArray(payload.keywords)
      ? payload.keywords
          .filter((keyword): keyword is string => typeof keyword === "string")
          .flatMap((keyword) => keyword.split(","))
          .map((keyword) => keyword.trim())
          .filter(Boolean)
      : [],
    keywordMode: payload.keywordMode === "all" ? "all" : "any",
    categories: Array.isArray(payload.categories)
      ? payload.categories.filter((category): category is string => typeof category === "string" && isCategoryId(category))
      : [],
    sourceIds: Array.isArray(payload.sourceIds)
      ? payload.sourceIds.filter((id): id is string => typeof id === "string")
      : [],
    minImpact:
      typeof payload.minImpact === "number"
        ? payload.minImpact
        : Number.parseInt(String(payload.minImpact ?? "0"), 10) || 0,
    breakingOnly: Boolean(payload.breakingOnly),
    enabled: payload.enabled === undefined ? true : Boolean(payload.enabled),
  };

  const rule = createAlert(input);
  await flush();
  return NextResponse.json({ rule }, { status: 201 });
}

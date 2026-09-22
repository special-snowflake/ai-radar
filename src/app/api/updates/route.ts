import { NextResponse } from "next/server";
import { getUpdates } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";
import type { SortKey, UpdateQuery } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/updates
 *
 * Query parameters:
 *   q            free text / DSL ("agents open weights", source:, category:, impact:>=70, is:breaking)
 *   categories   comma separated category ids
 *   sources      comma separated source ids
 *   tags         comma separated tags
 *   from,to      ISO dates
 *   minImpact    number
 *   breaking     "1" | "true"
 *   unread       "1"
 *   bookmarked   "1"
 *   sort         newest|oldest|impact|relevance|source
 *   page,pageSize
 *   collapse     "0" to include cross-source duplicates
 */
const SORT_KEYS: SortKey[] = ["newest", "oldest", "impact", "relevance", "source"];

function list(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function flag(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function number(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  await ensureStoreLoaded();
  const params = new URL(request.url).searchParams;
  const sortParam = params.get("sort");
  const sort = SORT_KEYS.includes((sortParam ?? "") as SortKey)
    ? (sortParam as SortKey)
    : undefined;

  const query: UpdateQuery = {
    q: params.get("q") ?? undefined,
    categories: list(params.get("categories")),
    sources: list(params.get("sources")),
    tags: list(params.get("tags")),
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    minImpact: number(params.get("minImpact")),
    maxImpact: number(params.get("maxImpact")),
    breakingOnly: flag(params.get("breaking")),
    unreadOnly: flag(params.get("unread")),
    bookmarkedOnly: flag(params.get("bookmarked")),
    sort,
    page: number(params.get("page")) ?? 1,
    pageSize: number(params.get("pageSize")) ?? 20,
    collapseDuplicates: params.get("collapse") === "0" ? false : undefined,
  };

  return NextResponse.json(getUpdates(query));
}

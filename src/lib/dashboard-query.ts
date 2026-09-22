import type { SortKey, UpdateQuery } from "./types";

/**
 * Single source of truth for the dashboard's filter state.
 *
 * Used by the server page (URL -> state -> store query) and by the client shell
 * (state -> URL -> /api/updates), so a shared link always reproduces exactly the
 * same view. Pure functions only: no Node or DOM APIs.
 */
export interface DashboardQueryState {
  q: string;
  categories: string[];
  sources: string[];
  tags: string[];
  window: "24h" | "7d" | "30d" | "all";
  minImpact: number;
  sort: SortKey;
  breakingOnly: boolean;
  unreadOnly: boolean;
  bookmarkedOnly: boolean;
  showDuplicates: boolean;
  page: number;
  pageSize: number;
}

export const DEFAULT_DASHBOARD_QUERY: DashboardQueryState = {
  q: "",
  categories: [],
  sources: [],
  tags: [],
  window: "all",
  minImpact: 0,
  sort: "newest",
  breakingOnly: false,
  unreadOnly: false,
  bookmarkedOnly: false,
  showDuplicates: false,
  page: 1,
  pageSize: 20,
};

const WINDOW_HOURS: Record<DashboardQueryState["window"], number | null> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  all: null,
};

const SORT_KEYS: SortKey[] = ["newest", "oldest", "impact", "relevance", "source"];

function list(value: string | null | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function bool(value: string | null | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Serialize state into the dashboard query string (used for the address bar + API). */
export function buildUpdateParams(state: DashboardQueryState, now: number = Date.now()): string {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set("q", state.q.trim());
  if (state.categories.length) params.set("categories", state.categories.join(","));
  if (state.sources.length) params.set("sources", state.sources.join(","));
  if (state.tags.length) params.set("tags", state.tags.join(","));
  if (state.minImpact > 0) params.set("minImpact", String(state.minImpact));
  if (state.breakingOnly) params.set("breaking", "1");
  if (state.unreadOnly) params.set("unread", "1");
  if (state.bookmarkedOnly) params.set("bookmarked", "1");
  if (state.showDuplicates) params.set("collapse", "0");
  if (state.sort !== "newest") params.set("sort", state.sort);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));

  const hours = WINDOW_HOURS[state.window];
  if (hours) params.set("from", new Date(now - hours * 3_600_000).toISOString());
  return params.toString();
}

export function toUpdateQuery(state: DashboardQueryState, now: number = Date.now()): UpdateQuery {
  const hours = WINDOW_HOURS[state.window];
  return {
    q: state.q.trim() || undefined,
    categories: state.categories,
    sources: state.sources,
    tags: state.tags,
    from: hours ? new Date(now - hours * 3_600_000).toISOString() : undefined,
    minImpact: state.minImpact > 0 ? state.minImpact : undefined,
    breakingOnly: state.breakingOnly,
    unreadOnly: state.unreadOnly,
    bookmarkedOnly: state.bookmarkedOnly,
    sort: state.sort,
    page: state.page,
    pageSize: state.pageSize,
    collapseDuplicates: state.showDuplicates ? false : undefined,
  };
}

export function parseDashboardState(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): DashboardQueryState {
  const read = (key: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const sortParam = read("sort") ?? "newest";
  const windowParam = read("window") ?? "all";

  return {
    q: read("q") ?? "",
    categories: list(read("categories")),
    sources: list(read("sources")),
    tags: list(read("tags")),
    window: (["24h", "7d", "30d", "all"] as const).includes(windowParam as never)
      ? (windowParam as DashboardQueryState["window"])
      : "all",
    minImpact: Math.max(0, Math.min(95, int(read("minImpact"), 0))),
    sort: SORT_KEYS.includes(sortParam as SortKey) ? (sortParam as SortKey) : "newest",
    breakingOnly: bool(read("breaking")),
    unreadOnly: bool(read("unread")),
    bookmarkedOnly: bool(read("bookmarked")),
    showDuplicates: read("collapse") === "0",
    page: Math.max(1, int(read("page"), 1)),
    pageSize: Math.max(1, Math.min(100, int(read("pageSize"), 20))),
  };
}

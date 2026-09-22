import { NextResponse } from "next/server";
import { getSourcesWithHealth } from "@/lib/runtime";
import { addSource, ensureStoreLoaded, flush } from "@/lib/store";
import { isCategoryId } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/sources - the catalog with per-source health. */
export async function GET() {
  await ensureStoreLoaded();
  return NextResponse.json({ sources: getSourcesWithHealth() });
}

/**
 * POST /api/sources
 *
 * { name, url, homepage?, kind?, tier?, beats?: CategoryId[], notes? }
 * Lets users track a feed that is not in the built-in catalog.
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
  const url = typeof payload.url === "string" ? payload.url.trim() : "";

  if (name.length < 2) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return NextResponse.json({ error: "a valid http(s) feed url is required" }, { status: 400 });
  }

  const kind = typeof payload.kind === "string" ? payload.kind : undefined;
  const tier = payload.tier === 1 || payload.tier === 2 || payload.tier === 3 ? payload.tier : undefined;
  const beats = Array.isArray(payload.beats)
    ? payload.beats.filter((beat): beat is string => typeof beat === "string" && isCategoryId(beat))
    : [];

  const existing = getSourcesWithHealth().find((source) => source.url === url);
  if (existing) {
    return NextResponse.json({ error: "that feed is already tracked", source: existing }, { status: 409 });
  }

  const source = addSource({
    name,
    url,
    homepage: typeof payload.homepage === "string" ? payload.homepage : undefined,
    kind: kind as never,
    tier: tier as never,
    beats,
    notes: typeof payload.notes === "string" ? payload.notes : undefined,
  });

  await flush();
  return NextResponse.json({ source }, { status: 201 });
}

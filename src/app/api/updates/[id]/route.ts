import { NextResponse } from "next/server";
import { getArticleDetail } from "@/lib/runtime";
import { ensureStoreLoaded, flush, updateArticle } from "@/lib/store";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  await ensureStoreLoaded();
  const detail = getArticleDetail(id);
  if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(detail);
}

/** PATCH /api/updates/:id  { read?: boolean, bookmarked?: boolean } */
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  await ensureStoreLoaded();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as { read?: unknown; bookmarked?: unknown };
  const patch: { read?: boolean; bookmarked?: boolean } = {};
  if (typeof payload.read === "boolean") patch.read = payload.read;
  if (typeof payload.bookmarked === "boolean") patch.bookmarked = payload.bookmarked;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const article = updateArticle(id, patch);
  await flush();
  if (!article) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ article });
}

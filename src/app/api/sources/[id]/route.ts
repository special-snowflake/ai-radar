import { NextResponse } from "next/server";
import { ensureStoreLoaded, flush, getSource, removeSource, updateSource } from "@/lib/store";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/sources/:id  { enabled?, tier?, kind?, beats?, notes?, url? } */
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  await ensureStoreLoaded();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof payload.enabled === "boolean") patch.enabled = payload.enabled;
  if (payload.tier === 1 || payload.tier === 2 || payload.tier === 3) patch.tier = payload.tier;
  if (typeof payload.kind === "string") patch.kind = payload.kind;
  if (typeof payload.notes === "string") patch.notes = payload.notes;
  if (typeof payload.url === "string" && /^https?:\/\/\S+$/i.test(payload.url)) patch.url = payload.url;
  if (Array.isArray(payload.beats)) patch.beats = payload.beats;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const source = updateSource(id, patch as never);
  await flush();
  if (!source) return NextResponse.json({ error: "source not found" }, { status: 404 });
  return NextResponse.json({ source });
}

/** DELETE /api/sources/:id - only custom (non built-in) feeds can be removed. */
export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params;
  await ensureStoreLoaded();
  const source = getSource(id);
  if (!source) return NextResponse.json({ error: "source not found" }, { status: 404 });
  if (source.builtIn) {
    return NextResponse.json(
      { error: "built-in sources can be disabled but not deleted" },
      { status: 400 },
    );
  }
  const removed = removeSource(id);
  await flush();
  return NextResponse.json({ removed });
}

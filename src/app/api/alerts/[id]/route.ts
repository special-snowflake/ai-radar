import { NextResponse } from "next/server";
import { deleteAlert, ensureStoreLoaded, flush, updateAlert } from "@/lib/store";
import { isCategoryId } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/alerts/:id - toggle or edit a rule. */
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
  if (typeof payload.name === "string" && payload.name.trim().length > 1) patch.name = payload.name.trim();
  if (typeof payload.description === "string") patch.description = payload.description;
  if (payload.keywordMode === "any" || payload.keywordMode === "all") patch.keywordMode = payload.keywordMode;
  if (Array.isArray(payload.keywords)) {
    patch.keywords = payload.keywords
      .filter((keyword): keyword is string => typeof keyword === "string")
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(payload.categories)) {
    patch.categories = payload.categories.filter(
      (category): category is string => typeof category === "string" && isCategoryId(category),
    );
  }
  if (Array.isArray(payload.sourceIds)) {
    patch.sourceIds = payload.sourceIds.filter((value): value is string => typeof value === "string");
  }
  if (payload.minImpact !== undefined) {
    const value = Number.parseInt(String(payload.minImpact), 10);
    if (Number.isFinite(value)) patch.minImpact = Math.min(99, Math.max(0, value));
  }
  if (typeof payload.breakingOnly === "boolean") patch.breakingOnly = payload.breakingOnly;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const rule = updateAlert(id, patch as never);
  await flush();
  if (!rule) return NextResponse.json({ error: "alert not found" }, { status: 404 });
  return NextResponse.json({ rule });
}

/** Toggle an existing rule on/off; body is { action: "enable" | "disable" }. */
export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;
  await ensureStoreLoaded();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body as { action?: string } | null)?.action;
  if (action !== "enable" && action !== "disable") {
    return NextResponse.json({ error: "action must be enable or disable" }, { status: 400 });
  }
  const rule = updateAlert(id, { enabled: action === "enable" });
  await flush();
  if (!rule) return NextResponse.json({ error: "alert not found" }, { status: 404 });
  return NextResponse.json({ rule });
}

export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params;
  await ensureStoreLoaded();
  const removed = deleteAlert(id);
  await flush();
  return NextResponse.json({ removed });
}

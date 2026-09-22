import { NextResponse } from "next/server";
import { buildDigestMarkdown } from "@/lib/digest";
import { getUpdates } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/digest?hours=24&format=md|json&limit=200
 *
 * Markdown by default so it can be piped straight into a newsletter or chat
 * message; `format=json` returns the same items for programmatic consumers.
 */
export async function GET(request: Request) {
  await ensureStoreLoaded();
  const params = new URL(request.url).searchParams;
  const hours = Math.min(24 * 30, Math.max(1, Number.parseInt(params.get("hours") ?? "24", 10) || 24));
  const limit = Math.min(500, Math.max(1, Number.parseInt(params.get("limit") ?? "200", 10) || 200));
  const format = (params.get("format") ?? "md").toLowerCase();

  const from = new Date(Date.now() - hours * 3_600_000).toISOString();
  const result = getUpdates({ from, sort: "impact", pageSize: limit });

  if (format === "json") {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      windowHours: hours,
      total: result.total,
      items: result.items,
    });
  }

  const markdown = buildDigestMarkdown(result.items, { sinceHours: hours });
  return new NextResponse(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `inline; filename="ai-radar-digest-${new Date().toISOString().slice(0, 10)}.md"`,
    },
  });
}

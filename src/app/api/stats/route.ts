import { NextResponse } from "next/server";
import { getStatsSnapshot } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/stats - the analytics payload behind /analytics and the dashboard rail. */
export async function GET() {
  await ensureStoreLoaded();
  return NextResponse.json(getStatsSnapshot());
}

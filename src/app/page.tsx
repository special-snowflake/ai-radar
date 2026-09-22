import { DashboardShell } from "@/components/dashboard-shell";
import type { SourceOption } from "@/components/filter-rail";
import { parseDashboardState, toUpdateQuery } from "@/lib/dashboard-query";
import { getDashboardSnapshot, getSourcesWithHealth, getUpdates } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Dashboard: server-renders the first page of results (so the view is useful
 * before hydration) and hands filter state to the client shell, which keeps
 * everything live afterwards.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  await ensureStoreLoaded();

  const state = parseDashboardState(params);
  const data = getUpdates(toUpdateQuery(state));
  const snapshot = getDashboardSnapshot();

  const sources: SourceOption[] = getSourcesWithHealth().map((source) => ({
    id: source.id,
    name: source.name,
    tier: source.tier,
    enabled: source.enabled,
    lastStatus: source.lastStatus,
    homepage: source.homepage,
  }));

  return (
    <DashboardShell
      initialData={data}
      initialQuery={state}
      sources={sources}
      stats={snapshot.stats}
      runs={snapshot.runs}
      scheduler={snapshot.scheduler}
    />
  );
}

import { SourcesBoard } from "@/components/sources-board";
import { getSourceActivity, getSourcesWithHealth } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  await ensureStoreLoaded();
  const sources = getSourcesWithHealth();
  const activity = getSourceActivity();
  return <SourcesBoard initialSources={sources} activity={activity} />;
}

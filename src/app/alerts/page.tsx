import { AlertsBoard } from "@/components/alerts-board";
import { getAlertFeed, getAlertRules } from "@/lib/runtime";
import { ensureStoreLoaded } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  await ensureStoreLoaded();
  const rules = getAlertRules();
  const feed = getAlertFeed(200);
  const unread = getAlertFeed(500, true).length;
  return <AlertsBoard initialRules={rules} initialEvents={feed} unread={unread} />;
}

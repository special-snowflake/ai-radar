import { SettingsPanel } from "@/components/settings-panel";
import { getScanStatusSnapshot, getSettingsSnapshot } from "@/lib/runtime";
import { ensureStoreLoaded, getStoreStatus } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await ensureStoreLoaded();
  const settings = getSettingsSnapshot();
  const scan = getScanStatusSnapshot();
  const store = getStoreStatus();
  return <SettingsPanel initial={settings} scanState={scan} storeLabel={store.backend.label} />;
}

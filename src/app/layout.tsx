import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { SidebarNav, type NavCounts } from "@/components/sidebar-nav";
import { TopBar } from "@/components/top-bar";
import { ensureStoreLoaded, getDb } from "@/lib/store";

export const metadata: Metadata = {
  title: "AI Radar - continuous AI intelligence",
  description:
    "Continuously scans trusted AI sources, categorizes and summarizes every development, and surfaces what matters in a searchable dashboard.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ensureStoreLoaded();
  const db = getDb();
  const fresh = db.articles.filter((article) => !article.duplicateOf);
  const counts: NavCounts = {
    updates: fresh.length,
    breaking: fresh.filter((article) => article.isBreaking).length,
    alerts: db.alertEvents.filter((event) => !event.read).length,
    failing: db.sources.filter((source) => source.lastStatus === "error").length,
    sources: db.sources.filter((source) => source.enabled).length,
  };

  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col lg:flex-row">
          <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-white/8 px-4 py-6 lg:flex">
            <Link href="/" className="flex items-center gap-2 px-2">
              <span className="radar-dot" aria-hidden />
              <span className="text-sm font-semibold tracking-[0.24em] text-radar-100 uppercase">
                AI Radar
              </span>
            </Link>
            <SidebarNav counts={counts} />
            <div className="mt-auto space-y-2 px-2 text-[0.7rem] leading-relaxed text-slate-500">
              <p>
                {counts.sources} sources enabled - {counts.updates} updates indexed
              </p>
              <p className="font-mono">v1.0.0</p>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar counts={counts} />
            <main className="min-w-0 flex-1 px-4 pb-16 pt-4 sm:px-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}

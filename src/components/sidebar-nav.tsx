"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/format";

export interface NavCounts {
  updates: number;
  breaking: number;
  alerts: number;
  failing: number;
  sources: number;
}

interface NavItem {
  href: string;
  label: string;
  description: string;
  badge?: (counts: NavCounts) => string | null;
  tone?: "default" | "alert" | "warn";
}

const ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    description: "Live feed + filters",
    badge: (counts) => (counts.updates > 0 ? String(counts.updates) : null),
  },
  {
    href: "/alerts",
    label: "Alerts",
    description: "Rules and matches",
    badge: (counts) => (counts.alerts > 0 ? String(counts.alerts) : null),
    tone: "alert",
  },
  {
    href: "/sources",
    label: "Sources",
    description: "Feeds and health",
    badge: (counts) => (counts.failing > 0 ? `${counts.failing} down` : null),
    tone: "warn",
  },
  {
    href: "/analytics",
    label: "Analytics",
    description: "Volume and mix",
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Interests and scanning",
  },
];

export function SidebarNav({ counts }: { counts: NavCounts }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const badge = item.badge?.(counts) ?? null;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "group flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm transition",
              active
                ? "bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(124,140,255,0.35)]"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-100",
            )}
          >
            <span className="flex flex-col">
              <span className="font-medium">{item.label}</span>
              <span className="text-[0.68rem] text-slate-500 group-hover:text-slate-400">
                {item.description}
              </span>
            </span>
            {badge ? (
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold",
                  item.tone === "alert"
                    ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
                    : item.tone === "warn"
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                      : "border-white/15 bg-white/10 text-slate-200",
                )}
              >
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav({ counts }: { counts: NavCounts }) {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-2 overflow-x-auto pb-1 lg:hidden">
      {ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const badge = item.badge?.(counts) ?? null;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn("chip shrink-0", active && "chip-active")}
          >
            {item.label}
            {badge ? <span className="text-[0.62rem] text-slate-400">{badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

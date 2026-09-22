import Link from "next/link";
import type { ReactNode } from "react";
import { cn, hostLabel, impactBand } from "@/lib/format";
import type { CategoryMeta, FacetCount } from "@/lib/types";
import { categoryMeta } from "@/lib/types";

/**
 * Presentational primitives shared by server pages and client islands.
 * Kept free of hooks and Node APIs so either side can render them.
 */

export function MetricCard({
  label,
  value,
  hint,
  accent = "#7c8cff",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="panel px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">{label}</span>
        <span className="mt-0.5 h-1.5 w-1.5 rounded-full" style={{ background: accent }} aria-hidden />
      </div>
      <div className="mt-1.5 font-mono text-xl font-semibold text-slate-100">{value}</div>
      {hint ? <div className="mt-1 text-[0.7rem] text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function ImpactBadge({ score, size = "md" }: { score: number; size?: "sm" | "md" }) {
  const band = impactBand(score);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border font-mono font-semibold",
        band.className,
        size === "sm" ? "px-1.5 py-0.5 text-[0.68rem]" : "px-2 py-1 text-xs",
      )}
      title={`Impact ${score}/100 (${band.label})`}
    >
      {score}
    </span>
  );
}

export function CategoryChip({
  id,
  label,
  count,
  active,
  href,
}: {
  id: string;
  label?: string;
  count?: number;
  active?: boolean;
  href?: string;
}) {
  const meta: CategoryMeta = categoryMeta(id);
  const content = (
    <>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.accent }} aria-hidden />
      <span>{label ?? meta.short}</span>
      {typeof count === "number" ? <span className="text-slate-500">{count}</span> : null}
    </>
  );
  const className = cn("chip", active && "chip-active");
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <span className={className}>{content}</span>
  );
}

export function TagChip({ tag, count, href }: { tag: string; count?: number; href?: string }) {
  const className = "chip text-slate-300 hover:border-radar-400/60 hover:text-white";
  const content = (
    <>
      <span>#{tag}</span>
      {typeof count === "number" ? <span className="text-slate-500">{count}</span> : null}
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <span className={className}>{content}</span>
  );
}

export function SourceAvatar({
  name,
  homepage,
  size = 18,
}: {
  name: string;
  homepage?: string | null;
  size?: number;
}) {
  const host = homepage ? hostLabel(homepage) : "";
  if (!host) {
    return (
      <span
        className="flex items-center justify-center rounded bg-white/10 text-[0.6rem] font-bold text-slate-300"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote favicons, next/image adds no value here
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
      alt=""
      className="rounded"
      loading="lazy"
      style={{ width: size, height: size }}
    />
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "error" | "neutral";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    error: "border-rose-500/30 bg-rose-500/10 text-rose-200",
    neutral: "border-white/12 bg-white/5 text-slate-300",
  };
  return <span className={cn("chip", tones[tone])}>{children}</span>;
}

/** Tiny inline sparkline for the 30-day volume series. */
export function Sparkline({
  values,
  width = 220,
  height = 44,
  accent = "#7c8cff",
}: {
  values: number[];
  width?: number;
  height?: number;
  accent?: string;
}) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - (value / max) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `${points.join(" ")} ${width},${height} 0,${height}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Volume trend">
      <polygon points={area} fill={accent} opacity="0.14" />
      <polyline points={points.join(" ")} fill="none" stroke={accent} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function BarList({
  items,
  emptyLabel = "nothing yet",
  valueFormatter = (value: number) => String(value),
}: {
  items: FacetCount[];
  emptyLabel?: string;
  valueFormatter?: (value: number) => string;
}) {
  const max = Math.max(1, ...items.map((item) => item.count));
  if (items.length === 0) return <p className="text-xs text-slate-500">{emptyLabel}</p>;

  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item.id} className="text-[0.78rem]">
          <div className="flex items-center justify-between gap-2 text-slate-300">
            <span className="truncate">{item.label}</span>
            <span className="font-mono text-[0.7rem] text-slate-500">{valueFormatter(item.count)}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, (item.count / max) * 100)}%`,
                background: item.accent ?? "#7c8cff",
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-slate-100">{title}</h2>
        {hint ? <p className="text-[0.7rem] text-slate-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="panel flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {hint ? <p className="max-w-md text-xs text-slate-500">{hint}</p> : null}
      {action}
    </div>
  );
}
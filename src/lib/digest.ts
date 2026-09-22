import { categoryMeta, CATEGORY_IDS } from "./types";
import type { Article } from "./types";
import { formatDateTime, relativeTime } from "./format";

/**
 * Daily digest export: a plain-Markdown roll-up of what the radar collected,
 * grouped by category. Used by `/api/digest` so the feed can be piped into a
 * newsletter, a Slack message or an archive.
 */

export interface DigestOptions {
  title?: string;
  sinceHours?: number;
  maxPerCategory?: number;
  generatedAt?: Date;
}

export function buildDigestMarkdown(articles: Article[], options: DigestOptions = {}): string {
  const generatedAt = options.generatedAt ?? new Date();
  const sinceHours = options.sinceHours ?? 24;
  const maxPerCategory = options.maxPerCategory ?? 6;
  const cutoff = generatedAt.getTime() - sinceHours * 3_600_000;

  const fresh = articles
    .filter((article) => !article.duplicateOf && Date.parse(article.publishedAt) >= cutoff)
    .sort((a, b) => b.impact - a.impact);

  const title = options.title ?? `AI Radar digest - ${generatedAt.toISOString().slice(0, 10)}`;
  const lines: string[] = [
    `# ${title}`,
    "",
    `_Generated ${formatDateTime(generatedAt.toISOString())} - ${fresh.length} item${
      fresh.length === 1 ? "" : "s"
    } from the last ${sinceHours}h._`,
    "",
  ];

  if (fresh.length === 0) {
    lines.push("No new updates in this window.", "");
    return lines.join("\n");
  }

  const breaking = fresh.filter((article) => article.isBreaking).slice(0, 5);
  if (breaking.length > 0) {
    lines.push("## Breaking", "");
    for (const article of breaking) {
      lines.push(`- **${article.title}** - ${article.sourceName} (impact ${article.impact})`);
      lines.push(`  ${article.summary}`);
      lines.push(`  [Read](${article.url})`);
    }
    lines.push("");
  }

  for (const category of CATEGORY_IDS) {
    const items = fresh.filter((article) => article.category === category).slice(0, maxPerCategory);
    if (items.length === 0) continue;
    lines.push(`## ${categoryMeta(category).label}`, "");
    for (const article of items) {
      lines.push(
        `- **[${article.title}](${article.url})** - ${article.sourceName}, ${relativeTime(
          article.publishedAt,
          generatedAt.getTime(),
        )}, impact ${article.impact}`,
      );
      lines.push(`  ${article.summary}`);
      if (article.keyPoints.length > 0) {
        lines.push(`  Key points: ${article.keyPoints.join(" | ")}`);
      }
    }
    lines.push("");
  }

  lines.push("---", `Sources scanned: ${uniqueSources(fresh).join(", ")}`, "");
  return lines.join("\n");
}

function uniqueSources(articles: Article[]): string[] {
  return [...new Set(articles.map((article) => article.sourceName))].sort();
}

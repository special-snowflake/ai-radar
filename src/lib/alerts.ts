import { cleanText, hashId } from "./text";
import type { AlertEvent, AlertRule, Article } from "./types";

/**
 * Alert engine.
 *
 * Rules are intentionally simple and explainable: keywords (any/all),
 * categories, sources, an impact floor and an optional breaking-only gate.
 * Every match carries the reasons that fired it, which the alerts page shows
 * verbatim so users can see why something was surfaced.
 */

export interface MatchResult {
  matched: boolean;
  reasons: string[];
}

function flatten(article: Article): { headline: string; body: string } {
  return {
    headline: article.title.toLowerCase(),
    body: [
      article.title,
      article.excerpt,
      article.summary,
      article.keyPoints.join(" "),
      article.tags.join(" "),
      article.entities.companies.join(" "),
      article.entities.models.join(" "),
      article.entities.technologies.join(" "),
      article.sourceName,
    ]
      .join(" ")
      .toLowerCase(),
  };
}

function keywordHit(headline: string, body: string, keyword: string): boolean {
  const needle = keyword.toLowerCase().trim();
  if (!needle) return false;
  if (headline.includes(needle)) return true;
  return body.includes(needle);
}

export function matchArticle(rule: AlertRule, article: Article): MatchResult {
  if (!rule.enabled) return { matched: false, reasons: [] };
  if (rule.breakingOnly && !article.isBreaking) return { matched: false, reasons: [] };
  if (rule.minImpact > 0 && article.impact < rule.minImpact) return { matched: false, reasons: [] };

  if (rule.categories.length > 0) {
    const inCategory =
      rule.categories.includes(article.category) ||
      article.secondaryCategories.some((category) => rule.categories.includes(category));
    if (!inCategory) return { matched: false, reasons: [] };
  }

  if (rule.sourceIds.length > 0 && !rule.sourceIds.includes(article.sourceId)) {
    return { matched: false, reasons: [] };
  }

  const reasons: string[] = [];
  const { headline, body } = flatten(article);

  if (rule.keywords.length > 0) {
    const hits = rule.keywords.filter((keyword) => keywordHit(headline, body, keyword));
    if (rule.keywordMode === "all" && hits.length < rule.keywords.length) {
      return { matched: false, reasons: [] };
    }
    if (rule.keywordMode === "any" && hits.length === 0) {
      return { matched: false, reasons: [] };
    }
    for (const hit of hits.slice(0, 4)) reasons.push(`keyword:${hit}`);
  }

  if (rule.minImpact > 0) reasons.push(`impact>=${rule.minImpact}`);
  if (rule.categories.length > 0) reasons.push(`category:${article.category}`);
  if (rule.breakingOnly) reasons.push("breaking");
  if (rule.sourceIds.length > 0) reasons.push(`source:${article.sourceName}`);

  return { matched: true, reasons };
}

export function alertEventId(ruleId: string, articleId: string): string {
  return hashId("ae", ruleId, articleId);
}

/**
 * Evaluate every enabled rule against a set of (usually brand new) articles.
 * `seenEventIds` prevents duplicate notifications for the same rule/article.
 */
export function evaluateAlerts(
  rules: AlertRule[],
  articles: Article[],
  seenEventIds: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): { rule: AlertRule; event: AlertEvent }[] {
  const matches: { rule: AlertRule; event: AlertEvent }[] = [];
  const createdAt = now.toISOString();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const article of articles) {
      const result = matchArticle(rule, article);
      if (!result.matched) continue;
      const id = alertEventId(rule.id, article.id);
      if (seenEventIds.has(id)) continue;
      matches.push({
        rule,
        event: {
          id,
          ruleId: rule.id,
          ruleName: cleanText(rule.name),
          articleId: article.id,
          createdAt,
          read: false,
          reasons: result.reasons,
        },
      });
    }
  }

  return matches;
}

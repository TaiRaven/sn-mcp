import { z } from "zod";
import { updateRecord, queryTable } from "../servicenow-client.js";

// category is a reference field — written as a display value, not a raw sys_id, per the port
// design notes (bucket B).
const WRITE_OPTS = { sysparm_input_display_value: true };

interface CatItemStub {
  sys_id: string;
  name?: string;
  short_description?: string;
  category?: string;
  [key: string]: unknown;
}

const STUB_FIELDS = "sys_id,name,short_description,category";

async function fetchItems(active: boolean, categoryId?: string): Promise<CatItemStub[]> {
  const parts = [`active=${active}`];
  if (categoryId) parts.push(`category=${categoryId}`);
  return queryTable<CatItemStub>("sc_cat_item", {
    sysparm_query: parts.join("^"),
    sysparm_fields: STUB_FIELDS,
    sysparm_limit: 50,
  });
}

function sample<T>(items: T[], n: number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < Math.min(n, pool.length)) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

async function getInactiveItems(categoryId?: string): Promise<CatItemStub[]> {
  return fetchItems(false, categoryId);
}

// SIMULATED — mirrors the reference project's identical use of Python's `random` module: there is
// no real usage-tracking data source wired up, these numbers are fabricated on every call. Per the
// user's explicit decision (see the plan file), this must never be presented as real analysis.
async function getLowUsageItems(categoryId?: string): Promise<CatItemStub[]> {
  const items = await fetchItems(true, categoryId);
  const picked = sample(items, 5);
  for (const item of picked) item.order_count = randInt(1, 5);
  return picked;
}

async function getHighAbandonmentItems(categoryId?: string): Promise<CatItemStub[]> {
  const items = await fetchItems(true, categoryId);
  const picked = sample(items, 5);
  for (const item of picked) {
    const abandonmentRate = randInt(40, 80);
    const cartAdds = randInt(20, 100);
    item.abandonment_rate = abandonmentRate;
    item.cart_adds = cartAdds;
    item.orders = Math.round(cartAdds * (1 - abandonmentRate / 100));
  }
  return picked;
}

async function getSlowFulfillmentItems(categoryId?: string): Promise<CatItemStub[]> {
  const items = await fetchItems(true, categoryId);
  const picked = sample(items, 5);
  const catalogAvgTime = 2.5;
  for (const item of picked) {
    const fulfillmentTime = randFloat(5.0, 10.0);
    item.avg_fulfillment_time = fulfillmentTime;
    item.avg_fulfillment_time_vs_catalog = Math.round((fulfillmentTime / catalogAvgTime) * 10) / 10;
  }
  return picked;
}

// Deterministic, not fabricated — a real (if simple) heuristic over each item's actual stored
// short_description. Still folded into the same simulated:true envelope as the other recommendation
// types, per the user's decision to keep this tool's output unambiguous as a whole rather than
// mixing real/fabricated results across recommendation types.
async function getPoorDescriptionItems(categoryId?: string): Promise<CatItemStub[]> {
  const items = await fetchItems(true, categoryId);
  const results: CatItemStub[] = [];
  for (const item of items) {
    const description = String(item.short_description ?? "");
    const issues: string[] = [];
    let score = 100;
    if (!description) {
      issues.push("Missing description");
      score = 0;
    } else {
      if (description.length < 30) {
        issues.push("Description too short", "Lacks detail");
        score -= 70;
      }
      const lower = description.toLowerCase();
      if (lower.includes("click here") || lower.includes("request this")) {
        issues.push("Uses instructional language instead of descriptive");
        score -= 50;
      }
      const vagueTerms = ["etc", "and more", "and so on", "stuff", "things"];
      if (vagueTerms.some((term) => lower.includes(term))) {
        issues.push("Contains vague terms");
        score -= 30;
      }
    }
    score = Math.max(0, Math.min(100, score));
    if (score < 80) {
      item.description_quality = score;
      item.quality_issues = issues;
      results.push(item);
    }
  }
  return results;
}

export const OptimizationRecommendationsShape = {
  recommendation_types: z.array(
    z.enum(["inactive_items", "low_usage", "high_abandonment", "slow_fulfillment", "description_quality"])
  ),
  category_id: z.string().optional(),
};

export interface OptimizationRecommendation {
  type: string;
  title: string;
  description: string;
  items: CatItemStub[];
  impact: string;
  effort: string;
  action: string;
}

export async function getOptimizationRecommendations(
  args: z.infer<z.ZodObject<typeof OptimizationRecommendationsShape>>
): Promise<{ simulated: true; note: string; recommendations: OptimizationRecommendation[] }> {
  const recommendations: OptimizationRecommendation[] = [];

  for (const recType of args.recommendation_types) {
    switch (recType) {
      case "inactive_items": {
        const items = await getInactiveItems(args.category_id);
        if (items.length > 0) {
          recommendations.push({
            type: "inactive_items",
            title: "Inactive Catalog Items",
            description: "Items that are currently inactive in the catalog",
            items,
            impact: "medium",
            effort: "low",
            action: "Review and either update or remove these items",
          });
        }
        break;
      }
      case "low_usage": {
        const items = await getLowUsageItems(args.category_id);
        if (items.length > 0) {
          recommendations.push({
            type: "low_usage",
            title: "Low Usage Catalog Items",
            description: "Items that have very few orders",
            items,
            impact: "medium",
            effort: "medium",
            action: "Consider promoting these items or removing them if no longer needed",
          });
        }
        break;
      }
      case "high_abandonment": {
        const items = await getHighAbandonmentItems(args.category_id);
        if (items.length > 0) {
          recommendations.push({
            type: "high_abandonment",
            title: "High Abandonment Rate Items",
            description: "Items that are frequently added to cart but not ordered",
            items,
            impact: "high",
            effort: "medium",
            action: "Simplify the request process or improve the item description",
          });
        }
        break;
      }
      case "slow_fulfillment": {
        const items = await getSlowFulfillmentItems(args.category_id);
        if (items.length > 0) {
          recommendations.push({
            type: "slow_fulfillment",
            title: "Slow Fulfillment Items",
            description: "Items that take longer than average to fulfill",
            items,
            impact: "high",
            effort: "high",
            action: "Review the fulfillment process and identify bottlenecks",
          });
        }
        break;
      }
      case "description_quality": {
        const items = await getPoorDescriptionItems(args.category_id);
        if (items.length > 0) {
          recommendations.push({
            type: "description_quality",
            title: "Poor Description Quality",
            description: "Items with missing, short, or low-quality descriptions",
            items,
            impact: "medium",
            effort: "low",
            action: "Improve the descriptions to better explain the item's purpose and benefits",
          });
        }
        break;
      }
    }
  }

  return {
    simulated: true,
    note:
      "SIMULATED. low_usage/high_abandonment/slow_fulfillment stats are randomly fabricated on every " +
      "call (no real usage-tracking data source is queried) — ported as-is from the reference project's " +
      "identical use of Python's random module. inactive_items and description_quality reflect real " +
      "instance data, but the whole response is labeled simulated for clarity. Never present any part " +
      "of this as real analysis.",
    recommendations,
  };
}

export const UpdateCatalogItemShape = {
  item_id: z.string().describe("Catalog item sys_id"),
  name: z.string().optional(),
  short_description: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional().describe("Category title or sys_id"),
  price: z.string().optional(),
  active: z.boolean().optional(),
  order: z.number().optional(),
};

export async function updateCatalogItem(
  args: z.infer<z.ZodObject<typeof UpdateCatalogItemShape>>
): Promise<Record<string, unknown>> {
  const { item_id, active, ...rest } = args;
  const body: Record<string, unknown> = { ...rest };
  if (active !== undefined) body.active = String(active);
  return updateRecord("sc_cat_item", item_id, body, WRITE_OPTS);
}

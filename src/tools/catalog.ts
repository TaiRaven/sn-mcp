import { z } from "zod";
import { createRecord, updateRecord, queryTable, getRecord } from "../servicenow-client.js";

// category/parent are reference fields — written as display values (category title), not raw
// sys_ids, per the port design notes (bucket B). Verified working during this batch.
const WRITE_OPTS = { sysparm_input_display_value: true };

export interface CatalogItemRow {
  sys_id: string;
  name: string;
  short_description?: string;
  category?: string;
  price?: string;
  picture?: string;
  active?: string;
  order?: string;
}

const ITEM_FIELDS = "sys_id,name,short_description,category,price,picture,active,order";

export const ListCatalogItemsShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  category: z.string().optional(),
  query: z.string().optional().describe("Matched against short_description or name"),
  active: z.boolean().optional().default(true),
};

// list_* tools are caller-paginated (limit/offset = one bounded page), like incident.ts/user.ts —
// a plain queryTable call, not queryTableAll.
export async function listCatalogItems(
  args: z.infer<z.ZodObject<typeof ListCatalogItemsShape>>
): Promise<CatalogItemRow[]> {
  const parts: string[] = [];
  // Matches the reference project: active=true is only added when the filter is true — passing
  // active:false returns items of both states rather than filtering to inactive ones.
  if (args.active) parts.push("active=true");
  if (args.category) parts.push(`category=${args.category}`);
  if (args.query) parts.push(`short_descriptionLIKE${args.query}^ORnameLIKE${args.query}`);

  return queryTable<CatalogItemRow>("sc_cat_item", {
    sysparm_query: parts.join("^"),
    sysparm_fields: ITEM_FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

interface CatalogItemVariableRow {
  sys_id: string;
  name?: string;
  question_text?: string;
  type?: string;
  mandatory?: string;
  default_value?: string;
  help_text?: string;
  order?: string;
}

/** Not registered as its own tool — matches the reference project, where this is an internal
 *  helper folded into get_catalog_item's response, not a standalone MCP tool. */
async function fetchCatalogItemVariables(itemId: string): Promise<CatalogItemVariableRow[]> {
  return queryTable<CatalogItemVariableRow>("item_option_new", {
    sysparm_query: `cat_item=${itemId}^ORDERBYorder`,
    sysparm_display_value: true,
  });
}

export const GetCatalogItemShape = {
  item_id: z.string().describe("Catalog item sys_id"),
};

export async function getCatalogItem(
  args: z.infer<z.ZodObject<typeof GetCatalogItemShape>>
): Promise<CatalogItemRow & { variables: CatalogItemVariableRow[] }> {
  const item = await getRecord<CatalogItemRow>("sc_cat_item", args.item_id, {
    sysparm_fields: ITEM_FIELDS,
    sysparm_display_value: true,
  });
  const variables = await fetchCatalogItemVariables(args.item_id);
  return { ...item, variables };
}

export interface CatalogCategoryRow {
  sys_id: string;
  title: string;
  description?: string;
  parent?: string;
  icon?: string;
  active?: string;
  order?: string;
}

const CATEGORY_FIELDS = "sys_id,title,description,parent,icon,active,order";

export const ListCatalogCategoriesShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  query: z.string().optional().describe("Matched against title or description"),
  active: z.boolean().optional().default(true),
};

export async function listCatalogCategories(
  args: z.infer<z.ZodObject<typeof ListCatalogCategoriesShape>>
): Promise<CatalogCategoryRow[]> {
  const parts: string[] = [];
  if (args.active) parts.push("active=true");
  if (args.query) parts.push(`titleLIKE${args.query}^ORdescriptionLIKE${args.query}`);

  return queryTable<CatalogCategoryRow>("sc_category", {
    sysparm_query: parts.join("^"),
    sysparm_fields: CATEGORY_FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

export const CreateCatalogCategoryShape = {
  title: z.string(),
  description: z.string().optional(),
  parent: z.string().optional().describe("Parent category title or sys_id"),
  icon: z.string().optional(),
  active: z.boolean().optional().default(true),
  order: z.number().optional(),
};

export async function createCatalogCategory(
  args: z.infer<z.ZodObject<typeof CreateCatalogCategoryShape>>
): Promise<CatalogCategoryRow> {
  const { active, ...rest } = args;
  return createRecord<CatalogCategoryRow>(
    "sc_category",
    { ...rest, active: String(active) },
    WRITE_OPTS
  );
}

export const UpdateCatalogCategoryShape = {
  category_id: z.string().describe("Category sys_id"),
  title: z.string().optional(),
  description: z.string().optional(),
  parent: z.string().optional().describe("Parent category title or sys_id"),
  icon: z.string().optional(),
  active: z.boolean().optional(),
  order: z.number().optional(),
};

export async function updateCatalogCategory(
  args: z.infer<z.ZodObject<typeof UpdateCatalogCategoryShape>>
): Promise<CatalogCategoryRow> {
  const { category_id, active, ...rest } = args;
  const body: Record<string, unknown> = { ...rest };
  if (active !== undefined) body.active = String(active);
  return updateRecord<CatalogCategoryRow>("sc_category", category_id, body, WRITE_OPTS);
}

export const MoveCatalogItemsShape = {
  item_ids: z.array(z.string()).describe("Catalog item sys_ids to move"),
  target_category_id: z.string().describe("Target category title or sys_id"),
};

export async function moveCatalogItems(
  args: z.infer<z.ZodObject<typeof MoveCatalogItemsShape>>
): Promise<{ moved: string[]; failed: { item_id: string; error: string }[] }> {
  const moved: string[] = [];
  const failed: { item_id: string; error: string }[] = [];

  for (const itemId of args.item_ids) {
    try {
      await updateRecord(
        "sc_cat_item",
        itemId,
        { category: args.target_category_id },
        WRITE_OPTS
      );
      moved.push(itemId);
    } catch (e) {
      failed.push({ item_id: itemId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { moved, failed };
}

import { z } from "zod";
import { createRecord, updateRecord, getRecord, queryTable } from "../servicenow-client.js";

// owner/kb_managers/workflow_publish/workflow_retire/kb_knowledge_base/kb_category/parent are
// reference fields — written as display values (name/username/workflow name), not raw sys_ids,
// per the port design notes (bucket B).
const WRITE_OPTS = { sysparm_input_display_value: true };

export interface KnowledgeBaseRow {
  sys_id: string;
  title: string;
  description?: string;
  owner?: string;
  kb_managers?: string;
  active?: string;
}

export const CreateKnowledgeBaseShape = {
  title: z.string(),
  description: z.string().optional(),
  owner: z.string().optional().describe("Admin user or group name"),
  managers: z.string().optional().describe("Group name of users who can manage this knowledge base"),
  publish_workflow: z.string().optional().default("Knowledge - Instant Publish"),
  retire_workflow: z.string().optional().default("Knowledge - Instant Retire"),
};

export async function createKnowledgeBase(
  args: z.infer<z.ZodObject<typeof CreateKnowledgeBaseShape>>
): Promise<KnowledgeBaseRow> {
  const { managers, publish_workflow, retire_workflow, ...rest } = args;
  const body: Record<string, unknown> = { ...rest };
  if (managers) body.kb_managers = managers;
  // FIX: the reference project writes to "workflow_publish"/"workflow_retire", which are not real
  // field names on kb_knowledge_base on any confirmed version — the actual (legacy) field names
  // are "workflow" and "retire_workflow" (confirmed via sys_dictionary). Modern, Flow-Designer-based
  // instances additionally have "kb_publish_flow"/"kb_retire_flow" (referencing sys_hub_flow, not
  // wf_workflow) as the fields that actually drive real KBs' publish/retire automation on this
  // PDI — resolving those is out of scope here (would need Flow Designer-specific lookup logic
  // this project doesn't otherwise touch), so this only fixes the legacy field names.
  if (publish_workflow) body.workflow = publish_workflow;
  if (retire_workflow) body.retire_workflow = retire_workflow;
  return createRecord<KnowledgeBaseRow>("kb_knowledge_base", body, WRITE_OPTS);
}

export const ListKnowledgeBasesShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  active: z.boolean().optional(),
  query: z.string().optional().describe("Matched against title or description"),
};

// list_* tools are caller-paginated (limit/offset = one bounded page), like incident.ts/user.ts —
// a plain queryTable call, not queryTableAll.
export async function listKnowledgeBases(
  args: z.infer<z.ZodObject<typeof ListKnowledgeBasesShape>>
): Promise<KnowledgeBaseRow[]> {
  const parts: string[] = [];
  if (args.active !== undefined) parts.push(`active=${args.active}`);
  if (args.query) parts.push(`titleLIKE${args.query}^ORdescriptionLIKE${args.query}`);

  return queryTable<KnowledgeBaseRow>("kb_knowledge_base", {
    sysparm_query: parts.join("^"),
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

export interface CategoryRow {
  sys_id: string;
  label: string;
  description?: string;
  kb_knowledge_base?: string;
  parent?: string;
  active?: string;
}

export const CreateCategoryShape = {
  title: z.string(),
  description: z.string().optional(),
  knowledge_base: z.string().describe("Knowledge base title or sys_id"),
  parent_category: z.string().optional().describe("Parent category title or sys_id, for a subcategory"),
  parent_table: z.string().optional().describe("Table name where the parent category is defined"),
  active: z.boolean().optional().default(true),
};

export async function createCategory(
  args: z.infer<z.ZodObject<typeof CreateCategoryShape>>
): Promise<CategoryRow> {
  const { title, knowledge_base, parent_category, active, ...rest } = args;
  const body: Record<string, unknown> = {
    ...rest,
    label: title,
    kb_knowledge_base: knowledge_base,
    active: String(active),
  };
  if (parent_category) body.parent = parent_category;
  return createRecord<CategoryRow>("kb_category", body, WRITE_OPTS);
}

export interface ArticleRow {
  sys_id: string;
  short_description: string;
  text?: string;
  kb_knowledge_base?: string;
  kb_category?: string;
  keywords?: string;
  article_type?: string;
  workflow_state?: string;
}

export const CreateArticleShape = {
  title: z.string().describe("Title of the article — always wins over short_description if both are given, matching the reference project's own behavior"),
  text: z.string().describe("Main body, HTML or wiki markup depending on article_type"),
  short_description: z.string(),
  knowledge_base: z.string().describe("Knowledge base title or sys_id"),
  category: z.string().describe("Category title or sys_id"),
  // KNOWN GAP: "keywords" is not a real column on kb_knowledge in this instance's schema
  // (confirmed via sys_dictionary) — ServiceNow's Table API silently drops unrecognized fields in
  // the request body rather than erroring, so this param no-ops here. Kept for interface parity
  // with the reference project; may work on instances where this field genuinely exists.
  keywords: z.string().optional(),
  // The reference project defaults this to the raw literal "html", but this field's actual valid
  // choice values are "text" (label "HTML") and "wiki" (label "Wiki") — confirmed via sys_choice.
  // Defaulting to the correct label instead and relying on sysparm_input_display_value to resolve
  // it is a deliberate fix for the same choice-field trap already hit on incident.ts/change.ts.
  article_type: z.string().optional().default("HTML").describe("HTML or Wiki"),
};

export async function createArticle(
  args: z.infer<z.ZodObject<typeof CreateArticleShape>>
): Promise<ArticleRow> {
  const { title, short_description, knowledge_base, category, ...rest } = args;
  // Matches the reference project exactly: both title and short_description write to the same
  // short_description field, with title applied last so it always wins (both are required there,
  // so short_description's value is provably always overwritten in every real call).
  const body: Record<string, unknown> = {
    ...rest,
    short_description: title || short_description,
    kb_knowledge_base: knowledge_base,
    kb_category: category,
  };
  return createRecord<ArticleRow>("kb_knowledge", body, WRITE_OPTS);
}

export const UpdateArticleShape = {
  article_id: z.string().describe("sys_id of the article to update"),
  title: z.string().optional(),
  text: z.string().optional(),
  short_description: z.string().optional(),
  category: z.string().optional().describe("Category title or sys_id"),
  keywords: z.string().optional(),
};

export async function updateArticle(
  args: z.infer<z.ZodObject<typeof UpdateArticleShape>>
): Promise<ArticleRow> {
  const { article_id, title, text, short_description, category, keywords } = args;
  const body: Record<string, unknown> = {};
  // Matches the reference project exactly: title is applied first, then short_description
  // overwrites it if also provided — the opposite precedence from create_article above, which is
  // a real inconsistency in the reference, not a porting choice.
  if (title !== undefined) body.short_description = title;
  if (text !== undefined) body.text = text;
  if (short_description !== undefined) body.short_description = short_description;
  if (category !== undefined) body.kb_category = category;
  if (keywords !== undefined) body.keywords = keywords;

  return updateRecord<ArticleRow>("kb_knowledge", article_id, body, WRITE_OPTS);
}

export const PublishArticleShape = {
  article_id: z.string().describe("sys_id of the article to publish"),
  workflow_state: z.string().optional().default("published").describe(
    "Choice label/value: draft, review, scheduled_publish, published, pending_retirement, retired, outdated"
  ),
  workflow_version: z.string().optional(),
};

// KNOWN GAP, confirmed empirically on this PDI, platform-wide (not specific to a given knowledge
// base — tested against both a freshly created KB and an existing production KB with real
// published articles, same result both times): a direct workflow_state field write silently
// reverts to "draft", with no error, even though "published" is a genuinely valid choice value
// (confirmed via sys_choice) and the write is otherwise well-formed. Root cause, confirmed by
// inspecting a real KB's data: on this PDI, publish/retire is actually driven by Flow Designer
// flows via kb_knowledge_base.kb_publish_flow/kb_retire_flow (referencing sys_hub_flow) — a
// direct Table API field write to an article's workflow_state doesn't invoke that flow, so
// whatever governs the transition reasserts "draft". Not a porting bug — the reference project's
// identical direct-field-write approach would hit the same wall on any Flow-Designer-governed
// instance. Left implemented as a faithful port; a real fix would mean resolving and invoking the
// KB's kb_publish_flow, out of scope for this Table-API-only project.
export async function publishArticle(
  args: z.infer<z.ZodObject<typeof PublishArticleShape>>
): Promise<ArticleRow> {
  const { article_id, ...rest } = args;
  return updateRecord<ArticleRow>("kb_knowledge", article_id, rest, WRITE_OPTS);
}

export const ListArticlesShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  knowledge_base: z.string().optional().describe("Knowledge base sys_id"),
  category: z.string().optional().describe("Category sys_id"),
  query: z.string().optional().describe("Matched against short_description or text"),
  workflow_state: z.string().optional(),
};

// list_* tools are caller-paginated (limit/offset = one bounded page) — a plain queryTable call.
export async function listArticles(
  args: z.infer<z.ZodObject<typeof ListArticlesShape>>
): Promise<ArticleRow[]> {
  const parts: string[] = [];
  if (args.knowledge_base) parts.push(`kb_knowledge_base.sys_id=${args.knowledge_base}`);
  if (args.category) parts.push(`kb_category.sys_id=${args.category}`);
  if (args.workflow_state) parts.push(`workflow_state=${args.workflow_state}`);
  if (args.query) parts.push(`short_descriptionLIKE${args.query}^ORtextLIKE${args.query}`);

  return queryTable<ArticleRow>("kb_knowledge", {
    sysparm_query: parts.join("^"),
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: "all",
  });
}

export const GetArticleShape = {
  article_id: z.string().describe("sys_id of the article"),
};

export async function getArticle(
  args: z.infer<z.ZodObject<typeof GetArticleShape>>
): Promise<ArticleRow> {
  return getRecord<ArticleRow>("kb_knowledge", args.article_id, { sysparm_display_value: true });
}

export const ListCategoriesShape = {
  knowledge_base: z.string().optional().describe("Knowledge base sys_id"),
  parent_category: z.string().optional().describe("Parent category sys_id"),
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  active: z.boolean().optional(),
  query: z.string().optional().describe("Matched against label or description"),
};

export async function listCategories(
  args: z.infer<z.ZodObject<typeof ListCategoriesShape>>
): Promise<CategoryRow[]> {
  const parts: string[] = [];
  if (args.knowledge_base) parts.push(`kb_knowledge_base.sys_id=${args.knowledge_base}`);
  if (args.parent_category) parts.push(`parent.sys_id=${args.parent_category}`);
  if (args.active !== undefined) parts.push(`active=${args.active}`);
  if (args.query) parts.push(`labelLIKE${args.query}^ORdescriptionLIKE${args.query}`);

  return queryTable<CategoryRow>("kb_category", {
    sysparm_query: parts.join("^"),
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: "all",
  });
}

import { z } from "zod";
import { createRecord, updateRecord, queryTable } from "../servicenow-client.js";

// cat_item is a reference field — written as a display value (catalog item name), not a raw
// sys_id, per the port design notes (bucket B).
const WRITE_OPTS = { sysparm_input_display_value: true };

export interface CatalogItemVariableRow {
  sys_id: string;
  cat_item?: string;
  name?: string;
  type?: string;
  question_text?: string;
  mandatory?: string;
  help_text?: string;
  default_value?: string;
  description?: string;
  order?: string;
  reference?: string;
  reference_qual?: string;
  max_length?: string;
  min?: string;
  max?: string;
}

export const CreateCatalogItemVariableShape = {
  catalog_item_id: z.string().describe("sys_id or name of the catalog item"),
  name: z.string().describe("Internal name of the variable"),
  type: z.string().describe("Variable type, e.g. string, integer, boolean, reference"),
  label: z.string().describe("Display label (question text)"),
  mandatory: z.boolean().optional().default(false),
  help_text: z.string().optional(),
  default_value: z.string().optional(),
  description: z.string().optional(),
  order: z.number().optional(),
  reference_table: z.string().optional().describe("For reference-type variables, the table to reference"),
  reference_qualifier: z.string().optional(),
  max_length: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
};

export async function createCatalogItemVariable(
  args: z.infer<z.ZodObject<typeof CreateCatalogItemVariableShape>>
): Promise<CatalogItemVariableRow> {
  const { catalog_item_id, label, mandatory, reference_table, reference_qualifier, ...rest } = args;
  const body: Record<string, unknown> = {
    ...rest,
    cat_item: catalog_item_id,
    question_text: label,
    mandatory: String(mandatory),
  };
  if (reference_table) body.reference = reference_table;
  if (reference_qualifier) body.reference_qual = reference_qualifier;

  return createRecord<CatalogItemVariableRow>("item_option_new", body, WRITE_OPTS);
}

export const ListCatalogItemVariablesShape = {
  catalog_item_id: z.string().describe("sys_id or name of the catalog item"),
  limit: z.number().optional(),
  offset: z.number().optional(),
};

export async function listCatalogItemVariables(
  args: z.infer<z.ZodObject<typeof ListCatalogItemVariablesShape>>
): Promise<CatalogItemVariableRow[]> {
  return queryTable<CatalogItemVariableRow>("item_option_new", {
    sysparm_query: `cat_item=${args.catalog_item_id}^ORDERBYorder`,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

export const UpdateCatalogItemVariableShape = {
  variable_id: z.string().describe("sys_id of the variable to update"),
  label: z.string().optional(),
  mandatory: z.boolean().optional(),
  help_text: z.string().optional(),
  default_value: z.string().optional(),
  description: z.string().optional(),
  order: z.number().optional(),
  reference_qualifier: z.string().optional(),
  max_length: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
};

export async function updateCatalogItemVariable(
  args: z.infer<z.ZodObject<typeof UpdateCatalogItemVariableShape>>
): Promise<CatalogItemVariableRow> {
  const { variable_id, label, mandatory, reference_qualifier, ...rest } = args;
  const body: Record<string, unknown> = { ...rest };
  if (label !== undefined) body.question_text = label;
  if (mandatory !== undefined) body.mandatory = String(mandatory);
  if (reference_qualifier !== undefined) body.reference_qual = reference_qualifier;

  return updateRecord<CatalogItemVariableRow>("item_option_new", variable_id, body, WRITE_OPTS);
}

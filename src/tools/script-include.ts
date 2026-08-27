import { z } from "zod";
import { createRecord, updateRecord, deleteRecord, getRecord, queryTable } from "../servicenow-client.js";

// HIGHEST-CARE domain in this project (per the port plan, §6 Batch 7): `script` is real
// server-side JavaScript that ServiceNow will execute when called. No display-value tricks here —
// every param maps directly to its real sys_script_include column.

export interface ScriptIncludeRow {
  sys_id: string;
  name: string;
  script?: string;
  description?: string;
  api_name?: string;
  client_callable?: string;
  active?: string;
  access?: string;
  sys_created_on?: string;
  sys_updated_on?: string;
}

const FIELDS =
  "sys_id,name,script,description,api_name,client_callable,active,access,sys_created_on,sys_updated_on";

// Same `sys_id:<id>` bypass-lookup prefix convention as the reference project's
// script_include_id (bucket C in the port design notes) — ported exactly, not generalized.
async function resolveScriptIncludeSysId(scriptIncludeId: string): Promise<string> {
  if (scriptIncludeId.startsWith("sys_id:")) return scriptIncludeId.slice("sys_id:".length);
  const rows = await queryTable<{ sys_id: string }>("sys_script_include", {
    sysparm_query: `name=${scriptIncludeId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No script include found with name "${scriptIncludeId}"`);
  return rows[0].sys_id;
}

// Confirmed via sys_choice on this PDI (name=sys_script_include^element=access): only these two
// values exist — matches the reference's default exactly.
const ACCESS_DESCRIPTION = "Access level: package_private (this application scope only, default) or public (all application scopes)";

export const ListScriptIncludesShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  active: z.boolean().optional(),
  client_callable: z.boolean().optional(),
  query: z.string().optional().describe("Substring match against the script include's name"),
};

export async function listScriptIncludes(
  args: z.infer<z.ZodObject<typeof ListScriptIncludesShape>>
): Promise<ScriptIncludeRow[]> {
  const parts: string[] = [];
  if (args.active !== undefined) parts.push(`active=${args.active}`);
  if (args.client_callable !== undefined) parts.push(`client_callable=${args.client_callable}`);
  if (args.query) parts.push(`nameLIKE${args.query}`);

  // Deliberately omits `script` from the field list, unlike get_script_include — a list call
  // browsing many rows shouldn't dump full script bodies into the response by default.
  return queryTable<ScriptIncludeRow>("sys_script_include", {
    sysparm_query: parts.join("^"),
    sysparm_fields: FIELDS.replace("script,", ""),
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
  });
}

export const GetScriptIncludeShape = {
  script_include_id: z.string().describe("Name, or sys_id prefixed with 'sys_id:' (e.g. sys_id:abc123...)"),
};

export async function getScriptInclude(
  args: z.infer<z.ZodObject<typeof GetScriptIncludeShape>>
): Promise<ScriptIncludeRow> {
  const sysId = await resolveScriptIncludeSysId(args.script_include_id);
  return getRecord<ScriptIncludeRow>("sys_script_include", sysId, { sysparm_fields: FIELDS });
}

export const CreateScriptIncludeShape = {
  name: z.string(),
  script: z.string().describe("The JavaScript source. This will be live, executable server-side code."),
  description: z.string().optional(),
  api_name: z.string().optional(),
  client_callable: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
  access: z.string().optional().default("package_private").describe(ACCESS_DESCRIPTION),
};

export async function createScriptInclude(
  args: z.infer<z.ZodObject<typeof CreateScriptIncludeShape>>
): Promise<ScriptIncludeRow> {
  return createRecord<ScriptIncludeRow>("sys_script_include", args);
}

export const UpdateScriptIncludeShape = {
  script_include_id: z.string().describe("Name, or sys_id prefixed with 'sys_id:'"),
  script: z.string().optional(),
  description: z.string().optional(),
  api_name: z.string().optional(),
  client_callable: z.boolean().optional(),
  active: z.boolean().optional(),
  access: z.string().optional().describe(ACCESS_DESCRIPTION),
};

export async function updateScriptInclude(
  args: z.infer<z.ZodObject<typeof UpdateScriptIncludeShape>>
): Promise<ScriptIncludeRow> {
  const { script_include_id, ...fields } = args;
  const sysId = await resolveScriptIncludeSysId(script_include_id);
  return updateRecord<ScriptIncludeRow>("sys_script_include", sysId, fields);
}

export const DeleteScriptIncludeShape = {
  script_include_id: z.string().describe("Name, or sys_id prefixed with 'sys_id:'"),
};

export async function deleteScriptInclude(
  args: z.infer<z.ZodObject<typeof DeleteScriptIncludeShape>>
): Promise<{ deleted: true }> {
  const sysId = await resolveScriptIncludeSysId(args.script_include_id);
  await deleteRecord("sys_script_include", sysId);
  return { deleted: true };
}

import { z } from "zod";
import { createRecord, updateRecord, deleteRecord, getRecord, queryTable } from "../servicenow-client.js";

// This is classic Workflow (wf_workflow/wf_workflow_version/wf_activity) — legacy on modern
// ServiceNow releases, superseded by Flow Designer. Confirmed live and queryable on this PDI
// (GET wf_workflow?sysparm_limit=1 returned real, years-old system workflow data) before writing
// any of this, per the plan's Batch 8 gate.
//
// Three of the reference project's 12 tools are NOT ported here — not a porting mistake, a real
// schema gap confirmed via sys_dictionary before writing code (same discipline as Batch 6 dropping
// epic.ts):
//   - activate_workflow / deactivate_workflow: wf_workflow has NO `active` field on this PDI at
//     all (confirmed by dumping every element on the table — description/name/table/access/
//     sys_domain/preview/template/sys_overrides, nothing resembling active/enabled). Both tools'
//     entire premise is setting that field, so there's nothing to port.
//   - reorder_workflow_activities: wf_activity has NO `order` field either (its real fields are
//     canvas-position x/y plus graph-structure fields like `parent`/`stage` — classic Workflow
//     ordering is driven by the visual transition graph, not a simple integer). Same situation.
// `delete_workflow` is excluded per the plan §5 — confirmed not registered as an MCP tool in the
// reference either.
//
// `add_workflow_activity`'s `activity_type` is also NOT ported as the reference wrote it: the
// reference treats it as a plain string field, but wf_activity has no such field — the real column
// is `activity_definition`, a reference to wf_activity_definition (values like "Notification",
// "Approval Coordinator", confirmed via a live query). Fixed to resolve by name against that table,
// same bucket-A pattern as resolveUserSysId/resolveGroupSysId in shared.ts, rather than porting a
// param that would silently no-op. `description` is also dropped from add/update_workflow_activity
// — wf_activity has no such field either (confirmed via the same dictionary dump).
//
// KNOWN GAP, ported faithfully anyway: add_workflow_activity requires a workflow_version_id that
// no tool in this domain (or the reference's) ever creates — confirmed by reading the reference
// source, this is the reference project's own real gap, not something introduced here. A caller
// must get one from list_workflow_versions against a pre-existing workflow.

async function resolveWorkflowSysId(workflowId: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(workflowId)) return workflowId;
  const rows = await queryTable<{ sys_id: string }>("wf_workflow", {
    sysparm_query: `name=${workflowId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No workflow found with name "${workflowId}"`);
  return rows[0].sys_id;
}

async function resolveActivityDefinitionSysId(name: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(name)) return name;
  const rows = await queryTable<{ sys_id: string }>("wf_activity_definition", {
    sysparm_query: `name=${name}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No workflow activity definition found with name "${name}"`);
  return rows[0].sys_id;
}

const AttributesShape = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Extra sys_workflow/wf_activity fields to set directly, beyond the named params above.");

export const ListWorkflowsShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  name: z.string().optional().describe("Filter by name (substring match)"),
  query: z.string().optional().describe("Additional raw encoded query, ANDed with the filters above"),
};

export async function listWorkflows(
  args: z.infer<z.ZodObject<typeof ListWorkflowsShape>>
): Promise<Record<string, unknown>[]> {
  const parts: string[] = [];
  if (args.name) parts.push(`nameLIKE${args.name}`);
  if (args.query) parts.push(args.query);

  return queryTable("wf_workflow", {
    sysparm_query: parts.join("^"),
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
  });
}

export const ListWorkflowVersionsShape = {
  workflow_id: z.string().describe("Workflow name or sys_id"),
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
};

export async function listWorkflowVersions(
  args: z.infer<z.ZodObject<typeof ListWorkflowVersionsShape>>
): Promise<Record<string, unknown>[]> {
  const sysId = await resolveWorkflowSysId(args.workflow_id);
  return queryTable("wf_workflow_version", {
    sysparm_query: `workflow=${sysId}`,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
  });
}

export const GetWorkflowDetailsShape = {
  workflow_id: z.string().describe("Workflow name or sys_id"),
  include_versions: z.boolean().optional().default(false),
};

export async function getWorkflowDetails(
  args: z.infer<z.ZodObject<typeof GetWorkflowDetailsShape>>
): Promise<Record<string, unknown>> {
  const sysId = await resolveWorkflowSysId(args.workflow_id);
  const workflow = await getRecord("wf_workflow", sysId);
  if (!args.include_versions) return workflow;

  const versions = await queryTable("wf_workflow_version", {
    sysparm_query: `workflow=${sysId}`,
  });
  return { ...workflow, versions };
}

export const GetWorkflowActivitiesShape = {
  workflow_id: z.string().describe("Workflow name or sys_id"),
  version: z.string().optional().describe("A specific wf_workflow_version sys_id; defaults to the latest published version"),
};

export async function getWorkflowActivities(
  args: z.infer<z.ZodObject<typeof GetWorkflowActivitiesShape>>
): Promise<{ workflow_id: string; version_id: string; activities: Record<string, unknown>[] }> {
  const workflowSysId = await resolveWorkflowSysId(args.workflow_id);

  let versionId = args.version;
  if (!versionId) {
    const versions = await queryTable<{ sys_id: string }>("wf_workflow_version", {
      sysparm_query: `workflow=${workflowSysId}^published=true^ORDERBYDESCversion`,
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    });
    if (versions.length === 0) {
      throw new Error(`No published workflow version found for workflow "${args.workflow_id}"`);
    }
    versionId = versions[0].sys_id;
  }

  const activities = await queryTable("wf_activity", {
    sysparm_query: `workflow_version=${versionId}`,
  });
  return { workflow_id: workflowSysId, version_id: versionId, activities };
}

export const CreateWorkflowShape = {
  name: z.string(),
  description: z.string().optional(),
  table: z.string().optional().describe("Table this workflow applies to, e.g. incident"),
  attributes: AttributesShape,
};

export async function createWorkflow(
  args: z.infer<z.ZodObject<typeof CreateWorkflowShape>>
): Promise<Record<string, unknown>> {
  const { attributes, ...rest } = args;
  return createRecord("wf_workflow", { ...rest, ...(attributes ?? {}) });
}

export const UpdateWorkflowShape = {
  workflow_id: z.string().describe("Workflow name or sys_id"),
  name: z.string().optional(),
  description: z.string().optional(),
  table: z.string().optional(),
  attributes: AttributesShape,
};

export async function updateWorkflow(
  args: z.infer<z.ZodObject<typeof UpdateWorkflowShape>>
): Promise<Record<string, unknown>> {
  const { workflow_id, attributes, ...rest } = args;
  const sysId = await resolveWorkflowSysId(workflow_id);
  return updateRecord("wf_workflow", sysId, { ...rest, ...(attributes ?? {}) });
}

export const AddWorkflowActivityShape = {
  workflow_version_id: z.string().describe("sys_id of a wf_workflow_version (see list_workflow_versions)"),
  name: z.string(),
  activity_type: z.string().describe("Name of a wf_activity_definition, e.g. 'Notification', 'Approval Coordinator' (resolved to activity_definition)"),
  attributes: AttributesShape,
};

export async function addWorkflowActivity(
  args: z.infer<z.ZodObject<typeof AddWorkflowActivityShape>>
): Promise<Record<string, unknown>> {
  const { workflow_version_id, name, activity_type, attributes } = args;
  const activityDefinitionSysId = await resolveActivityDefinitionSysId(activity_type);
  return createRecord("wf_activity", {
    workflow_version: workflow_version_id,
    name,
    activity_definition: activityDefinitionSysId,
    ...(attributes ?? {}),
  });
}

export const UpdateWorkflowActivityShape = {
  activity_id: z.string().describe("sys_id of the wf_activity record"),
  name: z.string().optional(),
  attributes: AttributesShape,
};

export async function updateWorkflowActivity(
  args: z.infer<z.ZodObject<typeof UpdateWorkflowActivityShape>>
): Promise<Record<string, unknown>> {
  const { activity_id, attributes, ...rest } = args;
  return updateRecord("wf_activity", activity_id, { ...rest, ...(attributes ?? {}) });
}

export const DeleteWorkflowActivityShape = {
  activity_id: z.string().describe("sys_id of the wf_activity record"),
};

export async function deleteWorkflowActivity(
  args: z.infer<z.ZodObject<typeof DeleteWorkflowActivityShape>>
): Promise<{ deleted: true }> {
  await deleteRecord("wf_activity", args.activity_id);
  return { deleted: true };
}

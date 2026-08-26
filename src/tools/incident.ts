import { z } from "zod";
import { createRecord, updateRecord, queryTable } from "../servicenow-client.js";

// assigned_to/assignment_group/caller_id are written as display values (username/group name),
// not raw sys_ids — see WriteOptions in servicenow-client.ts (bucket B in the port design notes).
const WRITE_OPTS = { sysparm_input_display_value: true };

export interface IncidentRow {
  sys_id: string;
  number: string;
  short_description: string;
  description?: string;
  state: string;
  priority?: string;
  category?: string;
  assigned_to?: string;
  assignment_group?: string;
}

const FIELDS =
  "sys_id,number,short_description,description,state,priority,impact,urgency,category," +
  "subcategory,assigned_to,assignment_group,caller_id,sys_created_on";

export const CreateIncidentShape = {
  short_description: z.string().describe("Short summary of the incident"),
  description: z.string().optional(),
  caller_id: z.string().optional().describe("Username, email, or sys_id of the caller"),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  priority: z.string().optional(),
  impact: z.string().optional(),
  urgency: z.string().optional(),
  assigned_to: z.string().optional().describe("Username, email, or sys_id"),
  assignment_group: z.string().optional().describe("Group name or sys_id"),
};

export async function createIncident(
  args: z.infer<z.ZodObject<typeof CreateIncidentShape>>
): Promise<IncidentRow> {
  return createRecord<IncidentRow>("incident", args, WRITE_OPTS);
}

export const UpdateIncidentShape = {
  incident_id: z.string().describe("sys_id or incident number (e.g. INC0010001)"),
  short_description: z.string().optional(),
  description: z.string().optional(),
  state: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  priority: z.string().optional(),
  impact: z.string().optional(),
  urgency: z.string().optional(),
  assigned_to: z.string().optional(),
  assignment_group: z.string().optional(),
  work_notes: z.string().optional(),
  close_notes: z.string().optional(),
  close_code: z.string().optional(),
};

async function resolveIncidentSysId(incidentId: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(incidentId)) return incidentId;
  const rows = await queryTable<{ sys_id: string }>("incident", {
    sysparm_query: `number=${incidentId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No incident found with number "${incidentId}"`);
  return rows[0].sys_id;
}

export async function updateIncident(
  args: z.infer<z.ZodObject<typeof UpdateIncidentShape>>
): Promise<IncidentRow> {
  const { incident_id, ...fields } = args;
  const sysId = await resolveIncidentSysId(incident_id);
  return updateRecord<IncidentRow>("incident", sysId, fields, WRITE_OPTS);
}

export const AddCommentShape = {
  incident_id: z.string().describe("sys_id or incident number"),
  comment: z.string(),
  is_work_note: z.boolean().optional().default(false).describe(
    "true = internal work note, false = customer-visible comment (default)"
  ),
};

export async function addComment(
  args: z.infer<z.ZodObject<typeof AddCommentShape>>
): Promise<IncidentRow> {
  const sysId = await resolveIncidentSysId(args.incident_id);
  const field = args.is_work_note ? "work_notes" : "comments";
  return updateRecord<IncidentRow>("incident", sysId, { [field]: args.comment });
}

export const ResolveIncidentShape = {
  incident_id: z.string().describe("sys_id or incident number"),
  resolution_code: z.string(),
  resolution_notes: z.string(),
};

export async function resolveIncident(
  args: z.infer<z.ZodObject<typeof ResolveIncidentShape>>
): Promise<IncidentRow> {
  const sysId = await resolveIncidentSysId(args.incident_id);
  return updateRecord<IncidentRow>("incident", sysId, {
    state: "6", // Resolved (standard out-of-the-box ServiceNow incident state)
    close_code: args.resolution_code,
    close_notes: args.resolution_notes,
  });
}

export const ListIncidentsShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  state: z.string().optional(),
  assigned_to: z.string().optional(),
  category: z.string().optional(),
  query: z.string().optional().describe("Additional raw encoded query, ANDed with the filters above"),
};

// list_* tools are caller-paginated (limit/offset = one bounded page, like the reference project),
// not "fetch everything" — that's what queryTableAll is for (used by the syslog/dev-work reports).
// A plain queryTable call is the right primitive here.
export async function listIncidents(
  args: z.infer<z.ZodObject<typeof ListIncidentsShape>>
): Promise<IncidentRow[]> {
  const parts: string[] = [];
  if (args.state) parts.push(`state=${args.state}`);
  if (args.assigned_to) parts.push(`assigned_to=${args.assigned_to}`);
  if (args.category) parts.push(`category=${args.category}`);
  if (args.query) parts.push(args.query);
  parts.push("ORDERBYDESCsys_created_on");

  return queryTable<IncidentRow>("incident", {
    sysparm_query: parts.join("^"),
    sysparm_fields: FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
  });
}

export const GetIncidentByNumberShape = {
  incident_number: z.string(),
};

export async function getIncidentByNumber(
  args: z.infer<z.ZodObject<typeof GetIncidentByNumberShape>>
): Promise<IncidentRow> {
  const rows = await queryTable<IncidentRow>("incident", {
    sysparm_query: `number=${args.incident_number}`,
    sysparm_fields: FIELDS,
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No incident found with number "${args.incident_number}"`);
  return rows[0];
}

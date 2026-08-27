import { z } from "zod";
import { createRecord, updateRecord, queryTable } from "../servicenow-client.js";
import { buildTimeframeQuery } from "./shared.js";

// project_manager/assignment_group/assigned_to are reference fields — bucket B, same convention
// as every other domain.
const WRITE_OPTS = { sysparm_input_display_value: true };

// Reference project's CreateProjectParams/UpdateProjectParams field is `percentage_complete` —
// confirmed via sys_dictionary that pm_project's actual column (inherited from planned_task) is
// `percent_complete`. A real bug in the reference, not a porting mistake: writing
// `percentage_complete` there silently no-ops (ServiceNow drops unrecognized JSON body fields
// rather than erroring — same failure mode as the `keywords`/kb_knowledge gotcha from Batch 5).
// Caught here by noticing the field was absent from the create/update MCP round-trip response
// during Batch 6 verification. Named correctly (`percent_complete`) rather than porting the bug.
export interface ProjectRow {
  sys_id: string;
  number: string;
  short_description: string;
  description?: string;
  status?: string;
  state?: string;
  project_manager?: string;
  percent_complete?: number;
  assignment_group?: string;
  assigned_to?: string;
  start_date?: string;
  end_date?: string;
}

const FIELDS =
  "sys_id,number,short_description,description,status,state,project_manager," +
  "percent_complete,assignment_group,assigned_to,start_date,end_date,sys_created_on";

// pm_project.state (task.state, integer) has no sys_choice entries configured on this PDI — the
// reference project's documented values are the standard out-of-the-box PPM state set, kept here
// as guidance since they couldn't be confirmed against this instance's own choice list (unlike
// rm_story/rm_scrum_task's state, which was confirmed). Verify against sys_choice on any instance
// where this doesn't behave as expected.
const STATE_DESCRIPTION =
  "State (not confirmed via sys_choice on this PDI — no choices configured; standard PPM values): " +
  "-5 Pending, 1 Open, 2 Work in progress, 3 Closed Complete, 4 Closed Incomplete, 5 Closed Skipped";
// pm_project.status is a plain free-text string field (internal_type "string", not a choice list)
// — confirmed via sys_dictionary. "green"/"yellow"/"red" is convention, not enforced.
const STATUS_DESCRIPTION = "Status: free-text field, conventionally green, yellow, or red";

async function resolveProjectSysId(projectId: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(projectId)) return projectId;
  const rows = await queryTable<{ sys_id: string }>("pm_project", {
    sysparm_query: `number=${projectId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No project found with number "${projectId}"`);
  return rows[0].sys_id;
}

export const CreateProjectShape = {
  short_description: z.string().describe("Project name"),
  description: z.string().optional(),
  status: z.string().optional().describe(STATUS_DESCRIPTION),
  state: z.string().optional().describe(STATE_DESCRIPTION),
  project_manager: z.string().optional().describe("Username, email, or sys_id"),
  percent_complete: z.number().optional(),
  assignment_group: z.string().optional().describe("Group name or sys_id"),
  assigned_to: z.string().optional().describe("Username, email, or sys_id"),
  start_date: z.string().optional().describe("YYYY-MM-DD"),
  end_date: z.string().optional().describe("YYYY-MM-DD"),
};

export async function createProject(
  args: z.infer<z.ZodObject<typeof CreateProjectShape>>
): Promise<ProjectRow> {
  return createRecord<ProjectRow>("pm_project", args, WRITE_OPTS);
}

export const UpdateProjectShape = {
  project_id: z.string().describe("sys_id or project number (e.g. PRJ0010001)"),
  short_description: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional().describe(STATUS_DESCRIPTION),
  state: z.string().optional().describe(STATE_DESCRIPTION),
  project_manager: z.string().optional(),
  percent_complete: z.number().optional(),
  assignment_group: z.string().optional(),
  assigned_to: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
};

export async function updateProject(
  args: z.infer<z.ZodObject<typeof UpdateProjectShape>>
): Promise<ProjectRow> {
  const { project_id, ...fields } = args;
  const sysId = await resolveProjectSysId(project_id);
  return updateRecord<ProjectRow>("pm_project", sysId, fields, WRITE_OPTS);
}

export const ListProjectsShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  state: z.string().optional(),
  assignment_group: z.string().optional(),
  timeframe: z.enum(["upcoming", "in-progress", "completed"]).optional(),
  query: z.string().optional().describe("Additional raw encoded query, ANDed with the filters above"),
};

export async function listProjects(
  args: z.infer<z.ZodObject<typeof ListProjectsShape>>
): Promise<ProjectRow[]> {
  const parts: string[] = [];
  if (args.state) parts.push(`state=${args.state}`);
  if (args.assignment_group) parts.push(`assignment_group=${args.assignment_group}`);
  if (args.timeframe) parts.push(buildTimeframeQuery(args.timeframe));
  if (args.query) parts.push(args.query);

  return queryTable<ProjectRow>("pm_project", {
    sysparm_query: parts.join("^"),
    sysparm_fields: FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

import { z } from "zod";
import { createRecord, updateRecord, queryTable } from "../servicenow-client.js";
import { buildTimeframeQuery } from "./shared.js";
import { resolveStorySysId } from "./story.js";

const WRITE_OPTS = { sysparm_input_display_value: true };

// Reference project's CreateScrumTaskParams/UpdateScrumTaskParams also carry a `type` field
// ("1 Analysis, 2 Coding, 3 Documentation, 4 Testing"). Confirmed via sys_dictionary on this PDI:
// rm_scrum_task has no `type` element anywhere in its inheritance chain (rm_scrum_task ->
// rm_task -> planned_task -> task) — dropped rather than porting a field that doesn't exist here.
export interface ScrumTaskRow {
  sys_id: string;
  number: string;
  story?: string;
  short_description: string;
  priority?: string;
  planned_hours?: number;
  remaining_hours?: number;
  hours?: number;
  description?: string;
  state?: string;
  assignment_group?: string;
  assigned_to?: string;
}

const FIELDS =
  "sys_id,number,story,short_description,priority,planned_hours,remaining_hours,hours," +
  "description,state,assignment_group,assigned_to,sys_created_on";

// Confirmed via sys_choice on this PDI (name=rm_scrum_task^element=state): matches the reference.
const STATE_DESCRIPTION = "State: -6 Draft, 1 Ready, 2 Work in progress, 3 Complete, 4 Cancelled";
// Confirmed via sys_choice on this PDI (name=task^element=priority) — shared across the task
// hierarchy, so applies to rm_scrum_task too.
const PRIORITY_DESCRIPTION = "Priority: 1 Critical, 2 High, 3 Moderate, 4 Low, 5 Planning";

async function resolveScrumTaskSysId(scrumTaskId: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(scrumTaskId)) return scrumTaskId;
  const rows = await queryTable<{ sys_id: string }>("rm_scrum_task", {
    sysparm_query: `number=${scrumTaskId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No scrum task found with number "${scrumTaskId}"`);
  return rows[0].sys_id;
}

export const CreateScrumTaskShape = {
  story: z.string().describe("Story sys_id or number (e.g. STRY0010001) that this task belongs to"),
  short_description: z.string(),
  priority: z.string().optional().describe(PRIORITY_DESCRIPTION),
  planned_hours: z.number().optional(),
  remaining_hours: z.number().optional(),
  hours: z.number().optional().describe("Actual hours worked"),
  description: z.string().optional(),
  state: z.string().optional().describe(STATE_DESCRIPTION),
  assignment_group: z.string().optional().describe("Group name or sys_id"),
  assigned_to: z.string().optional().describe("Username, email, or sys_id"),
  work_notes: z.string().optional(),
};

export async function createScrumTask(
  args: z.infer<z.ZodObject<typeof CreateScrumTaskShape>>
): Promise<ScrumTaskRow> {
  const { story, ...rest } = args;
  const storySysId = await resolveStorySysId(story);
  return createRecord<ScrumTaskRow>("rm_scrum_task", { ...rest, story: storySysId }, WRITE_OPTS);
}

export const UpdateScrumTaskShape = {
  scrum_task_id: z.string().describe("sys_id or scrum task number (e.g. SCTASK0010001)"),
  short_description: z.string().optional(),
  priority: z.string().optional().describe(PRIORITY_DESCRIPTION),
  planned_hours: z.number().optional(),
  remaining_hours: z.number().optional(),
  hours: z.number().optional(),
  description: z.string().optional(),
  state: z.string().optional().describe(STATE_DESCRIPTION),
  assignment_group: z.string().optional(),
  assigned_to: z.string().optional(),
  work_notes: z.string().optional(),
};

export async function updateScrumTask(
  args: z.infer<z.ZodObject<typeof UpdateScrumTaskShape>>
): Promise<ScrumTaskRow> {
  const { scrum_task_id, ...fields } = args;
  const sysId = await resolveScrumTaskSysId(scrum_task_id);
  return updateRecord<ScrumTaskRow>("rm_scrum_task", sysId, fields, WRITE_OPTS);
}

export const ListScrumTasksShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  state: z.string().optional(),
  assignment_group: z.string().optional(),
  timeframe: z.enum(["upcoming", "in-progress", "completed"]).optional(),
  query: z.string().optional().describe("Additional raw encoded query, ANDed with the filters above"),
};

export async function listScrumTasks(
  args: z.infer<z.ZodObject<typeof ListScrumTasksShape>>
): Promise<ScrumTaskRow[]> {
  const parts: string[] = [];
  if (args.state) parts.push(`state=${args.state}`);
  if (args.assignment_group) parts.push(`assignment_group=${args.assignment_group}`);
  if (args.timeframe) parts.push(buildTimeframeQuery(args.timeframe));
  if (args.query) parts.push(args.query);

  return queryTable<ScrumTaskRow>("rm_scrum_task", {
    sysparm_query: parts.join("^"),
    sysparm_fields: FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

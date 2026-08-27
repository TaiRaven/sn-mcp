import { z } from "zod";
import { createRecord, updateRecord, deleteRecord, queryTable } from "../servicenow-client.js";
import { buildTimeframeQuery } from "./shared.js";

// assigned_to/assignment_group are reference fields written as display values (username/group
// name), not raw sys_ids — bucket B, same convention as incident.ts/change.ts.
const WRITE_OPTS = { sysparm_input_display_value: true };

// Reference project's CreateStoryParams/UpdateStoryParams also carry `epic` and `project` fields,
// referencing rm_epic/pm_project. Confirmed via sys_dictionary on this PDI: rm_story has neither
// an `epic` nor a `project` element at all — this instance's Agile plugin install doesn't wire
// stories to epics or projects (consistent with rm_epic itself not existing, see the Batch 6
// liveness check). Dropped both params rather than porting fields that don't exist here.
export interface StoryRow {
  sys_id: string;
  number: string;
  short_description: string;
  acceptance_criteria?: string;
  description?: string;
  state?: string;
  assignment_group?: string;
  story_points?: number;
  assigned_to?: string;
}

const FIELDS =
  "sys_id,number,short_description,acceptance_criteria,description,state," +
  "assignment_group,story_points,assigned_to,sys_created_on";

// Confirmed via sys_choice on this PDI (name=rm_story^element=state): matches the reference's
// documented values exactly, so passed through as the raw numeric string (no display-value
// resolution needed for this field).
const STATE_DESCRIPTION =
  "State: -6 Draft, -7 Ready for testing, -8 Testing, 1 Ready, 2 Work in progress, 3 Complete, 4 Cancelled";

export async function resolveStorySysId(storyId: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(storyId)) return storyId;
  const rows = await queryTable<{ sys_id: string }>("rm_story", {
    sysparm_query: `number=${storyId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No story found with number "${storyId}"`);
  return rows[0].sys_id;
}

export const CreateStoryShape = {
  short_description: z.string(),
  acceptance_criteria: z.string(),
  description: z.string().optional(),
  state: z.string().optional().describe(STATE_DESCRIPTION),
  assignment_group: z.string().optional().describe("Group name or sys_id"),
  story_points: z.number().optional().default(10),
  assigned_to: z.string().optional().describe("Username, email, or sys_id"),
  work_notes: z.string().optional(),
};

export async function createStory(
  args: z.infer<z.ZodObject<typeof CreateStoryShape>>
): Promise<StoryRow> {
  return createRecord<StoryRow>("rm_story", args, WRITE_OPTS);
}

export const UpdateStoryShape = {
  story_id: z.string().describe("sys_id or story number (e.g. STRY0010001)"),
  short_description: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  description: z.string().optional(),
  state: z.string().optional().describe(STATE_DESCRIPTION),
  assignment_group: z.string().optional(),
  story_points: z.number().optional(),
  assigned_to: z.string().optional(),
  work_notes: z.string().optional(),
};

export async function updateStory(
  args: z.infer<z.ZodObject<typeof UpdateStoryShape>>
): Promise<StoryRow> {
  const { story_id, ...fields } = args;
  const sysId = await resolveStorySysId(story_id);
  return updateRecord<StoryRow>("rm_story", sysId, fields, WRITE_OPTS);
}

export const ListStoriesShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  state: z.string().optional(),
  assignment_group: z.string().optional(),
  timeframe: z.enum(["upcoming", "in-progress", "completed"]).optional(),
  query: z.string().optional().describe("Additional raw encoded query, ANDed with the filters above"),
};

// Caller-paginated (limit/offset = one bounded page) — plain queryTable, same discipline as every
// other list_* tool in this project.
export async function listStories(
  args: z.infer<z.ZodObject<typeof ListStoriesShape>>
): Promise<StoryRow[]> {
  const parts: string[] = [];
  if (args.state) parts.push(`state=${args.state}`);
  if (args.assignment_group) parts.push(`assignment_group=${args.assignment_group}`);
  if (args.timeframe) parts.push(buildTimeframeQuery(args.timeframe));
  if (args.query) parts.push(args.query);

  return queryTable<StoryRow>("rm_story", {
    sysparm_query: parts.join("^"),
    sysparm_fields: FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

interface StoryDependencyRow {
  sys_id: string;
  dependent_story?: string;
  prerequisite_story?: string;
}

export const ListStoryDependenciesShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  dependent_story: z.string().optional().describe("sys_id of the dependent story"),
  prerequisite_story: z.string().optional().describe("sys_id of the prerequisite story"),
  query: z.string().optional(),
};

// Confirmed live on this PDI (sysparm_limit=1 GET returned 200) even though it's not reachable
// through rm_story itself.
export async function listStoryDependencies(
  args: z.infer<z.ZodObject<typeof ListStoryDependenciesShape>>
): Promise<StoryDependencyRow[]> {
  const parts: string[] = [];
  if (args.dependent_story) parts.push(`dependent_story=${args.dependent_story}`);
  if (args.prerequisite_story) parts.push(`prerequisite_story=${args.prerequisite_story}`);
  if (args.query) parts.push(args.query);

  return queryTable<StoryDependencyRow>("m2m_story_dependencies", {
    sysparm_query: parts.join("^"),
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

export const CreateStoryDependencyShape = {
  dependent_story: z.string().describe("sys_id of the dependent story"),
  prerequisite_story: z.string().describe("sys_id of the prerequisite story"),
};

export async function createStoryDependency(
  args: z.infer<z.ZodObject<typeof CreateStoryDependencyShape>>
): Promise<StoryDependencyRow> {
  return createRecord<StoryDependencyRow>("m2m_story_dependencies", args);
}

export const DeleteStoryDependencyShape = {
  dependency_id: z.string().describe("sys_id of the dependency record"),
};

export async function deleteStoryDependency(
  args: z.infer<z.ZodObject<typeof DeleteStoryDependencyShape>>
): Promise<{ deleted: true }> {
  await deleteRecord("m2m_story_dependencies", args.dependency_id);
  return { deleted: true };
}

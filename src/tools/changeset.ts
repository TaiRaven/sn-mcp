import { z } from "zod";
import { createRecord, updateRecord, getRecord, queryTable } from "../servicenow-client.js";

// application/developer/update_set are reference fields — written as display values (app name,
// username), not raw sys_ids, per the port design notes (bucket B).
const WRITE_OPTS = { sysparm_input_display_value: true };

function isoLiteral(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Deliberately not using javascript:gs.beginningOfLastWeek()/etc like the reference project does —
// this project already hit a real bug once (see shared.ts's buildTimeframeQuery) from a
// javascript:gs.* date function evaluating in the instance timezone while the compared field comes
// back as raw UTC. These are literal UTC boundaries for the previous calendar week (Mon-Sun) and
// previous calendar month instead — same intent, no timezone risk.
function buildRecentQuery(timeframe: "recent" | "last_week" | "last_month"): string {
  const now = new Date();

  if (timeframe === "recent") {
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return `sys_created_on>=${isoLiteral(from)}^sys_created_on<=${isoLiteral(now)}`;
  }

  if (timeframe === "last_week") {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayOfWeek = today.getUTCDay() === 0 ? 7 : today.getUTCDay(); // Mon=1..Sun=7
    const thisMonday = new Date(today.getTime() - (dayOfWeek - 1) * 86400000);
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000);
    const lastSundayEnd = new Date(thisMonday.getTime() - 1000);
    return `sys_created_on>=${isoLiteral(lastMonday)}^sys_created_on<=${isoLiteral(lastSundayEnd)}`;
  }

  // last_month
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastOfLastMonth = new Date(firstOfThisMonth.getTime() - 1000);
  return `sys_created_on>=${isoLiteral(firstOfLastMonth)}^sys_created_on<=${isoLiteral(lastOfLastMonth)}`;
}

export interface ChangesetRow {
  sys_id: string;
  name: string;
  description?: string;
  application?: string;
  developer?: string;
  state?: string;
}

async function resolveChangesetSysId(changesetId: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(changesetId)) return changesetId;
  const rows = await queryTable<{ sys_id: string }>("sys_update_set", {
    sysparm_query: `name=${changesetId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No changeset found with name "${changesetId}"`);
  return rows[0].sys_id;
}

export const ListChangesetsShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  state: z.string().optional(),
  application: z.string().optional(),
  developer: z.string().optional(),
  timeframe: z.enum(["recent", "last_week", "last_month"]).optional(),
  query: z.string().optional().describe("Additional raw encoded query, ANDed with the filters above"),
};

// list_* tools are caller-paginated (limit/offset = one bounded page), like incident.ts/user.ts —
// a plain queryTable call, not queryTableAll.
export async function listChangesets(
  args: z.infer<z.ZodObject<typeof ListChangesetsShape>>
): Promise<ChangesetRow[]> {
  const parts: string[] = [];
  if (args.state) parts.push(`state=${args.state}`);
  if (args.application) parts.push(`application=${args.application}`);
  if (args.developer) parts.push(`developer=${args.developer}`);
  if (args.timeframe) parts.push(buildRecentQuery(args.timeframe));
  if (args.query) parts.push(args.query);

  return queryTable<ChangesetRow>("sys_update_set", {
    sysparm_query: parts.join("^"),
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
  });
}

export const GetChangesetDetailsShape = {
  changeset_id: z.string().describe("sys_id or name of the changeset"),
};

interface UpdateXmlRow {
  sys_id: string;
  name?: string;
  type?: string;
  action?: string;
}

export async function getChangesetDetails(
  args: z.infer<z.ZodObject<typeof GetChangesetDetailsShape>>
): Promise<ChangesetRow & { changes: UpdateXmlRow[] }> {
  const sysId = await resolveChangesetSysId(args.changeset_id);
  const changeset = await getRecord<ChangesetRow>("sys_update_set", sysId);
  const changes = await queryTable<UpdateXmlRow>("sys_update_xml", {
    sysparm_query: `update_set=${sysId}`,
  });
  return { ...changeset, changes };
}

export const CreateChangesetShape = {
  name: z.string(),
  description: z.string().optional(),
  application: z.string().describe("Application name or sys_id"),
  developer: z.string().optional().describe("Username or sys_id"),
};

export async function createChangeset(
  args: z.infer<z.ZodObject<typeof CreateChangesetShape>>
): Promise<ChangesetRow> {
  return createRecord<ChangesetRow>("sys_update_set", args, WRITE_OPTS);
}

export const UpdateChangesetShape = {
  changeset_id: z.string().describe("sys_id or name of the changeset"),
  name: z.string().optional(),
  description: z.string().optional(),
  state: z.string().optional().describe("in progress, complete, or ignore"),
  developer: z.string().optional(),
};

export async function updateChangeset(
  args: z.infer<z.ZodObject<typeof UpdateChangesetShape>>
): Promise<ChangesetRow> {
  const { changeset_id, ...fields } = args;
  const sysId = await resolveChangesetSysId(changeset_id);
  return updateRecord<ChangesetRow>("sys_update_set", sysId, fields, WRITE_OPTS);
}

export const CommitChangesetShape = {
  changeset_id: z.string().describe("sys_id or name of the changeset"),
  commit_message: z.string().optional(),
};

export async function commitChangeset(
  args: z.infer<z.ZodObject<typeof CommitChangesetShape>>
): Promise<ChangesetRow> {
  const sysId = await resolveChangesetSysId(args.changeset_id);
  return updateRecord<ChangesetRow>(
    "sys_update_set",
    sysId,
    { state: "complete", ...(args.commit_message ? { description: args.commit_message } : {}) },
    WRITE_OPTS
  );
}

export const PublishChangesetShape = {
  changeset_id: z.string().describe("sys_id or name of the changeset"),
  publish_notes: z.string().optional(),
};

// NOTE: the reference project sets state="published", but this table's actual choice list is
// instance-specific — on this PDI, sys_update_set.state only has in progress/complete/ignore, no
// "published" value (confirmed via sys_choice). Verified empirically: this does NOT throw on this
// PDI — the PATCH returns 200 but the invalid choice value is silently rejected at the field level,
// leaving state unchanged. Callers must check the returned state, not just the absence of an
// error. Ported as-is to match the reference; verify "published" is a valid choice before relying
// on this on any given instance.
export async function publishChangeset(
  args: z.infer<z.ZodObject<typeof PublishChangesetShape>>
): Promise<ChangesetRow> {
  const sysId = await resolveChangesetSysId(args.changeset_id);
  return updateRecord<ChangesetRow>(
    "sys_update_set",
    sysId,
    { state: "published", ...(args.publish_notes ? { description: args.publish_notes } : {}) },
    WRITE_OPTS
  );
}

export const AddFileToChangesetShape = {
  changeset_id: z.string().describe("sys_id or name of the changeset"),
  file_path: z.string(),
  file_content: z.string(),
};

// KNOWN GAP, confirmed empirically on this PDI: direct inserts into sys_update_xml are blocked by
// an ACL ("Insert Failed due to security constraints") even for an admin-scoped account — this
// table normally holds system-generated customization diffs, not hand-authored content, and isn't
// meant to be written directly via the Table API. Not a porting bug; the reference project's
// identical approach would hit the same ACL on any instance with default security. Left
// implemented as a faithful port.
export async function addFileToChangeset(
  args: z.infer<z.ZodObject<typeof AddFileToChangesetShape>>
): Promise<UpdateXmlRow> {
  const sysId = await resolveChangesetSysId(args.changeset_id);
  return createRecord<UpdateXmlRow>(
    "sys_update_xml",
    { update_set: sysId, name: args.file_path, payload: args.file_content, type: "file" },
    WRITE_OPTS
  );
}

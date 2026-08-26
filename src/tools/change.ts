import { z } from "zod";
import { createRecord, updateRecord, getRecord, queryTable } from "../servicenow-client.js";
import { buildTimeframeQuery } from "./shared.js";

// assignment_group/requested_by/category are reference or choice fields — written as display
// values (group name, username, choice label like "Assess"/"Implement"/"Canceled" for `state`),
// not raw sys_ids/codes, per the port design notes (bucket B). Confirmed on this PDI that
// change_request.state is numeric (Assess=-4, Implement=-1, Canceled=4, ...), NOT the lowercase
// string literals ("assess"/"implement"/"canceled") the reference project hardcodes — this is the
// same choice-field trap already hit once on incident.ts's resolution_code. Passing the label text
// here instead of guessing a raw code is a deliberate improvement, verified working this batch.
const WRITE_OPTS = { sysparm_input_display_value: true };

export interface ChangeRequestRow {
  sys_id: string;
  number: string;
  short_description: string;
  description?: string;
  type?: string;
  risk?: string;
  impact?: string;
  category?: string;
  assignment_group?: string;
  requested_by?: string;
  state?: string;
  start_date?: string;
  end_date?: string;
}

const CHANGE_FIELDS =
  "sys_id,number,short_description,description,type,risk,impact,category," +
  "assignment_group,requested_by,state,start_date,end_date,sys_created_on";

async function resolveChangeSysId(changeId: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(changeId)) return changeId;
  const rows = await queryTable<{ sys_id: string }>("change_request", {
    sysparm_query: `number=${changeId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No change request found with number "${changeId}"`);
  return rows[0].sys_id;
}

export const CreateChangeRequestShape = {
  short_description: z.string(),
  description: z.string().optional(),
  type: z.string().describe("normal, standard, emergency, or model"),
  risk: z.string().optional(),
  impact: z.string().optional(),
  category: z.string().optional(),
  requested_by: z.string().optional().describe("Username, email, or sys_id"),
  assignment_group: z.string().optional().describe("Group name or sys_id"),
  start_date: z.string().optional().describe("YYYY-MM-DD HH:MM:SS"),
  end_date: z.string().optional().describe("YYYY-MM-DD HH:MM:SS"),
};

export async function createChangeRequest(
  args: z.infer<z.ZodObject<typeof CreateChangeRequestShape>>
): Promise<ChangeRequestRow> {
  return createRecord<ChangeRequestRow>("change_request", args, WRITE_OPTS);
}

export const UpdateChangeRequestShape = {
  change_id: z.string().describe("sys_id or change number (e.g. CHG0010001)"),
  short_description: z.string().optional(),
  description: z.string().optional(),
  state: z.string().optional().describe("Choice label, e.g. Assess, Authorize, Scheduled, Implement, Review, Closed, Canceled"),
  risk: z.string().optional(),
  impact: z.string().optional(),
  category: z.string().optional(),
  assignment_group: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  work_notes: z.string().optional(),
};

export async function updateChangeRequest(
  args: z.infer<z.ZodObject<typeof UpdateChangeRequestShape>>
): Promise<ChangeRequestRow> {
  const { change_id, ...fields } = args;
  const sysId = await resolveChangeSysId(change_id);
  return updateRecord<ChangeRequestRow>("change_request", sysId, fields, WRITE_OPTS);
}

export const ListChangeRequestsShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  state: z.string().optional(),
  type: z.string().optional(),
  category: z.string().optional(),
  assignment_group: z.string().optional(),
  timeframe: z.enum(["upcoming", "in-progress", "completed"]).optional(),
  query: z.string().optional().describe("Additional raw encoded query, ANDed with the filters above"),
};

// list_* tools are caller-paginated (limit/offset = one bounded page), like incident.ts/user.ts —
// a plain queryTable call, not queryTableAll.
export async function listChangeRequests(
  args: z.infer<z.ZodObject<typeof ListChangeRequestsShape>>
): Promise<ChangeRequestRow[]> {
  const parts: string[] = [];
  if (args.state) parts.push(`state=${args.state}`);
  if (args.type) parts.push(`type=${args.type}`);
  if (args.category) parts.push(`category=${args.category}`);
  if (args.assignment_group) parts.push(`assignment_group=${args.assignment_group}`);
  if (args.timeframe) parts.push(buildTimeframeQuery(args.timeframe, "start_date", "end_date"));
  if (args.query) parts.push(args.query);

  return queryTable<ChangeRequestRow>("change_request", {
    sysparm_query: parts.join("^"),
    sysparm_fields: CHANGE_FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

export const GetChangeRequestDetailsShape = {
  change_id: z.string().describe("sys_id or change number"),
};

interface ChangeTaskRow {
  sys_id: string;
  number?: string;
  short_description?: string;
  state?: string;
  assigned_to?: string;
}

export async function getChangeRequestDetails(
  args: z.infer<z.ZodObject<typeof GetChangeRequestDetailsShape>>
): Promise<ChangeRequestRow & { tasks: ChangeTaskRow[] }> {
  const sysId = await resolveChangeSysId(args.change_id);
  const changeRequest = await getRecord<ChangeRequestRow>("change_request", sysId, {
    sysparm_fields: CHANGE_FIELDS,
    sysparm_display_value: true,
  });
  // Filtered on the resolved sys_id, not the caller's raw change_id — the reference project
  // queries change_task with the caller's raw input directly, which silently returns nothing if
  // a change number (not a sys_id) was passed, since change_task.change_request is a reference
  // field. Resolving first is a deliberate fix, verified working this batch.
  const tasks = await queryTable<ChangeTaskRow>("change_task", {
    sysparm_query: `change_request=${sysId}`,
    sysparm_display_value: true,
  });
  return { ...changeRequest, tasks };
}

export const AddChangeTaskShape = {
  change_id: z.string().describe("sys_id or change number"),
  short_description: z.string(),
  description: z.string().optional(),
  assigned_to: z.string().optional().describe("Username, email, or sys_id"),
  planned_start_date: z.string().optional().describe("YYYY-MM-DD HH:MM:SS"),
  planned_end_date: z.string().optional().describe("YYYY-MM-DD HH:MM:SS"),
};

export async function addChangeTask(
  args: z.infer<z.ZodObject<typeof AddChangeTaskShape>>
): Promise<ChangeTaskRow> {
  const { change_id, ...rest } = args;
  const sysId = await resolveChangeSysId(change_id);
  return createRecord<ChangeTaskRow>(
    "change_task",
    { ...rest, change_request: sysId },
    WRITE_OPTS
  );
}

export const SubmitChangeForApprovalShape = {
  change_id: z.string().describe("sys_id or change number"),
  approval_comments: z.string().optional(),
};

interface ApprovalRow {
  sys_id: string;
  state?: string;
}

// KNOWN GAP, confirmed empirically on this PDI (not a porting bug — the reference project's
// identical direct-Table-API approach hits the same platform-level walls on any modern instance):
// 1. change_request.state transitions are frequently governed by a "Change Model" business rule
//    ("Change Model: Check State Transition") that 403s a direct field write outside the model's
//    defined transition graph, even for an admin-scoped account.
// 2. sysapproval_approver.document_id did not persist via direct POST/PATCH on this PDI — the
//    write returns 200 but the field stays blank, with no error. Approval records are normally
//    generated by ServiceNow's own Approval Engine, not hand-inserted; direct creation may simply
//    not be supported. findApprovalRecord will then legitimately find nothing.
// Left implemented as a faithful port (plus the state-label fix noted above) since these are
// instance/version-dependent platform behaviors, not something this project can code around.
export async function submitChangeForApproval(
  args: z.infer<z.ZodObject<typeof SubmitChangeForApprovalShape>>
): Promise<{ change_request: ChangeRequestRow; approval: ApprovalRow }> {
  const sysId = await resolveChangeSysId(args.change_id);
  const changeRequest = await updateRecord<ChangeRequestRow>(
    "change_request",
    sysId,
    { state: "Assess", ...(args.approval_comments ? { work_notes: args.approval_comments } : {}) },
    WRITE_OPTS
  );
  // sysapproval_approver.state's stored values are already the lowercase literals used here
  // ("requested"/"approved"/"rejected") — confirmed via sys_choice, no display-value translation
  // needed for this table specifically, unlike change_request.state above.
  const approval = await createRecord<ApprovalRow>("sysapproval_approver", {
    document_id: sysId,
    source_table: "change_request",
    state: "requested",
  });
  return { change_request: changeRequest, approval };
}

async function findApprovalRecord(changeSysId: string, approverId?: string): Promise<ApprovalRow> {
  const parts = [`document_id=${changeSysId}`];
  // Improvement over the reference project: it accepts an approver_id param on both
  // approve_change and reject_change but never actually uses it in the query, so it's a no-op
  // there — always operating on whichever approval record sorts first. Filtering on it when
  // provided is a deliberate fix so a specific approver's record can be targeted when a change
  // has multiple approvers.
  if (approverId) parts.push(`approver=${approverId}`);

  const rows = await queryTable<ApprovalRow>("sysapproval_approver", {
    sysparm_query: parts.join("^"),
    sysparm_fields: "sys_id,state",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error("No approval record found for this change request");
  return rows[0];
}

export const ApproveChangeShape = {
  change_id: z.string().describe("sys_id or change number"),
  approver_id: z.string().optional().describe("Username, email, or sys_id of the approver"),
  approval_comments: z.string().optional(),
};

export async function approveChange(
  args: z.infer<z.ZodObject<typeof ApproveChangeShape>>
): Promise<{ change_request: ChangeRequestRow; approval: ApprovalRow }> {
  const sysId = await resolveChangeSysId(args.change_id);
  const approval = await findApprovalRecord(sysId, args.approver_id);

  const updatedApproval = await updateRecord<ApprovalRow>("sysapproval_approver", approval.sys_id, {
    state: "approved",
    ...(args.approval_comments ? { comments: args.approval_comments } : {}),
  });
  const changeRequest = await updateRecord<ChangeRequestRow>(
    "change_request",
    sysId,
    { state: "Implement" },
    WRITE_OPTS
  );
  return { change_request: changeRequest, approval: updatedApproval };
}

export const RejectChangeShape = {
  change_id: z.string().describe("sys_id or change number"),
  approver_id: z.string().optional().describe("Username, email, or sys_id of the approver"),
  rejection_reason: z.string(),
};

export async function rejectChange(
  args: z.infer<z.ZodObject<typeof RejectChangeShape>>
): Promise<{ change_request: ChangeRequestRow; approval: ApprovalRow }> {
  const sysId = await resolveChangeSysId(args.change_id);
  const approval = await findApprovalRecord(sysId, args.approver_id);

  const updatedApproval = await updateRecord<ApprovalRow>("sysapproval_approver", approval.sys_id, {
    state: "rejected",
    comments: args.rejection_reason,
  });
  const changeRequest = await updateRecord<ChangeRequestRow>(
    "change_request",
    sysId,
    { state: "Canceled", work_notes: `Change request rejected: ${args.rejection_reason}` },
    WRITE_OPTS
  );
  return { change_request: changeRequest, approval: updatedApproval };
}

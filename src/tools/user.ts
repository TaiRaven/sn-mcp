import { z } from "zod";
import { createRecord, updateRecord, queryTable, deleteRecord } from "../servicenow-client.js";
import { resolveUserSysId, resolveGroupSysId, assignRoleToUser } from "./shared.js";

// manager/department/location/parent are reference fields — written as display values
// (username/department name/location name/group name), not raw sys_ids, per the port design
// notes (bucket B). Verified working during this batch.
const WRITE_OPTS = { sysparm_input_display_value: true };

const HEX32 = /^[0-9a-f]{32}$/i;

/** user_id/group_id params (singular "act on this one record") accept a raw sys_id directly,
 *  same convention as incident.ts's resolveIncidentSysId — distinct from the members[] arrays
 *  below, which use the reference project's explicit "sys_id:" prefix convention instead. */
async function resolveUserIdParam(id: string): Promise<string> {
  if (HEX32.test(id)) return id;
  return resolveUserSysId(id);
}

async function resolveGroupIdParam(id: string): Promise<string> {
  if (HEX32.test(id)) return id;
  return resolveGroupSysId(id);
}

export interface UserRow {
  sys_id: string;
  user_name: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  title?: string;
  department?: string;
  manager?: string;
  phone?: string;
  mobile_phone?: string;
  location?: string;
  active?: string;
}

const USER_FIELDS =
  "sys_id,user_name,first_name,last_name,email,title,department,manager,phone,mobile_phone,location,active";

export const CreateUserShape = {
  user_name: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  title: z.string().optional(),
  department: z.string().optional().describe("Department name or sys_id"),
  manager: z.string().optional().describe("Username or sys_id of the user's manager"),
  roles: z.array(z.string()).optional().describe("Role names to assign after creation"),
  phone: z.string().optional(),
  mobile_phone: z.string().optional(),
  location: z.string().optional(),
  password: z.string().optional(),
  active: z.boolean().optional().default(true),
};

export async function createUser(
  args: z.infer<z.ZodObject<typeof CreateUserShape>>
): Promise<UserRow> {
  const { roles, password, active, ...rest } = args;
  const body: Record<string, unknown> = { ...rest, active: String(active) };
  if (password) body.user_password = password;

  const user = await createRecord<UserRow>("sys_user", body, WRITE_OPTS);
  if (roles) {
    for (const role of roles) await assignRoleToUser(user.sys_id, role);
  }
  return user;
}

export const UpdateUserShape = {
  user_id: z.string().describe("sys_id, username, or email of the user to update"),
  user_name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional(),
  title: z.string().optional(),
  department: z.string().optional(),
  manager: z.string().optional(),
  roles: z.array(z.string()).optional().describe("Role names to assign (additive, not a replace-all)"),
  phone: z.string().optional(),
  mobile_phone: z.string().optional(),
  location: z.string().optional(),
  password: z.string().optional(),
  active: z.boolean().optional(),
};

export async function updateUser(
  args: z.infer<z.ZodObject<typeof UpdateUserShape>>
): Promise<UserRow> {
  const { user_id, roles, password, active, ...rest } = args;
  const sysId = await resolveUserIdParam(user_id);

  const body: Record<string, unknown> = { ...rest };
  if (password) body.user_password = password;
  if (active !== undefined) body.active = String(active);

  const user = await updateRecord<UserRow>("sys_user", sysId, body, WRITE_OPTS);
  if (roles) {
    for (const role of roles) await assignRoleToUser(sysId, role);
  }
  return user;
}

export const GetUserShape = {
  user_id: z.string().optional().describe("sys_id"),
  user_name: z.string().optional(),
  email: z.string().optional(),
};

export async function getUser(
  args: z.infer<z.ZodObject<typeof GetUserShape>>
): Promise<UserRow> {
  let query: string;
  if (args.user_id) query = `sys_id=${args.user_id}`;
  else if (args.user_name) query = `user_name=${args.user_name}`;
  else if (args.email) query = `email=${args.email}`;
  else throw new Error("At least one of user_id, user_name, or email is required");

  const rows = await queryTable<UserRow>("sys_user", {
    sysparm_query: query,
    sysparm_fields: USER_FIELDS,
    sysparm_limit: 1,
    sysparm_display_value: true,
  });
  if (rows.length === 0) throw new Error("No user found matching the given criteria");
  return rows[0];
}

export const ListUsersShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  active: z.boolean().optional(),
  department: z.string().optional(),
  query: z
    .string()
    .optional()
    .describe("Case-insensitive search matched against name, username, or email"),
};

// list_* tools are caller-paginated (limit/offset = one bounded page), like incident.ts —
// a plain queryTable call, not queryTableAll.
export async function listUsers(
  args: z.infer<z.ZodObject<typeof ListUsersShape>>
): Promise<UserRow[]> {
  const parts: string[] = [];
  if (args.active !== undefined) parts.push(`active=${args.active}`);
  if (args.department) parts.push(`department=${args.department}`);
  if (args.query) parts.push(`nameLIKE${args.query}^ORuser_nameLIKE${args.query}^ORemailLIKE${args.query}`);

  return queryTable<UserRow>("sys_user", {
    sysparm_query: parts.join("^"),
    sysparm_fields: USER_FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

export interface GroupRow {
  sys_id: string;
  name: string;
  description?: string;
  manager?: string;
  parent?: string;
  type?: string;
  email?: string;
  active?: string;
}

const GROUP_FIELDS = "sys_id,name,description,manager,parent,type,email,active";

interface GrMemberRow {
  sys_id: string;
}

/** Adds members to a group, skipping any that are already members — same duplicate-check
 *  precedent as assignRoleToUser in shared.ts (redundant grants are a real failure mode on
 *  some instances). Members may be usernames, emails, or "sys_id:<id>"-prefixed sys_ids,
 *  resolved via resolveUserSysId (matches the reference project's exact convention). */
async function addMembersToGroup(groupSysId: string, members: string[]): Promise<void> {
  for (const member of members) {
    const userSysId = await resolveUserSysId(member);
    const existing = await queryTable<GrMemberRow>("sys_user_grmember", {
      sysparm_query: `group=${groupSysId}^user=${userSysId}`,
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    });
    if (existing.length > 0) continue;
    await createRecord("sys_user_grmember", { group: groupSysId, user: userSysId });
  }
}

async function removeMembersFromGroup(groupSysId: string, members: string[]): Promise<void> {
  for (const member of members) {
    const userSysId = await resolveUserSysId(member);
    const existing = await queryTable<GrMemberRow>("sys_user_grmember", {
      sysparm_query: `group=${groupSysId}^user=${userSysId}`,
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    });
    if (existing.length === 0) throw new Error(`"${member}" is not a member of this group`);
    await deleteRecord("sys_user_grmember", existing[0].sys_id);
  }
}

export const CreateGroupShape = {
  name: z.string(),
  description: z.string().optional(),
  manager: z.string().optional().describe("Username or sys_id of the group manager"),
  parent: z.string().optional().describe("Parent group name or sys_id"),
  type: z.string().optional(),
  email: z.string().optional(),
  members: z
    .array(z.string())
    .optional()
    .describe("Usernames, emails, or sys_id:<id>-prefixed sys_ids to add as members"),
  active: z.boolean().optional().default(true),
};

export async function createGroup(
  args: z.infer<z.ZodObject<typeof CreateGroupShape>>
): Promise<GroupRow> {
  const { members, active, ...rest } = args;
  const group = await createRecord<GroupRow>(
    "sys_user_group",
    { ...rest, active: String(active) },
    WRITE_OPTS
  );
  if (members && members.length > 0) await addMembersToGroup(group.sys_id, members);
  return group;
}

export const UpdateGroupShape = {
  group_id: z.string().describe("Group sys_id or name to update"),
  name: z.string().optional(),
  description: z.string().optional(),
  manager: z.string().optional(),
  parent: z.string().optional(),
  type: z.string().optional(),
  email: z.string().optional(),
  active: z.boolean().optional(),
};

export async function updateGroup(
  args: z.infer<z.ZodObject<typeof UpdateGroupShape>>
): Promise<GroupRow> {
  const { group_id, active, ...rest } = args;
  const sysId = await resolveGroupIdParam(group_id);
  const body: Record<string, unknown> = { ...rest };
  if (active !== undefined) body.active = String(active);
  return updateRecord<GroupRow>("sys_user_group", sysId, body, WRITE_OPTS);
}

export const AddGroupMembersShape = {
  group_id: z.string().describe("Group name or sys_id"),
  members: z.array(z.string()).describe("Usernames, emails, or sys_id:<id>-prefixed sys_ids"),
};

export async function addGroupMembers(
  args: z.infer<z.ZodObject<typeof AddGroupMembersShape>>
): Promise<{ group_id: string; added: number }> {
  const groupSysId = await resolveGroupIdParam(args.group_id);
  await addMembersToGroup(groupSysId, args.members);
  return { group_id: groupSysId, added: args.members.length };
}

export const RemoveGroupMembersShape = {
  group_id: z.string().describe("Group name or sys_id"),
  members: z.array(z.string()).describe("Usernames, emails, or sys_id:<id>-prefixed sys_ids"),
};

export async function removeGroupMembers(
  args: z.infer<z.ZodObject<typeof RemoveGroupMembersShape>>
): Promise<{ group_id: string; removed: number }> {
  const groupSysId = await resolveGroupIdParam(args.group_id);
  await removeMembersFromGroup(groupSysId, args.members);
  return { group_id: groupSysId, removed: args.members.length };
}

export const ListGroupsShape = {
  limit: z.number().optional().default(10),
  offset: z.number().optional().default(0),
  active: z.boolean().optional(),
  query: z
    .string()
    .optional()
    .describe("Case-insensitive search matched against group name or description"),
  type: z.string().optional(),
};

export async function listGroups(
  args: z.infer<z.ZodObject<typeof ListGroupsShape>>
): Promise<GroupRow[]> {
  const parts: string[] = [];
  if (args.active !== undefined) parts.push(`active=${args.active}`);
  if (args.type) parts.push(`type=${args.type}`);
  if (args.query) parts.push(`nameLIKE${args.query}^ORdescriptionLIKE${args.query}`);

  return queryTable<GroupRow>("sys_user_group", {
    sysparm_query: parts.join("^"),
    sysparm_fields: GROUP_FIELDS,
    sysparm_limit: args.limit,
    sysparm_offset: args.offset,
    sysparm_display_value: true,
  });
}

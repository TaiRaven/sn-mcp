import { queryTable, createRecord } from "../servicenow-client.js";

interface SysUserRow {
  sys_id: string;
}

/**
 * Resolves a user identifier the way the reference project does: a literal `sys_id:<id>` prefix
 * bypasses lookup entirely, otherwise try `user_name=`, then fall back to `email=`. Throws if
 * nothing matches — callers should let that propagate (MCP's built-in isError handling covers it).
 */
export async function resolveUserSysId(identifier: string): Promise<string> {
  if (identifier.startsWith("sys_id:")) return identifier.slice("sys_id:".length);

  const byUsername = await queryTable<SysUserRow>("sys_user", {
    sysparm_query: `user_name=${identifier}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (byUsername.length > 0) return byUsername[0].sys_id;

  const byEmail = await queryTable<SysUserRow>("sys_user", {
    sysparm_query: `email=${identifier}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (byEmail.length > 0) return byEmail[0].sys_id;

  throw new Error(`No sys_user found matching user_name or email "${identifier}"`);
}

interface SysUserRoleRow {
  sys_id: string;
}

export async function resolveRoleSysId(name: string): Promise<string> {
  const rows = await queryTable<SysUserRoleRow>("sys_user_role", {
    sysparm_query: `name=${name}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No sys_user_role found matching name "${name}"`);
  return rows[0].sys_id;
}

interface SysUserGroupRow {
  sys_id: string;
}

export async function resolveGroupSysId(identifier: string): Promise<string> {
  if (identifier.startsWith("sys_id:")) return identifier.slice("sys_id:".length);

  const rows = await queryTable<SysUserGroupRow>("sys_user_group", {
    sysparm_query: `name=${identifier}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (rows.length === 0) throw new Error(`No sys_user_group found matching name "${identifier}"`);
  return rows[0].sys_id;
}

interface UserHasRoleRow {
  sys_id: string;
}

/**
 * Assigns a role to a user via sys_user_has_role, skipping the insert if the grant already
 * exists — mirrors the reference project's duplicate check (avoids a real failure mode: most
 * instances reject/duplicate on a redundant grant).
 */
export async function assignRoleToUser(userSysId: string, roleName: string): Promise<void> {
  const roleSysId = await resolveRoleSysId(roleName);

  const existing = await queryTable<UserHasRoleRow>("sys_user_has_role", {
    sysparm_query: `user=${userSysId}^role=${roleSysId}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  if (existing.length > 0) return;

  await createRecord("sys_user_has_role", { user: userSysId, role: roleSysId });
}

export type Timeframe = "upcoming" | "in-progress" | "completed";

/** UTC "YYYY-MM-DD HH:mm:ss", matching the raw (non-display-value) format sys_created_on etc. come
 *  back as over the Table API. */
function nowLiteral(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Shared across change/story/epic/scrum-task/project — identical timeframe filter logic in the
 * reference project, repeated per-domain there. The reference builds this with
 * `javascript:gs.now()`; we deliberately don't — this project already hit a real bug (see
 * tools/syslog.ts) where a `javascript:gs.*` date function evaluated in the instance's configured
 * timezone while the compared field came back as raw UTC, silently shifting results. A plain
 * literal UTC timestamp compares directly against the raw stored value with no such risk.
 */
export function buildTimeframeQuery(
  timeframe: Timeframe,
  startField = "start_date",
  endField = "end_date"
): string {
  const now = nowLiteral();
  switch (timeframe) {
    case "upcoming":
      return `${startField}>${now}`;
    case "in-progress":
      return `${startField}<${now}^${endField}>${now}`;
    case "completed":
      return `${endField}<${now}`;
  }
}

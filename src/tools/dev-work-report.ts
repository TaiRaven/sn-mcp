import { queryTableAll } from "../servicenow-client.js";

interface UpdateXmlRow {
  sys_created_by: string;
  sys_created_on: string;
  name: string;
  type: string;
  "update_set.name": string;
  "update_set.is_default": string;
}

export interface UpdateSetGroup {
  author: string;
  updateSet: string;
  isDefaultUpdateSet: boolean;
  changeCount: number;
  changes: { name: string; type: string; created: string }[];
}

export interface DeveloperWorkReportResult {
  groups: UpdateSetGroup[];
  /** True if the report hit the pagination safety cap — groups is built from a partial result. */
  truncated: boolean;
}

export async function getDeveloperWorkReport(
  startDate: string,
  endDate: string
): Promise<DeveloperWorkReportResult> {
  // Plain literal datetimes, not javascript:gs.dateGenerate(...) — see the note in tools/syslog.ts for why:
  // gs.dateGenerate() evaluates in the instance timezone while sys_created_on comes back as raw UTC,
  // silently shifting the window by the instance's UTC offset.
  const query =
    `sys_created_onBETWEEN${startDate} 00:00:00` +
    `@${endDate} 23:59:59` +
    `^ORDERBYsys_created_on`;

  const { rows, truncated } = await queryTableAll<UpdateXmlRow>("sys_update_xml", {
    sysparm_query: query,
    sysparm_fields:
      "sys_created_by,sys_created_on,name,type,update_set.name,update_set.is_default",
    sysparm_display_value: true,
  });

  const grouped = new Map<string, UpdateSetGroup>();
  for (const row of rows) {
    const author = row.sys_created_by;
    const updateSet = row["update_set.name"] || "(unknown update set)";
    const isDefaultUpdateSet = row["update_set.is_default"] === "true";
    const key = `${author}::${updateSet}`;

    let group = grouped.get(key);
    if (!group) {
      group = { author, updateSet, isDefaultUpdateSet, changeCount: 0, changes: [] };
      grouped.set(key, group);
    }
    group.changeCount++;
    group.changes.push({ name: row.name, type: row.type, created: row.sys_created_on });
  }

  return { groups: [...grouped.values()], truncated };
}

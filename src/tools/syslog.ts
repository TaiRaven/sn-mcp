import { queryTableAll } from "../servicenow-client.js";

// syslog.level is numeric on this instance (confirmed via sys_choice for name=syslog^element=level):
// -2=Trace, -1=Debug, 0=Information, 1=Warning, 2=Error, 3=Fatal
const LEVEL_CODES: Record<string, string> = {
  trace: "-2",
  debug: "-1",
  information: "0",
  info: "0",
  warning: "1",
  error: "2",
  fatal: "3",
};

const DEFAULT_LEVELS = ["warning", "error"];

export interface SyslogRow {
  sys_created_on: string;
  message: string;
  source: string;
  level: string;
  node: string;
}

function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface SyslogReportResult {
  rows: SyslogRow[];
  /** True if the report hit the pagination safety cap — rows is a partial result, not the full day. */
  truncated: boolean;
}

export async function getSyslogReport(date?: string, levels?: string[]): Promise<SyslogReportResult> {
  const targetDate = date ?? yesterdayIso();
  const requestedLevels = levels && levels.length > 0 ? levels : DEFAULT_LEVELS;
  const levelList = requestedLevels
    .map((l) => LEVEL_CODES[l.toLowerCase()] ?? l)
    .join(",");

  // Plain literal datetimes, not javascript:gs.dateGenerate(...). gs.dateGenerate() evaluates in the
  // instance's configured timezone, but sys_created_on comes back as a raw UTC value over the Table API
  // (no sysparm_display_value) — that mismatch silently shifted the query window by the instance's UTC
  // offset (confirmed ~7h on this PDI), pulling in the wrong day's data. A literal string is compared
  // directly against the raw stored value with no timezone conversion, which is what we want here.
  const query =
    `sys_created_onBETWEEN${targetDate} 00:00:00` +
    `@${targetDate} 23:59:59` +
    `^levelIN${levelList}^ORDERBYsys_created_on`;

  return queryTableAll<SyslogRow>("syslog", {
    sysparm_query: query,
    sysparm_fields: "sys_created_on,message,source,level,node",
  });
}

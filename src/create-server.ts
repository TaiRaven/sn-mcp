import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, jsonResult } from "./register-tool.js";
import { getSyslogReport } from "./tools/syslog.js";
import { getDeveloperWorkReport } from "./tools/dev-work-report.js";
import {
  CreateIncidentShape,
  createIncident,
  UpdateIncidentShape,
  updateIncident,
  AddCommentShape,
  addComment,
  ResolveIncidentShape,
  resolveIncident,
  ListIncidentsShape,
  listIncidents,
  GetIncidentByNumberShape,
  getIncidentByNumber,
} from "./tools/incident.js";

// Shared by both entrypoints (stdio in index.ts, HTTP in http.ts) — HTTP needs a fresh
// server instance per session, so this can't just be a module-level singleton.
export function createReportsServer(): McpServer {
  const server = new McpServer({
    name: "servicenow-reports",
    version: "1.0.0",
  });

  // --- syslog / dev-work reports ---

  server.tool(
    "get_syslog_report",
    "Fetch sys_log rows (warnings/errors by default) for a given date, defaulting to yesterday. " +
      "Returns raw rows only — the caller (Claude) does the 'suggested fixes' analysis in conversation.",
    {
      date: z
        .string()
        .optional()
        .describe("Date in YYYY-MM-DD format. Defaults to yesterday."),
      levels: z
        .array(z.string())
        .optional()
        .describe(
          "sys_log level values to filter on, e.g. ['warning','error']. Defaults to ['warning','error'] — " +
            "verify these match this instance's actual level choice values if the report comes back empty unexpectedly."
        ),
    },
    async ({ date, levels }) => jsonResult(await getSyslogReport(date, levels))
  );

  server.tool(
    "get_developer_work_report",
    "Fetch developer work (sys_update_xml changes) between two dates, grouped by author and update set. " +
      "Returns structured rows only — the caller (Claude) flags concerns narratively (e.g. changes in the " +
      "Default update set, unnamed sets, unusually large sets, off-hours activity).",
    {
      start_date: z.string().describe("Start date, YYYY-MM-DD"),
      end_date: z.string().describe("End date, YYYY-MM-DD"),
    },
    async ({ start_date, end_date }) => jsonResult(await getDeveloperWorkReport(start_date, end_date))
  );

  // --- incident_tools ---

  registerTool(
    server,
    "create_incident",
    "Create a new incident.",
    CreateIncidentShape,
    createIncident
  );
  registerTool(
    server,
    "update_incident",
    "Update an existing incident (accepts sys_id or incident number).",
    UpdateIncidentShape,
    updateIncident
  );
  registerTool(
    server,
    "add_comment",
    "Add a comment or work note to an incident.",
    AddCommentShape,
    addComment
  );
  registerTool(
    server,
    "resolve_incident",
    "Resolve an incident (sets state to Resolved with a resolution code and notes).",
    ResolveIncidentShape,
    resolveIncident
  );
  registerTool(
    server,
    "list_incidents",
    "List incidents, most recent first. limit/offset paginate — this returns one bounded page, not the full table.",
    ListIncidentsShape,
    listIncidents
  );
  registerTool(
    server,
    "get_incident_by_number",
    "Fetch a single incident by its number (e.g. INC0010001).",
    GetIncidentByNumberShape,
    getIncidentByNumber
  );

  return server;
}

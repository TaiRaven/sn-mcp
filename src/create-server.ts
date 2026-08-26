import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSyslogReport } from "./tools/syslog.js";
import { getDeveloperWorkReport } from "./tools/dev-work-report.js";

// Shared by both entrypoints (stdio in index.ts, HTTP in http.ts) — HTTP needs a fresh
// server instance per session, so this can't just be a module-level singleton.
export function createReportsServer(): McpServer {
  const server = new McpServer({
    name: "servicenow-reports",
    version: "1.0.0",
  });

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
    async ({ date, levels }) => {
      const { rows, truncated } = await getSyslogReport(date, levels);
      const content: { type: "text"; text: string }[] = [];
      if (truncated) {
        content.push({
          type: "text",
          text:
            `⚠ Truncated: hit the pagination safety cap (${rows.length} rows) before the query was ` +
            "exhausted. This report is incomplete — narrow the date range or levels, or raise the cap in " +
            "queryTableAll if a wider report is genuinely needed.",
        });
      }
      content.push({ type: "text", text: JSON.stringify(rows, null, 2) });
      return { content };
    }
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
    async ({ start_date, end_date }) => {
      const { groups, truncated } = await getDeveloperWorkReport(start_date, end_date);
      const content: { type: "text"; text: string }[] = [];
      if (truncated) {
        content.push({
          type: "text",
          text:
            "⚠ Truncated: hit the pagination safety cap before the query was exhausted. Grouping was " +
            "computed from a partial result — narrow the date range, or raise the cap in queryTableAll if " +
            "a wider report is genuinely needed.",
        });
      }
      content.push({ type: "text", text: JSON.stringify(groups, null, 2) });
      return { content };
    }
  );

  return server;
}

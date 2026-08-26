# ServiceNow MCP Reports

Local MCP server exposing two on-demand ServiceNow reports, built from the plan in
[[ServiceNow MCP Server — Syslog & Dev Work Reports (Plan)]]. Setup narrative and troubleshooting also
live in the vault: [[ServiceNow MCP Server — Syslog & Dev Work Reports (Setup Guide)]].

For ideas on extending this beyond the two current tools, see
[echelon-ai-labs/servicenow-mcp](https://github.com/echelon-ai-labs/servicenow-mcp) — a much larger
Python/FastMCP ServiceNow server (incidents, changes, catalog, knowledge base, script includes, Agile
tools). Already borrowed from it: a remote-reachable HTTP transport alongside stdio (step 7) — that repo
exposes both stdio and SSE; and its date-range filters use ServiceNow's own relative-date keywords
(`ONLast week@javascript:gs.beginningOfLastWeek()@javascript:gs.endOfLastWeek()`) rather than constructing
literal datetimes by hand — comparing that pattern against this project's own query is what surfaced the
timezone bug fixed in step 4/Troubleshooting below. Not yet borrowed: its `AuthManager`, which supports
Basic/OAuth/API-key behind one interface (this project is Basic-only).

- `get_syslog_report(date?, levels?)` — `syslog` table warnings/errors for a given day (defaults to yesterday).
- `get_developer_work_report(start_date, end_date)` — `sys_update_xml` changes grouped by author and update set.

Both tools return raw/grouped rows only — analysis (suggested fixes, flagged concerns) happens in
conversation with Claude, not inside the tool.

Both paginate automatically (`queryTableAll` in `servicenow-client.ts`, 1000 rows/page, 10,000-row safety
cap) instead of the original hardcoded `sysparm_limit: 1000`, which would have silently truncated any day
with more than 1000 matching rows. If a query hits the 10k cap, the tool response leads with an explicit
`⚠ Truncated` text block before the JSON — narrow the date range/levels, or raise `maxRows` in
`queryTableAll` if a genuinely wider report is needed. Added 2026-08-26; this PDI has never come close to
1000 rows/day, so the multi-page loop itself was verified directly against `queryTableAll` with a forced
small page size rather than by tripping it through real report volume.

## 1. Provision a read-only ServiceNow service account (manual, one-time)

Do this in the PDI (`https://dev203275.service-now.com`), logged in as an admin:

1. **User Administration → Users → New**
   - User ID: `claude_mcp_readonly`
   - Set a password, uncheck **"Password needs reset"**
   - Check **"Web service access only"** — **required**. Without it, ServiceNow's
     `SNCRestrictBasicAuthUserAuthenticationGate` blocks Basic Auth over REST for this account even with a
     correct password, because the account is also permitted interactive UI login. Symptom if missed: every
     REST call 401s with `"User is not authenticated"` while logging into the UI with the same credentials
     works fine. See Troubleshooting.
2. On that user record → **Roles** related list → **Edit** → add:
   - `rest_api_explorer` (REST API access)
   - Read access to `syslog` and `sys_update_xml`/`sys_update_set` — on a PDI, `snc_read_only` or the
     built-in `itil` role typically covers these; confirm the user can actually read those tables (see
     step 3 below) rather than assuming the role name.
   - **Do not** grant `admin` — this account should only ever query, per the original plan.
3. Copy `.env.example` to `.env` and fill in `SN_USER` / `SN_PASS` with this new account.

## 2. Build

```powershell
cd C:\Users\willr\projects\servicenow-mcp-reports
npm install
npm run build
```

## 3. Verify credentials before wiring into a client

```powershell
$env:SN_INSTANCE="https://dev203275.service-now.com"; $env:SN_USER="claude_mcp_readonly"; $env:SN_PASS="<password>"
node -e "fetch(process.env.SN_INSTANCE+'/api/now/table/sys_user?sysparm_limit=1',{headers:{Authorization:'Basic '+Buffer.from(process.env.SN_USER+':'+process.env.SN_PASS).toString('base64')}}).then(r=>console.log(r.status))"
```

Should print `200`. If `401`, check the password; if `403`, the role doesn't cover that table yet.

## 4. `syslog` table name, level values, and date filtering (resolved)

Confirmed against this instance on 2026-08-26:

- The table is **`syslog`**, not `sys_log` (`sys_log` returns `400 Invalid table sys_log`).
- `syslog.level` is **numeric**, not the strings `"warning"`/`"error"`:
  `-2=Trace, -1=Debug, 0=Information, 1=Warning, 2=Error, 3=Fatal`
  (confirmed via `GET /api/now/table/sys_choice?sysparm_query=name=syslog^element=level`).
- The date-range filter must use **plain literal datetimes** (`'<date> 00:00:00'@'<date> 23:59:59'`), not
  `javascript:gs.dateGenerate(...)` — see Troubleshooting for why the latter silently shifted results onto
  the wrong day.

`src/tools/syslog.ts` maps friendly level names (`"warning"`, `"error"`, etc.) to these codes internally, so
callers can keep passing names — this only matters if you extend the tool or point it at a different
instance, where the mapping should be re-verified with the same `sys_choice` query.

## 5. Register with Claude Code CLI

```powershell
claude mcp add --scope user servicenow-reports -- "C:\Program Files\nodejs\node.exe" C:\Users\willr\projects\servicenow-mcp-reports\dist\index.js
```

Use the absolute path to `node.exe`, not bare `node` — a Claude Code session started before Node was on
PATH won't be able to resolve a bare `node` command when spawning the server (`claude mcp list` will show
`CONNECTION_CLOSED`). Verify with `claude mcp list`.

Claude Code CLI reads `SN_INSTANCE`/`SN_USER`/`SN_PASS` from `.env` in this project folder — no extra env
config is needed on the CLI side as long as `.env` exists here. This relies on `src/index.ts` resolving
`.env`'s path relative to the compiled script itself (`import.meta.url`), **not** `process.cwd()` — plain
`import "dotenv/config"` would fail, because Claude Code spawns this server from an unrelated working
directory. See Troubleshooting if `.env` ever seems to stop loading.

## 6. Register with Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (created fresh — didn't exist on this machine):

```json
{
  "mcpServers": {
    "servicenow-reports": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\willr\\projects\\servicenow-mcp-reports\\dist\\index.js"],
      "env": {
        "SN_INSTANCE": "https://dev203275.service-now.com",
        "SN_USER": "claude_mcp_readonly",
        "SN_PASS": "<password>"
      }
    }
  }
}
```

Desktop launches the server as its own process without inheriting this project's `.env`, so credentials
are repeated here explicitly. Restart Claude Desktop after editing, then check the 🔌 connector icon to
confirm it connected.

## 7. Optional: remote-reachable HTTP transport

Steps 5–6 use stdio, which only works for a client that can spawn a local process (Claude Code, Claude
Desktop). A client that can't — e.g. claude.ai's hosted Scheduled Tasks — needs an HTTP endpoint instead.
`src/http.ts` exposes the same two tools over MCP's Streamable HTTP transport at `POST/GET /mcp`.

```powershell
npm run build
$env:MCP_HTTP_TOKEN="<pick something random>"; npm run start:http
```

Defaults: binds `127.0.0.1:3535` (override with `MCP_HTTP_HOST` / `MCP_HTTP_PORT` in `.env`). If
`MCP_HTTP_TOKEN` is set, every request must send `Authorization: Bearer <token>` or gets `401`; if unset,
the server logs a warning and accepts unauthenticated requests — fine while bound to localhost only, **not**
fine if this ever sits behind a public tunnel. `createMcpExpressApp()` (from the SDK) also enables DNS-rebinding
protection automatically whenever bound to a localhost host.

To actually reach this from claude.ai's hosted Scheduled Tasks, `127.0.0.1` isn't enough — it needs a
public URL (e.g. a tunnel: `ngrok http 3535`, or a real deployment). That's a separate step, not done here;
this just adds the capability. Smoke test locally first:

```powershell
curl.exe -s -X POST http://127.0.0.1:3535/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $env:MCP_HTTP_TOKEN" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoketest","version":"0.0.1"}}}'
```

Should return `200` with a `mcp-session-id` response header and a JSON-RPC `result` body.

## Troubleshooting

- **401 on every REST call despite a correct password, but logging into the ServiceNow UI with the same
  credentials works** — this is `SNCRestrictBasicAuthUserAuthenticationGate`: it blocks Basic Auth over
  REST for accounts that can also log in interactively. Fix: check **"Web service access only"** on the
  user record (step 1). Don't waste time resetting the password again — that pattern (UI login OK, REST
  401, `"User is not authenticated"` / `"Required to provide Auth information"`) is this gate, not a bad
  credential. Diagnosable directly from System Logs (`/syslog_list.do`, filter for the account name).
- **`Invalid table sys_log` (HTTP 400)** — the table is `syslog`, no underscore.
- **Report comes back empty even though logs exist for that day** — `level` is numeric on this instance
  (see step 4), not the strings `"warning"`/`"error"`. Re-check the mapping via the `sys_choice` query if
  pointing this at a different instance.
- **`Missing SN_INSTANCE, SN_USER, or SN_PASS environment variables"` when launched as a real MCP server,
  even though `.env` exists and a direct `node dist/index.js` test from this folder works fine** — that
  direct test succeeds because its `process.cwd()` happens to be the project folder; Claude Code launches
  the server from elsewhere, so plain `dotenv/config` fails silently. Confirm `src/index.ts` resolves `.env`
  via `import.meta.url`, not cwd (see step 5). Always verify with a real MCP tool call, not just a direct
  script run — the two can disagree.
- **`get_syslog_report` silently returns the wrong day / is missing several hours** — was a real bug, found
  2026-08-26 via a spot-check comparison against
  [echelon-ai-labs/servicenow-mcp](https://github.com/echelon-ai-labs/servicenow-mcp)'s query patterns.
  `src/tools/syslog.ts` used to build the date filter with
  `sys_created_onBETWEENjavascript:gs.dateGenerate('<date>','00:00:00')@javascript:gs.dateGenerate(...)`.
  `gs.dateGenerate()` evaluates in the instance's configured timezone, but `sys_created_on` comes back as a
  raw UTC value over the Table API — so the window was silently offset by the instance's UTC delta (~7h on
  this PDI), pulling in the tail of the wrong day and missing early hours of the right one. Fixed by
  dropping the `javascript:gs.dateGenerate(...)` wrapper entirely and passing plain literal
  `'<date> 00:00:00'@'<date> 23:59:59'` strings, which compare directly against the raw stored value with
  no timezone conversion. Verified: 834 rows across all 24 hours for 2026-08-25, vs. 366 rows across 17
  hours before the fix. If this instance's timezone config ever changes, re-verify with the same
  full-hour-coverage check (see step 4-style spot check) rather than assuming.
- **`CONNECTION_CLOSED` in `claude mcp list`** — the CLI session started before Node.js was on PATH.
  Register with `node.exe`'s absolute path (already done in step 5) or start a fresh session.
- **Edited the code, rebuilt, but behavior didn't change** — an already-running Claude Code session keeps
  the old `dist/` loaded over its stdio connection. Run `/mcp` in that session to reconnect; no restart needed.

## Files

- `src/servicenow-client.ts` — Table API wrapper (Basic Auth) plus `queryTableAll`, the pagination loop both
  tools use (1000 rows/page, 10,000-row safety cap, returns `{ rows, truncated }`). Swap Basic Auth for
  OAuth here later if moving off the PDI.
- `src/tools/syslog.ts`, `src/tools/dev-work-report.ts` — the two report queries.
- `src/create-server.ts` — builds an `McpServer` and registers both tools; shared by both entrypoints below.
- `src/index.ts` — stdio entrypoint (Claude Code/Desktop); resolves `.env` relative to itself (not cwd).
- `src/http.ts` — Streamable HTTP entrypoint (step 7); bearer-token auth, one server+transport per session.

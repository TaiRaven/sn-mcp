# sn-mcp

Local MCP server for ServiceNow: 78 tools across 15 domains — incidents, changes, catalog, knowledge base,
users/groups, script includes, Agile (story/scrum task/project), classic Workflow, and the two original
on-demand reports the project started as. Most of that surface is a full read/write port of
[echelon-ai-labs/servicenow-mcp](https://github.com/echelon-ai-labs/servicenow-mcp), a larger Python/FastMCP
ServiceNow server. Built from a plan kept in the author's private Obsidian vault ("ServiceNow MCP Server —
Syslog & Dev Work Reports (Plan)"); the full read/write port that took this from 2 tools to 78 followed its
own separate plan, preserved at `C:\Users\willr\.claude\plans\structured-spinning-rain.md`. Setup narrative
and troubleshooting also live in that vault, in a matching "(Setup Guide)" note — not included in this repo.

Borrowed from the reference project: a remote-reachable HTTP transport alongside stdio (step 7 below) — it
exposes both stdio and SSE, this project uses stdio and the modern Streamable HTTP equivalent; ServiceNow's
own relative-date keywords informed comparing against this project's own date-range query style, which is
what originally surfaced the timezone bug described in step 4/Troubleshooting; and (from the full port) its
82-tool inventory across 14 domains, ported with full read/write parity per an explicit user decision — not
its `AuthManager` (Basic/OAuth/API-key behind one interface), which stays out of scope; this project remains
Basic-only.

## Build history

| Commit | What |
|---|---|
| `3a30861` | Original build: `get_syslog_report` + `get_developer_work_report`, stdio transport. |
| `e4e6c68` | Batch 0+1 of 8 — write CRUD layer (`createRecord`/`updateRecord`/`deleteRecord`) + Incident tools. |
| `e450682` | Batch 2 of 8 — User & Group tools. |
| `63936c7` | Batch 3 of 8 — Catalog tools. |
| `34c08a9` | Batch 4 of 8 — Change & Changeset tools. |
| `873879d` | Batch 5 of 8 — Knowledge Base tools. |
| `0163165` | Batch 6 of 8 — Story, Scrum Task & Project tools; epic tools dropped (see gap list below). |
| `498ff17` | Batch 7 of 8 — Script Include tools. |
| `6a00bfc` | Batch 8 of 8 (final) — classic Workflow tools; 3 tools dropped (see gap list below). Port complete: 76/82 reference tools shipped. |
| `7a2fb41` | Full README documentation pass: per-domain tool reference, dropped-tool rationale, corrected account-provisioning guidance. |

Each batch was verified end-to-end through real MCP tool calls (not just direct function tests) before
committing — create/update/list at minimum, with test data tagged `[MCP-TEST]` and cleaned up afterward.
Full per-batch build notes, gotchas, and platform-specific findings live in project memory, not this file.

**Of the reference's 82 tools, 76 were ported** (giving 78 total with the 2 original report tools). 6 were
deliberately not ported — not porting mistakes, each confirmed against this PDI's live schema before being
dropped:

- `create_epic` / `update_epic` / `list_epics` — `rm_epic` is not a valid table on this PDI (confirmed via
  `sys_db_object`; this instance's Agile plugin install is scrum-only, no Epic/Project-portfolio linkage).
- `activate_workflow` / `deactivate_workflow` — `wf_workflow` has no `active` field on this PDI at all
  (confirmed by dumping every element on the table).
- `reorder_workflow_activities` — `wf_activity` has no `order` field either; classic Workflow ordering here
  is driven by a visual transition graph, not a simple integer.

`get_optimization_recommendations` is ported but **partially simulated** — see its entry below.
`percent_complete` on the project tools is intentionally renamed from the reference's `percentage_complete`,
which is a genuine bug in the reference project (doesn't match the real `pm_project` column, so it silently
no-ops there). Full per-batch build notes, gotchas, and platform gaps live in project memory
(`project_servicenow_mcp_reports.md`) and in code comments at each domain file (`src/tools/*.ts`).

## Tools

### Reports (read-only)

Both are read-only GET queries against the Table API — neither tool ever writes to the instance. Both
return raw/grouped rows only; analysis (suggested fixes, flagged concerns) happens in conversation with
Claude, not inside the tool. Both paginate automatically (`queryTableAll` in `servicenow-client.ts`, 1000
rows/page, 10,000-row safety cap) instead of a hardcoded single-page `sysparm_limit` — if a query hits the
cap, the response leads with an explicit `⚠ Truncated` text block before the JSON, rather than silently
returning a partial report. Registered for both entrypoints from the same `src/create-server.ts`.

#### `get_syslog_report`

Fetch `syslog` rows for a single day, filtered to warning/error by default.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `date` | `string` | no | yesterday | `YYYY-MM-DD` |
| `levels` | `string[]` | no | `["warning","error"]` | Friendly names (`trace`/`debug`/`info`/`warning`/`error`/`fatal`), mapped internally to this instance's numeric `syslog.level` codes — see README §4 if pointing at a different instance. |

Returns a JSON array of:

```json
{
  "sys_created_on": "2026-08-25 17:30:24",
  "message": "SG-Azure Request failed with statusCode: 403 Code: AccessDenied ...",
  "source": "sn_sg_azure_integ",
  "level": "2",
  "node": "..."
}
```

#### `get_developer_work_report`

Fetch `sys_update_xml` changes between two dates, grouped by author and update set.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `start_date` | `string` | yes | — | `YYYY-MM-DD` |
| `end_date` | `string` | yes | — | `YYYY-MM-DD` |

Returns a JSON array of:

```json
{
  "author": "system",
  "updateSet": "Default",
  "isDefaultUpdateSet": true,
  "changeCount": 2,
  "changes": [
    { "name": "...", "type": "Service Graph Connections State", "created": "2026-08-25 10:30:30" }
  ]
}
```

### Incident (`src/tools/incident.ts`, 6 tools)

`assigned_to`/`assignment_group`/`caller_id` accept a username, email, or sys_id, written as display
values. `resolve_incident`'s `resolution_code` is a choice field — verified against `sys_choice` on this PDI
rather than guessed (see project memory for the confirmed value list).

| Tool | Description |
|---|---|
| `create_incident` | Create a new incident. |
| `update_incident` | Update an existing incident (accepts sys_id or incident number). |
| `add_comment` | Add a comment or work note to an incident. |
| `resolve_incident` | Resolve an incident (sets state to Resolved with a resolution code and notes). |
| `list_incidents` | List incidents, most recent first. One bounded page per call, not the full table. |
| `get_incident_by_number` | Fetch a single incident by its number (e.g. INC0010001). |

### User & Group (`src/tools/user.ts`, 9 tools)

`user_id`/`group_id` accept a raw sys_id, username/email, or group name. Group-membership adds dedupe
against existing rows before inserting (a deliberate improvement over the reference, which doesn't).

| Tool | Description |
|---|---|
| `create_user` | Create a new user. |
| `update_user` | Update an existing user (accepts sys_id, username, or email). |
| `get_user` | Fetch a single user by sys_id, username, or email. |
| `list_users` | List users, most recent first. One bounded page per call. |
| `create_group` | Create a new group, optionally with initial members. |
| `update_group` | Update an existing group (accepts sys_id or name). |
| `add_group_members` | Add one or more members to a group. |
| `remove_group_members` | Remove one or more members from a group. |
| `list_groups` | List groups. One bounded page per call. |

### Catalog (`src/tools/catalog.ts` + `catalog-variables.ts` + `catalog-optimization.ts`, 11 tools)

`get_optimization_recommendations` is **partially simulated**: `low_usage`/`high_abandonment`/
`slow_fulfillment` are randomly fabricated (no real usage-tracking data source exists on this PDI, matching
the reference project's own use of Python's `random`), while `inactive_items`/`description_quality` reflect
real instance data — the whole response is still labeled `simulated: true` rather than splitting the
labeling per-type, a deliberate choice. Never present this tool's output as real analysis.

| Tool | Description |
|---|---|
| `list_catalog_items` | List service catalog items. One bounded page per call. |
| `get_catalog_item` | Fetch a single catalog item by sys_id, including its variables (form fields). |
| `list_catalog_categories` | List service catalog categories. One bounded page per call. |
| `create_catalog_category` | Create a new service catalog category. |
| `update_catalog_category` | Update an existing service catalog category. |
| `move_catalog_items` | Move one or more catalog items to a different category. |
| `create_catalog_item_variable` | Create a new variable (form field) on a catalog item. |
| `list_catalog_item_variables` | List the variables (form fields) defined on a catalog item. |
| `update_catalog_item_variable` | Update an existing catalog item variable. |
| `get_optimization_recommendations` | SIMULATED optimization recommendations — see note above. |
| `update_catalog_item` | Update an existing catalog item's core fields. |

### Change & Changeset (`src/tools/change.ts` + `changeset.ts`, 15 tools)

**Known platform gaps on this PDI** (not porting bugs — confirmed empirically, documented in each tool's own
MCP description): `submit_change_for_approval`/`approve_change`/`reject_change`'s state transitions are
blocked by a Change Model business rule, and `sysapproval_approver.document_id` doesn't persist via direct
write — approval records are meant to come from ServiceNow's own Approval Engine. `add_file_to_changeset`
is blocked by ACL on `sys_update_xml`. `publish_changeset`'s `"published"` state doesn't exist as a
`sys_update_set` choice on this PDI (silently no-ops rather than erroring). All four tools are still
implemented as faithful ports — the gaps are platform behavior, not something this project codes around.

| Tool | Description |
|---|---|
| `create_change_request` | Create a new change request. |
| `update_change_request` | Update an existing change request (accepts sys_id or change number). |
| `list_change_requests` | List change requests. One bounded page per call. |
| `get_change_request_details` | Fetch a single change request with its associated change tasks. |
| `add_change_task` | Add a task to a change request. |
| `submit_change_for_approval` | Submit for approval. NOTE: may fail — see gaps above. |
| `approve_change` | Approve a pending approval record and move to Implement. NOTE: may fail — see gaps above. |
| `reject_change` | Reject a pending approval record and cancel the change. NOTE: may fail — see gaps above. |
| `list_changesets` | List changesets (update sets). One bounded page per call. |
| `get_changeset_details` | Fetch a single changeset with the changes it contains. |
| `create_changeset` | Create a new changeset. |
| `update_changeset` | Update an existing changeset (accepts sys_id or name). |
| `commit_changeset` | Commit a changeset (sets state to complete). |
| `publish_changeset` | Publish a changeset. NOTE: may silently no-op — see gaps above. |
| `add_file_to_changeset` | Add a file to a changeset. NOTE: often ACL-blocked — see gaps above. |

### Knowledge Base (`src/tools/knowledge-base.ts`, 9 tools)

`publish_article`'s direct `workflow_state` write silently reverts to draft on this PDI — modern instances
drive publish through Flow Designer (`kb_publish_flow`), not a bare Table API write; documented in the
tool's own description rather than fixed, since resolving the flow is out of scope. `kb_category`/
`kb_knowledge_base` block direct deletes via ACL even for this admin-scoped account — no cleanup path exists
through the Table API for those two tables.

| Tool | Description |
|---|---|
| `create_knowledge_base` | Create a new knowledge base. |
| `list_knowledge_bases` | List knowledge bases. One bounded page per call. |
| `create_category` | Create a new category in a knowledge base. |
| `create_article` | Create a new knowledge article. |
| `update_article` | Update an existing knowledge article. |
| `publish_article` | Change an article's workflow state. NOTE: silently reverts to draft — see note above. |
| `list_articles` | List knowledge articles. One bounded page per call. |
| `get_article` | Fetch a single knowledge article by sys_id. |
| `list_categories` | List knowledge base categories. One bounded page per call. |

### Story, Scrum Task & Project (`src/tools/story.ts` + `scrum-task.ts` + `project.ts`, 12 tools)

Epic tools and `story.epic`/`story.project`/`scrum_task.type` params dropped — see the top-of-file gap list.
`percent_complete` on the project tools is renamed from the reference's `percentage_complete` (a genuine bug
in the reference — that name doesn't match the real `pm_project` column).

| Tool | Description |
|---|---|
| `create_story` | Create a new story. |
| `update_story` | Update an existing story (accepts sys_id or story number). |
| `list_stories` | List stories. One bounded page per call. |
| `list_story_dependencies` | List dependencies between stories. |
| `create_story_dependency` | Create a dependency between two stories. |
| `delete_story_dependency` | Delete a story dependency record. |
| `create_scrum_task` | Create a new scrum task under a story. |
| `update_scrum_task` | Update an existing scrum task (accepts sys_id or scrum task number). |
| `list_scrum_tasks` | List scrum tasks. One bounded page per call. |
| `create_project` | Create a new project. |
| `update_project` | Update an existing project (accepts sys_id or project number). |
| `list_projects` | List projects. One bounded page per call. |

### Script Include (`src/tools/script-include.ts`, 5 tools)

**Highest-care domain in this project** — `script` is live, executable server-side JavaScript. Never write
code from an untrusted source through these tools. `script_include_id` accepts a name, or a sys_id prefixed
with `sys_id:` to bypass name lookup.

| Tool | Description |
|---|---|
| `list_script_includes` | List script includes (metadata only, not script bodies). One bounded page per call. |
| `get_script_include` | Fetch a single script include, including its full script body. |
| `create_script_include` | Create a new script include. WARNING: live executable code. |
| `update_script_include` | Update an existing script include. WARNING: live executable code. |
| `delete_script_include` | Delete a script include. |

### Workflow (`src/tools/workflow.ts`, 9 tools)

Classic Workflow — legacy, superseded by Flow Designer on modern instances. Confirmed live and queryable on
this PDI before porting. `activate_workflow`/`deactivate_workflow`/`reorder_workflow_activities` are not
ported — see the top-of-file gap list. `add_workflow_activity`'s `activity_type` resolves by name against
`wf_activity_definition` (the real reference field), not a flat string as the reference project assumes.
**Known reference-project gap, ported as-is:** `add_workflow_activity` requires a real `workflow_version_id`
that no tool in this domain creates — `create_workflow` makes an empty `wf_workflow` row with no version;
get one via `list_workflow_versions` against a pre-existing workflow, or create one directly via the Table
API (not exposed as a tool here, matching the reference's own scope).

| Tool | Description |
|---|---|
| `list_workflows` | List classic Workflow definitions. One bounded page per call. |
| `get_workflow_details` | Fetch a single workflow definition, optionally including its versions. |
| `list_workflow_versions` | List the versions of a workflow. |
| `get_workflow_activities` | Fetch activities for a workflow version, defaulting to the latest published version. |
| `create_workflow` | Create a new (empty) workflow definition. |
| `update_workflow` | Update an existing workflow definition (accepts name or sys_id). |
| `add_workflow_activity` | Add an activity to a workflow version. See gap note above. |
| `update_workflow_activity` | Update an existing workflow activity's name or extra fields. |
| `delete_workflow_activity` | Delete a workflow activity. |

## 1. Provision a ServiceNow service account (manual, one-time)

Do this in the PDI (`https://dev203275.service-now.com`), logged in as an admin:

1. **User Administration → Users → New**
   - User ID: `claude_mcp_readonly`
   - Set a password, uncheck **"Password needs reset"**
   - Check **"Web service access only"** — **required**. Without it, ServiceNow's
     `SNCRestrictBasicAuthUserAuthenticationGate` blocks Basic Auth over REST for this account even with a
     correct password, because the account is also permitted interactive UI login. Symptom if missed: every
     REST call 401s with `"User is not authenticated"` while logging into the UI with the same credentials
     works fine. See Troubleshooting.
2. On that user record → **Roles** related list → **Edit** → add roles for whichever tools you actually need
   (see below).
3. Copy `.env.example` to `.env` and fill in `SN_USER` / `SN_PASS` with this new account.

**Role scope has changed since the original 2-tool build.** The account was originally intentionally
read-only (`rest_api_explorer` plus read access to `syslog`/`sys_update_xml`/`sys_update_set`). Once the
full read/write port (82 reference tools → 76 shipped) was added, the user explicitly decided to **elevate
this same account** — `claude_mcp_readonly` — with write roles rather than create a second dedicated write
account or reuse the separate admin `claude_automation` account (see project memory for the full decision
record). On this PDI, `claude_mcp_readonly` ended up carrying `user_admin` and `admin` — turned out to
already be present on this instance's default service-account role set, not something granted
incrementally batch-by-batch as the original plan assumed (confirmed via `sys_user_has_role` before each
batch, only surfaced to the user when a real 403 actually occurred). **If provisioning this fresh on a new
instance:** don't assume a broad role set will already be there — start read-only per the original steps
above if you only want the 2 report tools; grant roles per domain as each write tool is actually needed
(the account name stays misleading either way — renaming a live ServiceNow username is more hassle than
it's worth). Script include writes in particular are effectively code-execution capability and deserve the
most scrutiny of any grant in this project — see the Script Include tools section above.

## 2. Build

```powershell
cd C:\Users\willr\projects\sn-mcp
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
claude mcp add --scope user sn-mcp -- "C:\Program Files\nodejs\node.exe" C:\Users\willr\projects\sn-mcp\dist\index.js
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
    "sn-mcp": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\willr\\projects\\sn-mcp\\dist\\index.js"],
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

- `src/servicenow-client.ts` — Table API wrapper (Basic Auth): `queryTable`/`getRecord`/`createRecord`/
  `updateRecord`/`deleteRecord`, plus `queryTableAll`, the "fetch everything up to a safety cap" pagination
  loop the two report tools use (1000 rows/page, 10,000-row safety cap, returns `{ rows, truncated }`) — not
  used by any `list_*` tool, which paginate one caller-controlled page at a time via plain `queryTable`.
  Swap Basic Auth for OAuth here later if moving off the PDI.
- `src/register-tool.ts` — `registerTool()`/`jsonResult()`: shared response framing (JSON content block,
  prepends a `⚠ Truncated` note when a result carries `{truncated: true}`) so every domain file doesn't
  hand-roll it.
- `src/tools/shared.ts` — cross-domain helpers: `resolveUserSysId`/`resolveRoleSysId`/`resolveGroupSysId`/
  `assignRoleToUser` (user/group/role lookups, reused by `user.ts` and beyond) and `buildTimeframeQuery`
  (the `upcoming`/`in-progress`/`completed` filter shared by `change.ts`/`story.ts`/`scrum-task.ts`/
  `project.ts` — deliberately built from a literal UTC timestamp, not `javascript:gs.now()`, to avoid the
  timezone bug class described in Troubleshooting below).
- `src/tools/syslog.ts`, `src/tools/dev-work-report.ts` — the two original report queries.
- `src/tools/incident.ts`, `user.ts`, `catalog.ts`, `catalog-variables.ts`, `catalog-optimization.ts`,
  `change.ts`, `changeset.ts`, `knowledge-base.ts`, `story.ts`, `scrum-task.ts`, `project.ts`,
  `script-include.ts`, `workflow.ts` — the 76 ported tools, one file per reference domain; see the Tools
  section above for what's in each and project memory for the batch-by-batch build history.
- `src/create-server.ts` — builds an `McpServer` and registers all 78 tools, grouped by domain with a
  comment header per section; shared by both entrypoints below.
- `src/index.ts` — stdio entrypoint (Claude Code/Desktop); resolves `.env` relative to itself (not cwd).
- `src/http.ts` — Streamable HTTP entrypoint (step 7); bearer-token auth, one server+transport per session.

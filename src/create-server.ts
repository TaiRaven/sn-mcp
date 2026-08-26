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
import {
  CreateUserShape,
  createUser,
  UpdateUserShape,
  updateUser,
  GetUserShape,
  getUser,
  ListUsersShape,
  listUsers,
  CreateGroupShape,
  createGroup,
  UpdateGroupShape,
  updateGroup,
  AddGroupMembersShape,
  addGroupMembers,
  RemoveGroupMembersShape,
  removeGroupMembers,
  ListGroupsShape,
  listGroups,
} from "./tools/user.js";
import {
  ListCatalogItemsShape,
  listCatalogItems,
  GetCatalogItemShape,
  getCatalogItem,
  ListCatalogCategoriesShape,
  listCatalogCategories,
  CreateCatalogCategoryShape,
  createCatalogCategory,
  UpdateCatalogCategoryShape,
  updateCatalogCategory,
  MoveCatalogItemsShape,
  moveCatalogItems,
} from "./tools/catalog.js";
import {
  CreateCatalogItemVariableShape,
  createCatalogItemVariable,
  ListCatalogItemVariablesShape,
  listCatalogItemVariables,
  UpdateCatalogItemVariableShape,
  updateCatalogItemVariable,
} from "./tools/catalog-variables.js";
import {
  OptimizationRecommendationsShape,
  getOptimizationRecommendations,
  UpdateCatalogItemShape,
  updateCatalogItem,
} from "./tools/catalog-optimization.js";
import {
  CreateChangeRequestShape,
  createChangeRequest,
  UpdateChangeRequestShape,
  updateChangeRequest,
  ListChangeRequestsShape,
  listChangeRequests,
  GetChangeRequestDetailsShape,
  getChangeRequestDetails,
  AddChangeTaskShape,
  addChangeTask,
  SubmitChangeForApprovalShape,
  submitChangeForApproval,
  ApproveChangeShape,
  approveChange,
  RejectChangeShape,
  rejectChange,
} from "./tools/change.js";
import {
  ListChangesetsShape,
  listChangesets,
  GetChangesetDetailsShape,
  getChangesetDetails,
  CreateChangesetShape,
  createChangeset,
  UpdateChangesetShape,
  updateChangeset,
  CommitChangesetShape,
  commitChangeset,
  PublishChangesetShape,
  publishChangeset,
  AddFileToChangesetShape,
  addFileToChangeset,
} from "./tools/changeset.js";

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

  // --- user_tools ---

  registerTool(server, "create_user", "Create a new user.", CreateUserShape, createUser);
  registerTool(
    server,
    "update_user",
    "Update an existing user (accepts sys_id, username, or email).",
    UpdateUserShape,
    updateUser
  );
  registerTool(
    server,
    "get_user",
    "Fetch a single user by sys_id, username, or email.",
    GetUserShape,
    getUser
  );
  registerTool(
    server,
    "list_users",
    "List users, most recent first. limit/offset paginate — this returns one bounded page, not the full table.",
    ListUsersShape,
    listUsers
  );
  registerTool(
    server,
    "create_group",
    "Create a new group, optionally with initial members.",
    CreateGroupShape,
    createGroup
  );
  registerTool(
    server,
    "update_group",
    "Update an existing group (accepts sys_id or name).",
    UpdateGroupShape,
    updateGroup
  );
  registerTool(
    server,
    "add_group_members",
    "Add one or more members to a group.",
    AddGroupMembersShape,
    addGroupMembers
  );
  registerTool(
    server,
    "remove_group_members",
    "Remove one or more members from a group.",
    RemoveGroupMembersShape,
    removeGroupMembers
  );
  registerTool(
    server,
    "list_groups",
    "List groups. limit/offset paginate — this returns one bounded page, not the full table.",
    ListGroupsShape,
    listGroups
  );

  // --- catalog_tools ---

  registerTool(
    server,
    "list_catalog_items",
    "List service catalog items. limit/offset paginate — this returns one bounded page, not the full table.",
    ListCatalogItemsShape,
    listCatalogItems
  );
  registerTool(
    server,
    "get_catalog_item",
    "Fetch a single catalog item by sys_id, including its variables (form fields).",
    GetCatalogItemShape,
    getCatalogItem
  );
  registerTool(
    server,
    "list_catalog_categories",
    "List service catalog categories. limit/offset paginate — this returns one bounded page, not the full table.",
    ListCatalogCategoriesShape,
    listCatalogCategories
  );
  registerTool(
    server,
    "create_catalog_category",
    "Create a new service catalog category.",
    CreateCatalogCategoryShape,
    createCatalogCategory
  );
  registerTool(
    server,
    "update_catalog_category",
    "Update an existing service catalog category.",
    UpdateCatalogCategoryShape,
    updateCatalogCategory
  );
  registerTool(
    server,
    "move_catalog_items",
    "Move one or more catalog items to a different category.",
    MoveCatalogItemsShape,
    moveCatalogItems
  );

  // --- catalog_variables ---

  registerTool(
    server,
    "create_catalog_item_variable",
    "Create a new variable (form field) on a catalog item.",
    CreateCatalogItemVariableShape,
    createCatalogItemVariable
  );
  registerTool(
    server,
    "list_catalog_item_variables",
    "List the variables (form fields) defined on a catalog item.",
    ListCatalogItemVariablesShape,
    listCatalogItemVariables
  );
  registerTool(
    server,
    "update_catalog_item_variable",
    "Update an existing catalog item variable.",
    UpdateCatalogItemVariableShape,
    updateCatalogItemVariable
  );

  // --- catalog_optimization ---

  registerTool(
    server,
    "get_optimization_recommendations",
    "SIMULATED catalog optimization recommendations — low_usage/high_abandonment/slow_fulfillment " +
      "stats are randomly fabricated (no real usage-tracking data source exists), matching the " +
      "reference project's own use of Python's random module. inactive_items and description_quality " +
      "reflect real instance data. Never present this as real analysis.",
    OptimizationRecommendationsShape,
    getOptimizationRecommendations
  );
  registerTool(
    server,
    "update_catalog_item",
    "Update an existing catalog item's core fields (name, description, category, price, active, order).",
    UpdateCatalogItemShape,
    updateCatalogItem
  );

  // --- change_tools ---

  registerTool(
    server,
    "create_change_request",
    "Create a new change request.",
    CreateChangeRequestShape,
    createChangeRequest
  );
  registerTool(
    server,
    "update_change_request",
    "Update an existing change request (accepts sys_id or change number).",
    UpdateChangeRequestShape,
    updateChangeRequest
  );
  registerTool(
    server,
    "list_change_requests",
    "List change requests. limit/offset paginate — this returns one bounded page, not the full table.",
    ListChangeRequestsShape,
    listChangeRequests
  );
  registerTool(
    server,
    "get_change_request_details",
    "Fetch a single change request with its associated change tasks.",
    GetChangeRequestDetailsShape,
    getChangeRequestDetails
  );
  registerTool(
    server,
    "add_change_task",
    "Add a task to a change request.",
    AddChangeTaskShape,
    addChangeTask
  );
  registerTool(
    server,
    "submit_change_for_approval",
    "Submit a change request for approval (sets state to Assess and creates an approval record). " +
      "NOTE: may fail on instances with Change Model governance (state transition business rules) " +
      "or where sysapproval_approver doesn't accept direct inserts — confirmed on this PDI.",
    SubmitChangeForApprovalShape,
    submitChangeForApproval
  );
  registerTool(
    server,
    "approve_change",
    "Approve a change request's pending approval record and move the change to Implement. " +
      "NOTE: may fail on instances with Change Model governance — confirmed on this PDI.",
    ApproveChangeShape,
    approveChange
  );
  registerTool(
    server,
    "reject_change",
    "Reject a change request's pending approval record and cancel the change. " +
      "NOTE: may fail on instances with Change Model governance — confirmed on this PDI.",
    RejectChangeShape,
    rejectChange
  );

  // --- changeset_tools ---

  registerTool(
    server,
    "list_changesets",
    "List changesets (update sets). limit/offset paginate — this returns one bounded page, not the full table.",
    ListChangesetsShape,
    listChangesets
  );
  registerTool(
    server,
    "get_changeset_details",
    "Fetch a single changeset with the changes (sys_update_xml rows) it contains.",
    GetChangesetDetailsShape,
    getChangesetDetails
  );
  registerTool(
    server,
    "create_changeset",
    "Create a new changeset (update set).",
    CreateChangesetShape,
    createChangeset
  );
  registerTool(
    server,
    "update_changeset",
    "Update an existing changeset (accepts sys_id or name).",
    UpdateChangesetShape,
    updateChangeset
  );
  registerTool(
    server,
    "commit_changeset",
    "Commit a changeset (sets state to complete).",
    CommitChangesetShape,
    commitChangeset
  );
  registerTool(
    server,
    "publish_changeset",
    "Publish a changeset. NOTE: requires a 'published' state choice to exist on sys_update_set — " +
      "not present on every instance (confirmed absent on this PDI).",
    PublishChangesetShape,
    publishChangeset
  );
  registerTool(
    server,
    "add_file_to_changeset",
    "Add a file (sys_update_xml record) to a changeset. NOTE: sys_update_xml often blocks direct " +
      "inserts via ACL (confirmed on this PDI) since it normally holds system-generated content.",
    AddFileToChangesetShape,
    addFileToChangeset
  );

  return server;
}

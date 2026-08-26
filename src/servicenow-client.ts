interface Credentials {
  instance: string;
  user: string;
  pass: string;
}

function getCredentials(): Credentials {
  const instance = process.env.SN_INSTANCE;
  const user = process.env.SN_USER;
  const pass = process.env.SN_PASS;
  if (!instance || !user || !pass) {
    throw new Error(
      "Missing SN_INSTANCE, SN_USER, or SN_PASS environment variables. Check your .env file."
    );
  }
  return { instance, user, pass };
}

function authHeader(creds: Credentials): string {
  return "Basic " + Buffer.from(`${creds.user}:${creds.pass}`).toString("base64");
}

export class ServiceNowApiError extends Error {
  constructor(public status: number, public table: string, public body: string) {
    super(`ServiceNow API error ${status} on ${table}: ${body}`);
    this.name = "ServiceNowApiError";
  }
}

/**
 * Shared fetch + auth + error handling for every Table API call. Returns `undefined` for a 204
 * (DELETE) response; otherwise parses and returns the JSON body.
 */
async function snRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: URL,
  table: string,
  body?: unknown
): Promise<T | undefined> {
  const creds = getCredentials();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(creds),
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return undefined;

  if (!res.ok) {
    const responseBody = await res.text();
    throw new ServiceNowApiError(res.status, table, responseBody);
  }

  return (await res.json()) as T;
}

export interface QueryOptions {
  sysparm_query?: string;
  sysparm_fields?: string;
  sysparm_limit?: number;
  sysparm_offset?: number;
  sysparm_display_value?: boolean;
}

export async function queryTable<T = Record<string, string>>(
  table: string,
  options: QueryOptions = {}
): Promise<T[]> {
  const creds = getCredentials();
  const url = new URL(`/api/now/table/${table}`, creds.instance);
  if (options.sysparm_query) url.searchParams.set("sysparm_query", options.sysparm_query);
  if (options.sysparm_fields) url.searchParams.set("sysparm_fields", options.sysparm_fields);
  if (options.sysparm_limit) url.searchParams.set("sysparm_limit", String(options.sysparm_limit));
  if (options.sysparm_offset) url.searchParams.set("sysparm_offset", String(options.sysparm_offset));
  if (options.sysparm_display_value) url.searchParams.set("sysparm_display_value", "true");

  const data = await snRequest<{ result: T[] }>("GET", url, table);
  return data!.result;
}

export interface PaginatedResult<T> {
  rows: T[];
  /** True if the safety cap (maxRows) was hit before the query was exhausted — the result is partial. */
  truncated: boolean;
}

const DEFAULT_PAGE_SIZE = 1000;
// Safety cap, not a real limit — a personal PDI tops out around ~1k rows/day, but a busy company
// instance can produce far more. This exists so a huge query degrades to an explicit "truncated: true"
// signal instead of an unbounded fetch (or a silent, unmarked partial result at the old hardcoded 1000).
const DEFAULT_MAX_ROWS = 10000;

export async function queryTableAll<T = Record<string, string>>(
  table: string,
  options: QueryOptions = {},
  { pageSize = DEFAULT_PAGE_SIZE, maxRows = DEFAULT_MAX_ROWS }: { pageSize?: number; maxRows?: number } = {}
): Promise<PaginatedResult<T>> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const page = await queryTable<T>(table, {
      ...options,
      sysparm_limit: pageSize,
      sysparm_offset: offset,
    });
    rows.push(...page);

    if (page.length < pageSize) {
      // Short page — the table is exhausted, nothing more to fetch.
      return { rows, truncated: false };
    }
    if (rows.length >= maxRows) {
      return { rows: rows.slice(0, maxRows), truncated: true };
    }
    offset += pageSize;
  }
}

export interface ReadOptions {
  sysparm_fields?: string;
  sysparm_display_value?: boolean;
}

export async function getRecord<T = Record<string, string>>(
  table: string,
  sysId: string,
  options: ReadOptions = {}
): Promise<T> {
  const creds = getCredentials();
  const url = new URL(`/api/now/table/${table}/${sysId}`, creds.instance);
  if (options.sysparm_fields) url.searchParams.set("sysparm_fields", options.sysparm_fields);
  if (options.sysparm_display_value) url.searchParams.set("sysparm_display_value", "true");

  const data = await snRequest<{ result: T }>("GET", url, table);
  return data!.result;
}

export interface WriteOptions {
  /**
   * Lets reference fields (assigned_to, assignment_group, ...) be written as display values
   * (a username, a group name) instead of requiring a literal sys_id. Off by default — matches
   * ServiceNow's own API default and the observed behavior of the reference project this was
   * ported from. Turn on per-call where a domain's params are meant to accept human-readable
   * names (see the per-domain notes in each tools/*.ts file).
   */
  sysparm_input_display_value?: boolean;
}

export async function createRecord<T = Record<string, string>>(
  table: string,
  body: Record<string, unknown>,
  options: WriteOptions = {}
): Promise<T> {
  const creds = getCredentials();
  const url = new URL(`/api/now/table/${table}`, creds.instance);
  if (options.sysparm_input_display_value) url.searchParams.set("sysparm_input_display_value", "true");

  const data = await snRequest<{ result: T }>("POST", url, table, body);
  return data!.result;
}

export async function updateRecord<T = Record<string, string>>(
  table: string,
  sysId: string,
  body: Record<string, unknown>,
  options: WriteOptions = {}
): Promise<T> {
  const creds = getCredentials();
  const url = new URL(`/api/now/table/${table}/${sysId}`, creds.instance);
  if (options.sysparm_input_display_value) url.searchParams.set("sysparm_input_display_value", "true");

  const data = await snRequest<{ result: T }>("PATCH", url, table, body);
  return data!.result;
}

export async function deleteRecord(table: string, sysId: string): Promise<void> {
  const creds = getCredentials();
  const url = new URL(`/api/now/table/${table}/${sysId}`, creds.instance);
  await snRequest<undefined>("DELETE", url, table);
}

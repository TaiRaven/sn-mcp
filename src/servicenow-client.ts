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
  const instance = process.env.SN_INSTANCE;
  const user = process.env.SN_USER;
  const pass = process.env.SN_PASS;
  if (!instance || !user || !pass) {
    throw new Error(
      "Missing SN_INSTANCE, SN_USER, or SN_PASS environment variables. Check your .env file."
    );
  }

  const url = new URL(`/api/now/table/${table}`, instance);
  if (options.sysparm_query) url.searchParams.set("sysparm_query", options.sysparm_query);
  if (options.sysparm_fields) url.searchParams.set("sysparm_fields", options.sysparm_fields);
  if (options.sysparm_limit) url.searchParams.set("sysparm_limit", String(options.sysparm_limit));
  if (options.sysparm_offset) url.searchParams.set("sysparm_offset", String(options.sysparm_offset));
  if (options.sysparm_display_value) url.searchParams.set("sysparm_display_value", "true");

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ServiceNow API error ${res.status} on ${table}: ${body}`);
  }

  const data = (await res.json()) as { result: T[] };
  return data.result;
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

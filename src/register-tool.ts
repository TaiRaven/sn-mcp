import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type TextContent = { type: "text"; text: string };

const TRUNCATED_NOTE =
  "⚠ Truncated: hit the pagination safety cap before the query was exhausted. This result is " +
  "incomplete — narrow the query, or raise the cap in queryTableAll if a wider result is genuinely needed.";

/** Frames a tool's return value as MCP text content, prepending a truncation warning when the
 *  value carries `{ truncated: true }` (the shape queryTableAll-backed tools return). */
export function jsonResult(data: unknown): { content: TextContent[] } {
  const content: TextContent[] = [];
  if (data && typeof data === "object" && (data as { truncated?: boolean }).truncated) {
    content.push({ type: "text", text: TRUNCATED_NOTE });
  }
  content.push({ type: "text", text: JSON.stringify(data, null, 2) });
  return { content };
}

/** Registers a tool whose handler returns a plain value — wraps it in jsonResult so 82+
 *  registrations don't each hand-roll the same response framing. Errors propagate by throwing
 *  (the MCP SDK already catches and returns them as `{content, isError:true}`). */
export function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: Shape,
  fn: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>
): void {
  // The SDK's `tool()` overload resolution doesn't unify cleanly through a generic wrapper — the
  // shape and handler are still fully typed at every call site via this function's own signature.
  server.tool(name, description, shape as z.ZodRawShape, (async (args: unknown) =>
    jsonResult(await fn(args as z.infer<z.ZodObject<Shape>>))) as never);
}

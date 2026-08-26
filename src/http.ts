import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createReportsServer } from "./create-server.js";

// Remote-reachable alternative to index.ts's stdio transport — e.g. for claude.ai hosted
// Scheduled Tasks, which (unlike Claude Code/Desktop) can't spawn a local stdio process and
// need an HTTP endpoint to call instead. Run with `npm run start:http`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", ".env") });

const HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MCP_HTTP_PORT ?? 3535);
const TOKEN = process.env.MCP_HTTP_TOKEN;

if (!TOKEN) {
  console.warn(
    "MCP_HTTP_TOKEN is not set — this listener accepts unauthenticated requests. That's fine while " +
      "bound to 127.0.0.1 only, but set MCP_HTTP_TOKEN before exposing this beyond localhost " +
      "(e.g. behind a tunnel, for claude.ai hosted Scheduled Tasks)."
  );
}

// createMcpExpressApp() defaults to 127.0.0.1 with DNS-rebinding protection enabled, and wires up
// JSON body parsing already — see @modelcontextprotocol/sdk/server/express.js.
const app = createMcpExpressApp({ host: HOST });

if (TOKEN) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization === `Bearer ${TOKEN}`) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  });
}

// One MCP server + transport per session, keyed by the mcp-session-id header the SDK issues on
// initialize. Matches the SDK's own stateful HTTP example (ssePollingExample.ts).
const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

  if (!transport) {
    const created = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, created);
      },
    });
    created.onclose = () => {
      if (created.sessionId) transports.delete(created.sessionId);
    };
    const server = createReportsServer();
    await server.connect(created);
    transport = created;
  }

  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, HOST, () => {
  console.log(`servicenow-reports MCP server listening at http://${HOST}:${PORT}/mcp`);
});

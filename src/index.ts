import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSnMcpServer } from "./create-server.js";

// Resolve .env relative to this file, not process.cwd() — Claude Code launches
// this server with an unrelated working directory, so dotenv's default lookup fails.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", ".env") });

const server = createSnMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);

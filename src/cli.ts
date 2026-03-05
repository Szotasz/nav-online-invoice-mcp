#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import createServer from "./index.js";

const server = createServer();
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("NAV Online Invoice MCP server running on stdio");
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

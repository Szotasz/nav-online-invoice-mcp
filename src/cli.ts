#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "./config.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "nav-online-invoice",
  version: "1.0.0",
  description: "MCP server for the Hungarian NAV Online Invoice (Online Számla) API v3.0. Query taxpayers, search invoices, check invoice status, and submit invoices to NAV.",
  websiteUrl: "https://github.com/Szotasz/nav-online-invoice-mcp",
});

registerTools(server, () => getConfig());

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("NAV Online Invoice MCP server running on stdio");
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

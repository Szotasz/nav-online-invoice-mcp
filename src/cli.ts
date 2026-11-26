#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { getConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { registerSkills } from "./skills.js";

const server = new McpServer({
  name: "nav-online-invoice",
  version: "1.0.0",
  description: "MCP server for the Hungarian NAV Online Invoice (Online Számla) API v3.0. Query taxpayers, search invoices, check invoice status, and submit invoices to NAV.",
  websiteUrl: "https://github.com/Szotasz/nav-online-invoice-mcp",
});

registerTools(server, () => getConfig());
// The skills are attached before connecting (the extension declares its capability at connect).
registerSkills(server);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("NAV Online Invoice MCP server running on stdio");
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

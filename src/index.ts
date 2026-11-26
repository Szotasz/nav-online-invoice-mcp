import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { registerSkills } from "./skills.js";

// Smithery config schema — exported so Smithery auto-generates the config UI
export const configSchema = z.object({
  NAV_LOGIN: z.string().describe("NAV Online Invoice API login username"),
  NAV_PASSWORD: z.string().describe("NAV Online Invoice API password"),
  NAV_TAX_NUMBER: z.string().describe("8-digit Hungarian tax number (adoszam)"),
  NAV_SIGNATURE_KEY: z.string().describe("NAV API XML signature key"),
  NAV_EXCHANGE_KEY: z.string().describe("NAV API data exchange key"),
  NAV_ENV: z.enum(["test", "production"]).default("production").describe("NAV environment (test or production)"),
  NAV_SOFTWARE_ID: z.string().default("NAVONLINEINVMCP-01").describe("Registered software ID at NAV"),
  NAV_SOFTWARE_DEV_NAME: z.string().default("MCP Developer").describe("Software developer name"),
  NAV_SOFTWARE_DEV_CONTACT: z.string().default("dev@example.com").describe("Software developer contact email"),
  NAV_SOFTWARE_DEV_TAX_NUMBER: z.string().default("00000000").describe("Software developer tax number"),
});

type SmitheryConfig = z.infer<typeof configSchema>;

// Smithery calls: default({ config }) — destructured object with config key
export default function createServer({ config }: { config: Partial<SmitheryConfig> }) {
  const server = new McpServer({
    name: "nav-online-invoice",
    version: "2.0.0",
    description: "MCP server for the Hungarian NAV Online Invoice (Online Számla) API v3.0. Query taxpayers, search invoices, check invoice status, and submit invoices to NAV.",
    websiteUrl: "https://github.com/Szotasz/nav-online-invoice-mcp",
  });

  registerTools(server, () => getConfig(config));
  registerSkills(server);

  // Smithery expects server.server (the low-level Server instance)
  return server.server;
}

// Used by Smithery to scan tools without real credentials
export function createSandboxServer() {
  return createServer({
    config: {
      NAV_LOGIN: "sandbox",
      NAV_PASSWORD: "sandbox",
      NAV_TAX_NUMBER: "00000000",
      NAV_SIGNATURE_KEY: "sandbox",
      NAV_EXCHANGE_KEY: "sandbox",
      NAV_ENV: "test" as const,
    },
  });
}

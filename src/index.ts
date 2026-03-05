import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NavClient } from "./nav-client.js";
import type { NavConfig } from "./types.js";

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

function getConfig(config?: Partial<SmitheryConfig>): NavConfig {
  const get = (key: string): string | undefined =>
    config?.[key as keyof SmitheryConfig] || process.env[key];

  const required = (key: string): string => {
    const val = get(key);
    if (!val) throw new Error(`Missing required config: ${key}`);
    return val;
  };

  const env = get("NAV_ENV");
  const isTest = env === "test";
  const baseUrl = isTest
    ? "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3"
    : "https://api.onlineszamla.nav.gov.hu/invoiceService/v3";

  return {
    login: required("NAV_LOGIN"),
    password: required("NAV_PASSWORD"),
    taxNumber: required("NAV_TAX_NUMBER"),
    signatureKey: required("NAV_SIGNATURE_KEY"),
    exchangeKey: required("NAV_EXCHANGE_KEY"),
    baseUrl: get("NAV_BASE_URL") || baseUrl,
    softwareId: get("NAV_SOFTWARE_ID") || "NAVONLINEINVMCP-01",
    softwareName: get("NAV_SOFTWARE_NAME") || "nav-online-invoice-mcp",
    softwareVersion: get("NAV_SOFTWARE_VERSION") || "1.0.0",
    softwareDevName: get("NAV_SOFTWARE_DEV_NAME") || "MCP Developer",
    softwareDevContact: get("NAV_SOFTWARE_DEV_CONTACT") || "dev@example.com",
    softwareDevCountryCode: get("NAV_SOFTWARE_DEV_COUNTRY") || "HU",
    softwareDevTaxNumber: get("NAV_SOFTWARE_DEV_TAX_NUMBER") || get("NAV_TAX_NUMBER") || "00000000",
  };
}

function formatResponse(result: { funcCode: string; errorCode?: string; message?: string }, data: unknown, rawXml?: string): string {
  const parts: string[] = [];

  if (result.funcCode !== "OK") {
    parts.push(`## Error`);
    parts.push(`- **Status**: ${result.funcCode}`);
    if (result.errorCode) parts.push(`- **Error Code**: ${result.errorCode}`);
    if (result.message) parts.push(`- **Message**: ${result.message}`);
    if (rawXml) parts.push(`\n### Raw Response\n\`\`\`xml\n${rawXml}\n\`\`\``);
    return parts.join("\n");
  }

  parts.push(`## Success`);
  parts.push("```json");
  parts.push(JSON.stringify(data, null, 2));
  parts.push("```");
  return parts.join("\n");
}

// Smithery calls: default({ config }) — destructured object with config key
export default function createServer({ config }: { config: Partial<SmitheryConfig> }) {
  const server = new McpServer({
    name: "nav-online-invoice",
    version: "1.0.0",
    description: "MCP server for the Hungarian NAV Online Invoice (Online Számla) API v3.0. Query taxpayers, search invoices, check invoice status, and submit invoices to NAV.",
    websiteUrl: "https://github.com/Szotasz/nav-online-invoice-mcp",
  });

  // --- Query Tools (read-only, safe) ---

  server.tool(
    "query_taxpayer",
    "Query taxpayer information from NAV by tax number (adoszam). Returns company name, address, VAT status.",
    {
      taxNumber: z.string().length(8).describe("8-digit Hungarian tax number (adoszam)"),
    },
    { title: "Query Taxpayer", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ taxNumber }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml } = await client.queryTaxpayer(taxNumber);
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.tool(
    "query_invoice_data",
    "Get full invoice data by invoice number from NAV. Returns complete invoice details.",
    {
      invoiceNumber: z.string().describe("Invoice number (szamlaszam)"),
      invoiceDirection: z.enum(["INBOUND", "OUTBOUND"]).describe("INBOUND = received invoices, OUTBOUND = issued invoices"),
      batchIndex: z.number().optional().describe("Batch index if part of a batch invoice"),
      supplierTaxNumber: z.string().optional().describe("Supplier tax number (only for INBOUND)"),
    },
    { title: "Get Invoice Data", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml } = await client.queryInvoiceData(
        invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.tool(
    "query_invoice_digest",
    "Search invoices in NAV with filters. Returns a paginated list of invoice summaries. Must provide either date range (dateFrom/dateTo), insertion date range (insDateTimeFrom/insDateTimeTo), or originalInvoiceNumber.",
    {
      page: z.number().min(1).default(1).describe("Page number (1-based)"),
      invoiceDirection: z.enum(["INBOUND", "OUTBOUND"]).describe("INBOUND = received, OUTBOUND = issued"),
      dateFrom: z.string().optional().describe("Invoice issue date from (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("Invoice issue date to (YYYY-MM-DD)"),
      insDateTimeFrom: z.string().optional().describe("Insertion datetime from (ISO 8601)"),
      insDateTimeTo: z.string().optional().describe("Insertion datetime to (ISO 8601)"),
      originalInvoiceNumber: z.string().optional().describe("Original invoice number for modifications"),
      taxNumber: z.string().optional().describe("Partner tax number filter"),
      name: z.string().optional().describe("Partner name filter"),
      invoiceCategory: z.enum(["NORMAL", "SIMPLIFIED", "AGGREGATE"]).optional(),
      paymentMethod: z.enum(["TRANSFER", "CASH", "CARD", "VOUCHER", "OTHER"]).optional(),
      currency: z.string().optional().describe("Currency code (e.g. HUF, EUR)"),
    },
    { title: "Search Invoices", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml } = await client.queryInvoiceDigest(params);
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.tool(
    "query_invoice_check",
    "Check if an invoice exists in NAV system.",
    {
      invoiceNumber: z.string().describe("Invoice number"),
      invoiceDirection: z.enum(["INBOUND", "OUTBOUND"]),
      batchIndex: z.number().optional(),
      supplierTaxNumber: z.string().optional(),
    },
    { title: "Check Invoice Existence", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml } = await client.queryInvoiceCheck(
        invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.tool(
    "query_invoice_chain_digest",
    "Query the modification chain of an invoice (original + all modifications/stornos).",
    {
      page: z.number().min(1).default(1),
      invoiceNumber: z.string().describe("Original invoice number"),
      invoiceDirection: z.enum(["INBOUND", "OUTBOUND"]),
      taxNumber: z.string().optional().describe("Partner tax number"),
    },
    { title: "Invoice Modification Chain", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ page, invoiceNumber, invoiceDirection, taxNumber }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml } = await client.queryInvoiceChainDigest(
        page, invoiceNumber, invoiceDirection, taxNumber
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.tool(
    "query_transaction_status",
    "Check the processing status of a previously submitted invoice transaction.",
    {
      transactionId: z.string().describe("Transaction ID from manageInvoice response"),
      returnOriginalRequest: z.boolean().default(false).describe("Include original request data"),
    },
    { title: "Transaction Status", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ transactionId, returnOriginalRequest }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml } = await client.queryTransactionStatus(
        transactionId, returnOriginalRequest
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.tool(
    "query_transaction_list",
    "List transactions within a date range.",
    {
      page: z.number().min(1).default(1),
      insDateFrom: z.string().describe("From datetime (ISO 8601)"),
      insDateTo: z.string().describe("To datetime (ISO 8601)"),
      requestStatus: z.string().optional().describe("Filter by status"),
    },
    { title: "List Transactions", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ page, insDateFrom, insDateTo, requestStatus }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml } = await client.queryTransactionList(
        page, insDateFrom, insDateTo, requestStatus
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  // --- Write Tools (modifying operations) ---

  server.tool(
    "manage_invoice",
    "Submit invoice data to NAV (create, modify, or storno). Handles token exchange automatically. The invoiceData must be BASE64-encoded invoice XML conforming to NAV invoiceData XSD.",
    {
      operations: z
        .array(
          z.object({
            index: z.number().min(1).max(100),
            operation: z.enum(["CREATE", "MODIFY", "STORNO"]),
            invoiceData: z.string().describe("BASE64-encoded invoice XML"),
            electronicInvoiceHash: z.string().optional().describe("SHA3-512 hash for electronic invoices"),
          })
        )
        .min(1)
        .max(100)
        .describe("Array of invoice operations (max 100)"),
      compressed: z.boolean().default(false).describe("Whether invoiceData is GZIP compressed"),
    },
    { title: "Submit Invoice", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ operations, compressed }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml, transactionId } = await client.manageInvoice(operations, compressed);
      const response = formatResponse(result, data, rawXml);
      const extra = transactionId ? `\n**Transaction ID**: \`${transactionId}\`` : "";
      return { content: [{ type: "text", text: response + extra }] };
    }
  );

  server.tool(
    "manage_annulment",
    "Submit technical annulment for invoices. Use this for correcting technical errors (wrong data, wrong invoice number, etc.).",
    {
      operations: z
        .array(
          z.object({
            index: z.number().min(1).max(100),
            annulmentData: z.string().describe("BASE64-encoded annulment XML"),
          })
        )
        .min(1)
        .max(100),
    },
    { title: "Annul Invoice", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ operations }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml, transactionId } = await client.manageAnnulment(operations);
      const response = formatResponse(result, data, rawXml);
      const extra = transactionId ? `\n**Transaction ID**: \`${transactionId}\`` : "";
      return { content: [{ type: "text", text: response + extra }] };
    }
  );

  // --- Prompts ---

  server.prompt(
    "search-invoices",
    "Search for invoices issued or received within a date range",
    {
      direction: z.enum(["INBOUND", "OUTBOUND"]).describe("INBOUND = received, OUTBOUND = issued"),
      dateFrom: z.string().describe("Start date (YYYY-MM-DD)"),
      dateTo: z.string().describe("End date (YYYY-MM-DD)"),
    },
    ({ direction, dateFrom, dateTo }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Search for ${direction === "OUTBOUND" ? "issued" : "received"} invoices from ${dateFrom} to ${dateTo} using the query_invoice_digest tool. Show the results in a clear table format with invoice number, date, partner name, and amount.`,
        },
      }],
    })
  );

  server.prompt(
    "check-taxpayer",
    "Look up a Hungarian taxpayer by their tax number",
    {
      taxNumber: z.string().describe("8-digit Hungarian tax number"),
    },
    ({ taxNumber }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Look up taxpayer information for tax number ${taxNumber} using the query_taxpayer tool. Show the company name, full address, and VAT status.`,
        },
      }],
    })
  );

  server.prompt(
    "invoice-details",
    "Get complete details of a specific invoice",
    {
      invoiceNumber: z.string().describe("Invoice number to look up"),
      direction: z.enum(["INBOUND", "OUTBOUND"]).describe("INBOUND = received, OUTBOUND = issued"),
    },
    ({ invoiceNumber, direction }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Get the full details of invoice ${invoiceNumber} (${direction === "OUTBOUND" ? "issued" : "received"}) using the query_invoice_data tool. Show all relevant information including items, amounts, tax details, and partner information.`,
        },
      }],
    })
  );

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

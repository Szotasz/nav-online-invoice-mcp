#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NavClient } from "./nav-client.js";
import type { NavConfig } from "./types.js";

interface SmitheryConfig {
  NAV_LOGIN?: string;
  NAV_PASSWORD?: string;
  NAV_TAX_NUMBER?: string;
  NAV_SIGNATURE_KEY?: string;
  NAV_EXCHANGE_KEY?: string;
  NAV_ENV?: string;
  NAV_SOFTWARE_ID?: string;
  NAV_SOFTWARE_DEV_NAME?: string;
  NAV_SOFTWARE_DEV_CONTACT?: string;
  NAV_SOFTWARE_DEV_TAX_NUMBER?: string;
}

function getConfig(config?: SmitheryConfig): NavConfig {
  const get = (key: string): string | undefined =>
    config?.[key as keyof SmitheryConfig] || process.env[key];

  const required = (key: string): string => {
    const val = get(key);
    if (!val) throw new Error(`Missing required config: ${key}`);
    return val;
  };

  const env = get("NAV_ENV");
  const isTest = !env || env === "test";
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

export default function createServer(config?: SmitheryConfig): McpServer {
  const server = new McpServer({
    name: "nav-online-invoice",
    version: "1.0.0",
  });

  // --- Query Tools (read-only, safe) ---

  server.tool(
    "query_taxpayer",
    "Query taxpayer information from NAV by tax number (adoszam). Returns company name, address, VAT status.",
    {
      taxNumber: z.string().length(8).describe("8-digit Hungarian tax number (adoszam)"),
    },
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
    async ({ operations }) => {
      const client = new NavClient(getConfig(config));
      const { result, data, rawXml, transactionId } = await client.manageAnnulment(operations);
      const response = formatResponse(result, data, rawXml);
      const extra = transactionId ? `\n**Transaction ID**: \`${transactionId}\`` : "";
      return { content: [{ type: "text", text: response + extra }] };
    }
  );

  return server;
}

export function createSandboxServer(): McpServer {
  return createServer({});
}

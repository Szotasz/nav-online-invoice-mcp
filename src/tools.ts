import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { NavClient } from "./nav-client.js";
import type { NavConfig } from "./types.js";
import { ConfirmationStore, confirmationIdSchema, withConfirmation } from "./confirm.js";
import { summarizeAnnulmentOperations, summarizeInvoiceOperations } from "./summaries.js";
import { MAX_WAIT_MS, realDeps, submitAndWait, type WaitDeps } from "./wait.js";
import { SentLedger } from "./sent.js";

export function formatResponse(result: { funcCode: string; errorCode?: string; message?: string }, data: unknown, rawXml?: string): string {
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

// The 9 tools and 3 prompts, registered once for both entry points (src/cli.ts and the Smithery src/index.ts).
// getConfig is called per tool call, so a missing setting fails that call, not the server start.
// The two write tools (manage_invoice, manage_annulment) ask for a confirmation before anything is sent (src/confirm.ts).
export interface ToolOptions {
  /** The confirmation ids of this server; a fresh store when not given. */
  store?: ConfirmationStore;
  /** The elicitation request timeout; the SDK default when not given. */
  elicitationTimeoutMs?: number;
  /** submit_and_wait's clock and pause (tests); the real ones when not given. */
  wait?: WaitDeps;
}

export function registerTools(server: McpServer, getConfig: () => NavConfig, options: ToolOptions = {}): void {
  const store = options.store ?? new ConfirmationStore();
  const elicitationTimeoutMs = options.elicitationTimeoutMs;
  const waitDeps = options.wait ?? realDeps;
  // The invoice data already sent, shared by manage_invoice and submit_and_wait (src/sent.ts).
  const ledger = new SentLedger(waitDeps.now);

  // --- Query Tools (read-only, safe) ---

  server.registerTool(
    "query_taxpayer",
    {
      description: "Query taxpayer information from NAV by tax number (adoszam). Returns company name, address, VAT status.",
      inputSchema: z.object({
        taxNumber: z.string().length(8).describe("8-digit Hungarian tax number (adoszam)"),
      }),
      annotations: { title: "Query Taxpayer", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ taxNumber }) => {
      const client = new NavClient(getConfig());
      const { result, data, rawXml } = await client.queryTaxpayer(taxNumber);
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.registerTool(
    "query_invoice_data",
    {
      description: "Get full invoice data by invoice number from NAV. Returns complete invoice details.",
      inputSchema: z.object({
        invoiceNumber: z.string().describe("Invoice number (szamlaszam)"),
        invoiceDirection: z.enum(["INBOUND", "OUTBOUND"]).describe("INBOUND = received invoices, OUTBOUND = issued invoices"),
        batchIndex: z.number().optional().describe("Batch index if part of a batch invoice"),
        supplierTaxNumber: z.string().optional().describe("Supplier tax number (only for INBOUND)"),
      }),
      annotations: { title: "Get Invoice Data", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber }) => {
      const client = new NavClient(getConfig());
      const { result, data, rawXml } = await client.queryInvoiceData(
        invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.registerTool(
    "query_invoice_digest",
    {
      description: "Search invoices in NAV with filters. Returns a paginated list of invoice summaries. Must provide either date range (dateFrom/dateTo), insertion date range (insDateTimeFrom/insDateTimeTo), or originalInvoiceNumber.",
      inputSchema: z.object({
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
      }),
      annotations: { title: "Search Invoices", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      const client = new NavClient(getConfig());
      const { result, data, rawXml } = await client.queryInvoiceDigest(params);
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.registerTool(
    "query_invoice_check",
    {
      description: "Check if an invoice exists in NAV system.",
      inputSchema: z.object({
        invoiceNumber: z.string().describe("Invoice number"),
        invoiceDirection: z.enum(["INBOUND", "OUTBOUND"]),
        batchIndex: z.number().optional(),
        supplierTaxNumber: z.string().optional(),
      }),
      annotations: { title: "Check Invoice Existence", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber }) => {
      const client = new NavClient(getConfig());
      const { result, data, rawXml } = await client.queryInvoiceCheck(
        invoiceNumber, invoiceDirection, batchIndex, supplierTaxNumber
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.registerTool(
    "query_invoice_chain_digest",
    {
      description: "Query the modification chain of an invoice (original + all modifications/stornos).",
      inputSchema: z.object({
        page: z.number().min(1).default(1),
        invoiceNumber: z.string().describe("Original invoice number"),
        invoiceDirection: z.enum(["INBOUND", "OUTBOUND"]),
        taxNumber: z.string().optional().describe("Partner tax number"),
      }),
      annotations: { title: "Invoice Modification Chain", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ page, invoiceNumber, invoiceDirection, taxNumber }) => {
      const client = new NavClient(getConfig());
      const { result, data, rawXml } = await client.queryInvoiceChainDigest(
        page, invoiceNumber, invoiceDirection, taxNumber
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.registerTool(
    "query_transaction_status",
    {
      description: "Check the processing status of a previously submitted invoice transaction.",
      inputSchema: z.object({
        transactionId: z.string().describe("Transaction ID from manageInvoice response"),
        returnOriginalRequest: z.boolean().default(false).describe("Include original request data"),
      }),
      annotations: { title: "Transaction Status", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ transactionId, returnOriginalRequest }) => {
      const client = new NavClient(getConfig());
      const { result, data, rawXml } = await client.queryTransactionStatus(
        transactionId, returnOriginalRequest
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  server.registerTool(
    "query_transaction_list",
    {
      description: "List transactions within a date range.",
      inputSchema: z.object({
        page: z.number().min(1).default(1),
        insDateFrom: z.string().describe("From datetime (ISO 8601)"),
        insDateTo: z.string().describe("To datetime (ISO 8601)"),
        requestStatus: z.string().optional().describe("Filter by status"),
      }),
      annotations: { title: "List Transactions", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ page, insDateFrom, insDateTo, requestStatus }) => {
      const client = new NavClient(getConfig());
      const { result, data, rawXml } = await client.queryTransactionList(
        page, insDateFrom, insDateTo, requestStatus
      );
      return { content: [{ type: "text", text: formatResponse(result, data, rawXml) }] };
    }
  );

  // --- Write Tools (modifying operations) ---

  server.registerTool(
    "manage_invoice",
    {
      description: "Submit invoice data to NAV (create, modify, or storno). Handles token exchange automatically. The invoiceData must be BASE64-encoded invoice XML conforming to NAV invoiceData XSD.",
      inputSchema: z.object({
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
        confirmation_id: confirmationIdSchema,
      }),
      annotations: { title: "Submit Invoice", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) => {
      // The same data already sent: nothing is sent, not even a confirmation is asked (src/sent.ts).
      const earlier = ledger.find(args.operations, args.compressed);
      if (earlier) return Promise.resolve(ledger.alreadySent(earlier));
      return withConfirmation({
        server, store, elicitationTimeoutMs, tool: "manage_invoice",
        describe: ({ operations, compressed }: typeof args) => summarizeInvoiceOperations(getConfig().baseUrl, operations, compressed),
        run: async ({ operations, compressed }: typeof args) => {
          const client = new NavClient(getConfig());
          const { result, data, rawXml, transactionId } = await client.manageInvoice(operations, compressed);
          if (transactionId) ledger.record(operations, compressed, transactionId);
          const response = formatResponse(result, data, rawXml);
          const extra = transactionId ? `\n**Transaction ID**: \`${transactionId}\`` : "";
          return { content: [{ type: "text", text: response + extra }] };
        },
      })(args, ctx);
    }
  );

  server.registerTool(
    "submit_and_wait",
    {
      description:
        "Submit invoice data to NAV like manage_invoice (the same confirmation first), then wait up to " +
        `${MAX_WAIT_MS / 1000} seconds for NAV's processing result per invoice. Only DONE is an acceptance; ABORTED was ` +
        "not accepted. If NAV has not finished in time, the answer gives the transaction ID: continue with " +
        "query_transaction_status. Stopping the wait does not recall data already sent.",
      inputSchema: z.object({
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
        maxWaitSeconds: z.number().int().min(1).max(MAX_WAIT_MS / 1000).optional()
          .describe(`How long to wait for the result, in seconds; at most ${MAX_WAIT_MS / 1000}, the default`),
        confirmation_id: confirmationIdSchema,
      }),
      annotations: { title: "Submit Invoice and Wait", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    // The call budget counts from the start of this call, before the confirmation (src/wait.ts, CALL_BUDGET_MS).
    (args, ctx) => {
      const startedAt = waitDeps.now();
      const earlier = ledger.find(args.operations, args.compressed);
      if (earlier) return Promise.resolve(ledger.alreadySent(earlier));
      return withConfirmation({
        server, store, elicitationTimeoutMs, tool: "submit_and_wait",
        describe: (a: typeof args) => summarizeInvoiceOperations(getConfig().baseUrl, a.operations, a.compressed),
        run: (a: typeof args, c) => submitAndWait(getConfig(), a, c, formatResponse, waitDeps, startedAt, ledger),
      })(args, ctx);
    }
  );

  server.registerTool(
    "manage_annulment",
    {
      description: "Submit technical annulment for invoices. Use this for correcting technical errors (wrong data, wrong invoice number, etc.).",
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              index: z.number().min(1).max(100),
              annulmentData: z.string().describe("BASE64-encoded annulment XML"),
            })
          )
          .min(1)
          .max(100),
        confirmation_id: confirmationIdSchema,
      }),
      annotations: { title: "Annul Invoice", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withConfirmation({
      server, store, elicitationTimeoutMs, tool: "manage_annulment",
      describe: ({ operations }) => summarizeAnnulmentOperations(getConfig().baseUrl, operations),
      run: async ({ operations }) => {
        const client = new NavClient(getConfig());
        const { result, data, rawXml, transactionId } = await client.manageAnnulment(operations);
        const response = formatResponse(result, data, rawXml);
        const extra = transactionId ? `\n**Transaction ID**: \`${transactionId}\`` : "";
        return { content: [{ type: "text", text: response + extra }] };
      },
    })
  );

  // --- Prompts ---

  server.registerPrompt(
    "search-invoices",
    {
      description: "Search for invoices issued or received within a date range",
      argsSchema: z.object({
        direction: z.enum(["INBOUND", "OUTBOUND"]).describe("INBOUND = received, OUTBOUND = issued"),
        dateFrom: z.string().describe("Start date (YYYY-MM-DD)"),
        dateTo: z.string().describe("End date (YYYY-MM-DD)"),
      }),
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

  server.registerPrompt(
    "check-taxpayer",
    {
      description: "Look up a Hungarian taxpayer by their tax number",
      argsSchema: z.object({
        taxNumber: z.string().describe("8-digit Hungarian tax number"),
      }),
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

  server.registerPrompt(
    "invoice-details",
    {
      description: "Get complete details of a specific invoice",
      argsSchema: z.object({
        invoiceNumber: z.string().describe("Invoice number to look up"),
        direction: z.enum(["INBOUND", "OUTBOUND"]).describe("INBOUND = received, OUTBOUND = issued"),
      }),
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
}

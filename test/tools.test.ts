// Every tool through the MCP layer, against the mock NAV: one happy path and one NAV error branch (funcCode != OK)
// each. The request is checked too: the endpoint, the NAV test base URL (NAV_ENV=test), and the key field in the body.
// The two write tools ask for a confirmation first (test/confirm.test.ts); here the client accepts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectClient, withMockNav, textOf, tokenExchangeOk, accept, b64, invoiceXml, annulmentXml, PARTNER_TAX, EXCHANGE_TOKEN, type Reply,
} from "./helpers.js";

const INVOICE = "TESZT-0001";
const TX = "TESZTTX000000001";
const TEST_BASE = "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/";

type Case = {
  tool: string;
  args: Record<string, unknown>;
  endpoint: string;
  root: string;
  okInner: string;
  okShows: string;
  bodyHas: string;
  write?: boolean;
};

const CASES: Case[] = [
  { tool: "query_taxpayer", args: { taxNumber: PARTNER_TAX }, endpoint: "queryTaxpayer", root: "QueryTaxpayerResponse",
    okInner: "<taxpayerValidity>true</taxpayerValidity><taxpayerData><taxpayerName>Teszt Partner Kft.</taxpayerName></taxpayerData>",
    okShows: "Teszt Partner Kft.", bodyHas: `<taxNumber>${PARTNER_TAX}</taxNumber>` },
  { tool: "query_invoice_data", args: { invoiceNumber: INVOICE, invoiceDirection: "OUTBOUND" }, endpoint: "queryInvoiceData",
    root: "QueryInvoiceDataResponse", okInner: `<invoiceDataResult><invoiceData>${b64("<InvoiceData>teszt</InvoiceData>")}</invoiceData></invoiceDataResult>`,
    okShows: "invoiceDataResult", bodyHas: `<invoiceNumber>${INVOICE}</invoiceNumber>` },
  { tool: "query_invoice_digest", args: { invoiceDirection: "OUTBOUND", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
    endpoint: "queryInvoiceDigest", root: "QueryInvoiceDigestResponse",
    okInner: `<invoiceDigestResult><currentPage>1</currentPage><availablePage>1</availablePage><invoiceDigest><invoiceNumber>${INVOICE}</invoiceNumber></invoiceDigest></invoiceDigestResult>`,
    okShows: INVOICE, bodyHas: "2026-01-31" },
  { tool: "query_invoice_check", args: { invoiceNumber: INVOICE, invoiceDirection: "OUTBOUND" }, endpoint: "queryInvoiceCheck",
    root: "QueryInvoiceCheckResponse", okInner: "<invoiceCheckResult>true</invoiceCheckResult>", okShows: "invoiceCheckResult",
    bodyHas: `<invoiceNumber>${INVOICE}</invoiceNumber>` },
  { tool: "query_invoice_chain_digest", args: { invoiceNumber: INVOICE, invoiceDirection: "OUTBOUND" }, endpoint: "queryInvoiceChainDigest",
    root: "QueryInvoiceChainDigestResponse",
    okInner: `<invoiceChainDigestResult><currentPage>1</currentPage><invoiceChainElement><invoiceNumber>${INVOICE}</invoiceNumber></invoiceChainElement></invoiceChainDigestResult>`,
    okShows: INVOICE, bodyHas: `<invoiceNumber>${INVOICE}</invoiceNumber>` },
  { tool: "query_transaction_status", args: { transactionId: TX }, endpoint: "queryTransactionStatus", root: "QueryTransactionStatusResponse",
    okInner: "<processingResults><processingResult><index>1</index><invoiceStatus>DONE</invoiceStatus></processingResult></processingResults>",
    okShows: "DONE", bodyHas: `<transactionId>${TX}</transactionId>` },
  { tool: "query_transaction_list", args: { insDateFrom: "2026-01-01T00:00:00.000Z", insDateTo: "2026-01-31T23:59:59.000Z" },
    endpoint: "queryTransactionList", root: "QueryTransactionListResponse",
    okInner: `<transactionListResult><currentPage>1</currentPage><transaction><transactionId>${TX}</transactionId></transaction></transactionListResult>`,
    okShows: TX, bodyHas: "<insDateFrom>2026-01-01T00:00:00.000Z</insDateFrom>" },
  { tool: "manage_invoice", args: { operations: [{ index: 1, operation: "CREATE", invoiceData: b64(invoiceXml()) }] },
    endpoint: "manageInvoice", root: "ManageInvoiceResponse", okInner: `<transactionId>${TX}</transactionId>`, okShows: TX,
    bodyHas: `<exchangeToken>${EXCHANGE_TOKEN}</exchangeToken>`, write: true },
  { tool: "manage_annulment", args: { operations: [{ index: 1, annulmentData: b64(annulmentXml()) }] },
    endpoint: "manageAnnulment", root: "ManageAnnulmentResponse", okInner: `<transactionId>${TX}</transactionId>`, okShows: TX,
    bodyHas: `<exchangeToken>${EXCHANGE_TOKEN}</exchangeToken>`, write: true },
];

// submit_and_wait sends and then waits on queryTransactionStatus, so its cases are in test/wait.test.ts.
const COVERED_ELSEWHERE = ["submit_and_wait"];

test("the cases cover every registered tool", async () => {
  const client = await connectClient();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual([...CASES.map((c) => c.tool), ...COVERED_ELSEWHERE].sort(), names);
  await client.close();
});

for (const c of CASES) {
  test(`${c.tool}: happy path`, async () => {
    const replies: Record<string, Reply> = { [c.endpoint]: { root: c.root, inner: c.okInner } };
    if (c.write) replies.tokenExchange = tokenExchangeOk();
    await withMockNav(replies, async (calls) => {
      const client = await connectClient(undefined, c.write ? { elicit: accept } : {});
      const res = await client.callTool({ name: c.tool, arguments: c.args });
      const text = textOf(res);
      assert.ok(!res.isError, text);
      assert.match(text, /^## Success/);
      assert.ok(text.includes(c.okShows), text);
      if (c.write) assert.ok(text.includes(`**Transaction ID**: \`${TX}\``), text);
      assert.deepEqual(calls.map((x) => x.endpoint), c.write ? ["tokenExchange", c.endpoint] : [c.endpoint]);
      for (const call of calls) assert.ok(call.url.startsWith(TEST_BASE), call.url);
      const main = calls[calls.length - 1];
      assert.ok(main.body.includes(c.bodyHas), `${c.endpoint} body lacks ${c.bodyHas}`);
      await client.close();
    });
  });

  test(`${c.tool}: a NAV error (funcCode ERROR) is shown as an error`, async () => {
    const replies: Record<string, Reply> = {
      [c.endpoint]: { root: c.root, funcCode: "ERROR", errorCode: "INVALID_REQUEST", message: "Teszt hibaüzenet" },
    };
    if (c.write) replies.tokenExchange = tokenExchangeOk();
    await withMockNav(replies, async () => {
      const client = await connectClient(undefined, c.write ? { elicit: accept } : {});
      const text = textOf(await client.callTool({ name: c.tool, arguments: c.args }));
      assert.match(text, /^## Error/);
      assert.ok(text.includes("- **Status**: ERROR"), text);
      assert.ok(text.includes("- **Error Code**: INVALID_REQUEST"), text);
      assert.ok(text.includes("- **Message**: Teszt hibaüzenet"), text);
      assert.ok(!text.includes("## Success"), text);
      await client.close();
    });
  });
}

for (const c of CASES.filter((x) => x.write)) {
  test(`${c.tool}: a failed token exchange stops before anything is submitted`, async () => {
    await withMockNav({ tokenExchange: { root: "TokenExchangeResponse", funcCode: "ERROR", errorCode: "INVALID_SECURITY_USER" } }, async (calls) => {
      const client = await connectClient(undefined, { elicit: accept });
      const res = await client.callTool({ name: c.tool, arguments: c.args });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /tokenExchange failed: INVALID_SECURITY_USER/);
      assert.deepEqual(calls.map((x) => x.endpoint), ["tokenExchange"]);
      await client.close();
    });
  });
}

// The mock NAV layer: fetch is replaced for the duration of one test, and every NAV endpoint answers from fixed XML.
// Nothing is sent anywhere. All data is made up: the tax numbers fail the Hungarian check digit on purpose
// (12345678 and 87654321 are not valid tax numbers), and every name and invoice number is fictional.
import { createCipheriv } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import createServer from "../src/index.js";
import { guardedFetch } from "./guard.js";

export const FAKE = {
  NAV_LOGIN: "teszt-login",
  NAV_PASSWORD: "teszt-jelszo",
  NAV_TAX_NUMBER: "12345678",
  NAV_SIGNATURE_KEY: "teszt-alairo-kulcs-0000000000000",
  NAV_EXCHANGE_KEY: "TesztCsereKulcs1",
  NAV_ENV: "test" as const,
};
export const PARTNER_TAX = "87654321";
export const EXCHANGE_TOKEN = "teszt-csere-token-0001";

export type NavCall = { endpoint: string; url: string; body: string };
export type Reply = { root: string; funcCode?: "OK" | "ERROR" | "WARN"; errorCode?: string; message?: string; inner?: string };

const NS = 'xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common"';

export function navXml(r: Reply): string {
  const result = [
    `<common:funcCode>${r.funcCode ?? "OK"}</common:funcCode>`,
    r.errorCode ? `<common:errorCode>${r.errorCode}</common:errorCode>` : "",
    r.message ? `<common:message>${r.message}</common:message>` : "",
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?><${r.root} ${NS}><common:header><common:requestId>MCPTESZT</common:requestId>` +
    `<common:timestamp>2026-01-02T10:00:00.000Z</common:timestamp><common:requestVersion>3.0</common:requestVersion>` +
    `<common:headerVersion>1.0</common:headerVersion></common:header><common:result>${result}</common:result>${r.inner ?? ""}</${r.root}>`;
}

/** The exchange token NAV sends, encrypted with the (fake) exchange key the way src/crypto.ts decrypts it. */
export function encodedExchangeToken(token = EXCHANGE_TOKEN, key = FAKE.NAV_EXCHANGE_KEY): string {
  const c = createCipheriv("aes-128-ecb", Buffer.from(key, "utf8").subarray(0, 16), null);
  return Buffer.concat([c.update(token, "utf8"), c.final()]).toString("base64");
}

export const tokenExchangeOk = (): Reply => ({
  root: "TokenExchangeResponse",
  inner: `<encodedExchangeToken>${encodedExchangeToken()}</encodedExchangeToken>` +
    `<tokenValidityFrom>2026-01-02T10:00:00.000Z</tokenValidityFrom><tokenValidityTo>2026-01-02T10:05:00.000Z</tokenValidityTo>`,
});

/**
 * Runs `fn` with fetch answered by `replies` (endpoint name -> reply). An endpoint without a reply fails the test.
 * A list of replies answers the calls in turn, the last one repeating. Afterwards the guard is back in place,
 * whatever happened.
 */
export async function withMockNav<T>(replies: Record<string, Reply | Reply[]>, fn: (calls: NavCall[]) => Promise<T>): Promise<T> {
  const calls: NavCall[] = [];
  const seen: Record<string, number> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const endpoint = new URL(url).pathname.split("/").pop() ?? "";
    calls.push({ endpoint, url, body: String(init?.body ?? "") });
    const r = replies[endpoint];
    const n = (seen[endpoint] = (seen[endpoint] ?? 0) + 1);
    const reply = Array.isArray(r) ? r[Math.min(n, r.length) - 1] : r;
    if (!reply) throw new Error(`mock NAV: no reply for ${endpoint}`);
    return new Response(navXml(reply), { status: 200, headers: { "Content-Type": "application/xml" } });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = guardedFetch;
  }
}

/** The answer a test client gives to a confirmation request, or an Error to fail the request. */
export type Elicit = (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> } | Error;
export const accept: Elicit = () => ({ action: "accept", content: { confirm: true } });

/**
 * An MCP client connected in memory to a server, the Smithery entry point with the fake configuration unless another
 * server is given. With `elicit` the client supports form elicitation and answers with it; `asked` collects the
 * messages it was asked to confirm.
 */
export async function connectClient(
  config: Record<string, string> = FAKE,
  opts: {
    elicit?: Elicit;
    asked?: string[];
    server?: { connect: (t: InMemoryTransport) => Promise<void> };
    /** The elicitation capability the client declares with `elicit`; form mode when not given. */
    elicitation?: Record<string, Record<string, never>>;
  } = {},
): Promise<Client> {
  const server = opts.server ?? createServer({ config });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" }, { capabilities: opts.elicit ? { elicitation: opts.elicitation ?? { form: {} } } : {} });
  if (opts.elicit) {
    const elicit = opts.elicit;
    client.setRequestHandler('elicitation/create', async (req) => {
      const message = (req.params as { message: string }).message;
      opts.asked?.push(message);
      const r = elicit(message);
      if (r instanceof Error) throw r;
      return r;
    });
  }
  await client.connect(clientSide);
  return client;
}

/** The NAV guides in skills/ (src/skills.ts), by name: the skill-<name> prompt names are pinned by this list. */
export const SKILL_NAMES = [
  "choose-correction-path", "look-up-taxpayer", "read-submission-status", "search-invoices-by-period", "test-and-production",
];

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const DATA_NS = 'xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base"';

/** One made-up invoice in the NAV invoiceData 3.0 shape (the element names of the NAV samples). */
export function invoiceBody(o: { lines?: number; original?: string; simplified?: boolean } = {}): string {
  const lines = Array.from({ length: o.lines ?? 2 }, (_, i) =>
    `<line><lineNumber>${i + 1}</lineNumber><lineDescription>Teszt tétel ${i + 1}</lineDescription><quantity>2</quantity>` +
    `<unitOfMeasure>PIECE</unitOfMeasure><unitPrice>5000</unitPrice>` +
    (o.simplified
      ? `<lineAmountsSimplified><lineVatRate><vatContent>0.2126</vatContent></lineVatRate><lineGrossAmountSimplified>12700</lineGrossAmountSimplified></lineAmountsSimplified>`
      : `<lineAmountsNormal><lineNetAmountData><lineNetAmount>10000</lineNetAmount><lineNetAmountHUF>10000</lineNetAmountHUF></lineNetAmountData>` +
        `<lineVatRate><vatPercentage>0.27</vatPercentage></lineVatRate><lineGrossAmountData><lineGrossAmountNormal>12700</lineGrossAmountNormal>` +
        `<lineGrossAmountNormalHUF>12700</lineGrossAmountNormalHUF></lineGrossAmountData></lineAmountsNormal>`) +
    `</line>`).join("");
  const n = o.lines ?? 2;
  const summary = o.simplified
    ? `<summarySimplified><vatContent>0.2126</vatContent><vatContentGrossAmount>${12700 * n}</vatContentGrossAmount></summarySimplified>`
    : `<summaryNormal><invoiceNetAmount>${10000 * n}.00</invoiceNetAmount><invoiceNetAmountHUF>${10000 * n}</invoiceNetAmountHUF>` +
      `<invoiceVatAmount>${2700 * n}.00</invoiceVatAmount><invoiceVatAmountHUF>${2700 * n}</invoiceVatAmountHUF></summaryNormal>`;
  return (o.original
    ? `<invoiceReference><originalInvoiceNumber>${o.original}</originalInvoiceNumber><modifyWithoutMaster>false</modifyWithoutMaster><modificationIndex>1</modificationIndex></invoiceReference>`
    : "") +
    `<invoiceHead><supplierInfo><supplierTaxNumber><base:taxpayerId>12345678</base:taxpayerId><base:vatCode>2</base:vatCode><base:countyCode>42</base:countyCode></supplierTaxNumber>` +
    `<supplierName>Teszt Eladó Kft.</supplierName></supplierInfo>` +
    `<customerInfo><customerVatStatus>DOMESTIC</customerVatStatus><customerVatData><customerTaxNumber><base:taxpayerId>${PARTNER_TAX}</base:taxpayerId>` +
    `<base:vatCode>2</base:vatCode><base:countyCode>02</base:countyCode></customerTaxNumber></customerVatData><customerName>Teszt Vevő Bt.</customerName></customerInfo>` +
    `<invoiceDetail><invoiceCategory>${o.simplified ? "SIMPLIFIED" : "NORMAL"}</invoiceCategory><invoiceDeliveryDate>2026-01-02</invoiceDeliveryDate><currencyCode>HUF</currencyCode>` +
    `<exchangeRate>1</exchangeRate><invoiceAppearance>ELECTRONIC</invoiceAppearance></invoiceDetail></invoiceHead>` +
    `<invoiceLines><mergedItemIndicator>false</mergedItemIndicator>${lines}</invoiceLines>` +
    `<invoiceSummary>${summary}<summaryGrossData><invoiceGrossAmount>${12700 * n}.00</invoiceGrossAmount><invoiceGrossAmountHUF>${12700 * n}</invoiceGrossAmountHUF></summaryGrossData></invoiceSummary>`;
}

export function invoiceXml(o: { number?: string; lines?: number; original?: string; simplified?: boolean; batch?: string[] } = {}): string {
  const main = o.batch
    ? o.batch.map((orig, i) => `<batchInvoice><batchIndex>${i + 1}</batchIndex><invoice>${invoiceBody({ ...o, original: orig })}</invoice></batchInvoice>`).join("")
    : `<invoice>${invoiceBody(o)}</invoice>`;
  return `<?xml version="1.0" encoding="UTF-8"?><InvoiceData ${DATA_NS}><invoiceNumber>${o.number ?? "TESZT-0001"}</invoiceNumber>` +
    `<invoiceIssueDate>2026-01-02</invoiceIssueDate><completenessIndicator>false</completenessIndicator><invoiceMain>${main}</invoiceMain></InvoiceData>`;
}

export function annulmentXml(o: { reference?: string; code?: string; reason?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?><InvoiceAnnulment xmlns="http://schemas.nav.gov.hu/OSA/3.0/annul">` +
    `<annulmentReference>${o.reference ?? "TESZT-0001"}</annulmentReference><annulmentTimestamp>2026-01-03T10:00:00.000Z</annulmentTimestamp>` +
    `<annulmentCode>${o.code ?? "ERRATIC_DATA"}</annulmentCode><annulmentReason>${o.reason ?? "Teszt: hibás adattartalom"}</annulmentReason></InvoiceAnnulment>`;
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

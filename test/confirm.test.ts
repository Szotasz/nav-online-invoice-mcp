// The confirmation step in front of manage_invoice and manage_annulment (src/confirm.ts, src/summaries.ts). Every test
// runs on the mock NAV layer, and "nothing sent" is proven by its call log: no tokenExchange, no manage* request.
// All data is made up (see test/helpers.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../src/config.js";
import { registerTools } from "../src/tools.js";
import { ConfirmationStore, CONFIRMATION_TTL_MS } from "../src/confirm.js";
import { environmentLine, MAX_LINES_LISTED, MAX_UNZIPPED_BYTES } from "../src/summaries.js";
import {
  FAKE, PARTNER_TAX, accept, annulmentXml, b64, connectClient, invoiceXml, textOf, tokenExchangeOk, withMockNav, type Elicit, type NavCall,
} from "./helpers.js";

const TX = "TESZTTX000000001";
const REPLIES = {
  tokenExchange: tokenExchangeOk(),
  manageInvoice: { root: "ManageInvoiceResponse", inner: `<transactionId>${TX}</transactionId>` },
  manageAnnulment: { root: "ManageAnnulmentResponse", inner: `<transactionId>${TX}</transactionId>` },
};
const { NAV_ENV: _omit, ...NO_ENV } = FAKE;

const invoiceArgs = (xml = invoiceXml(), operation = "CREATE") => ({ operations: [{ index: 1, operation, invoiceData: b64(xml) }] });
const annulArgs = (xml = annulmentXml()) => ({ operations: [{ index: 1, annulmentData: b64(xml) }] });

/** A session against the mock NAV: a server with its own confirmation store and clock, and a client. */
async function session(
  calls: NavCall[],
  opts: { elicit?: Elicit; config?: Record<string, string>; now?: () => number; elicitationTimeoutMs?: number } = {},
) {
  const server = new McpServer({ name: "nav-test", version: "0" });
  registerTools(server, () => getConfig(opts.config ?? FAKE), {
    store: new ConfirmationStore(opts.now),
    elicitationTimeoutMs: opts.elicitationTimeoutMs,
  });
  const asked: string[] = [];
  const client = await connectClient(undefined, { elicit: opts.elicit, asked, server });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: textOf(r), isError: r.isError === true };
  };
  const sent = () => calls.map((c) => c.endpoint);
  return { call, asked, sent, close: () => client.close() };
}

// --- the environment line ---

test("the environment line: production by default, TESZT only on the NAV test host", () => {
  assert.match(environmentLine("https://api.onlineszamla.nav.gov.hu/invoiceService/v3"), /^>>> ÉLES NAV <<< /);
  assert.match(environmentLine("https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3"), /^>>> TESZT NAV <<< /);
  // a custom NAV_BASE_URL may lead anywhere, production included
  assert.match(environmentLine("https://proxy.example.org/nav"), /^>>> ÉLES NAV <<< \(proxy\.example\.org\).*Egyedi cím/);
  assert.match(environmentLine("not a url"), /^>>> ÉLES NAV <<< /);
});

test("without NAV_ENV the summary's first line says ÉLES NAV, for both write tools", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { config: NO_ENV });
    for (const [tool, args] of [["manage_invoice", invoiceArgs()], ["manage_annulment", annulArgs()]] as const) {
      const r = await s.call(tool, args);
      assert.equal(r.text.split("\n")[0], ">>> ÉLES NAV <<< (api.onlineszamla.nav.gov.hu): a beküldés valódi adatszolgáltatás az adóhatóságnak.", tool);
    }
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

test("with NAV_ENV=test the summary's first line says TESZT NAV, also in the confirmation request", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { elicit: () => ({ action: "decline" }) });
    await s.call("manage_invoice", invoiceArgs());
    await s.call("manage_annulment", annulArgs());
    assert.equal(s.asked.length, 2);
    for (const m of s.asked) assert.equal(m.split("\n")[0], ">>> TESZT NAV <<< (api-test.onlineszamla.nav.gov.hu): a NAV tesztkörnyezete.");
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

test("NAV_ENV=test with a NAV_BASE_URL elsewhere is not called TESZT", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { config: { ...FAKE, NAV_BASE_URL: "https://api.onlineszamla.nav.gov.hu/invoiceService/v3" } });
    assert.match((await s.call("manage_invoice", invoiceArgs())).text, /^>>> ÉLES NAV <<< /);
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

// --- with elicitation ---

test("manage_invoice: the user sees the invoice and an accept sends it, once", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call("manage_invoice", invoiceArgs(invoiceXml({ lines: MAX_LINES_LISTED + 2 })));
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes(TX), r.text);
    assert.deepEqual(s.sent(), ["tokenExchange", "manageInvoice"]);
    assert.equal(s.asked.length, 1);
    const m = s.asked[0];
    for (const want of [
      "#1 CREATE: számlaszám TESZT-0001, kelt 2026-01-02",
      "Eladó: 12345678-2-42 Teszt Eladó Kft.",
      `Vevő: ${PARTNER_TAX}-2-02 Teszt Vevő Bt.`,
      "Nettó 70000.00 HUF, áfa 18900.00 HUF, bruttó 88900.00 HUF",
      "Tételek: 7",
      "1. Teszt tétel 1: 2 PIECE: nettó 10000, bruttó 12700",
      "5. Teszt tétel 5",
      "és még 2 tétel",
    ]) assert.ok(m.includes(want), `summary lacks: ${want}\n${m}`);
    assert.ok(!m.includes("Teszt tétel 6"), "only the first lines are listed");
    assert.ok(!m.includes("Eredeti számla"), "a CREATE has no original invoice");
    await s.close();
  });
});

test("manage_invoice: MODIFY and STORNO name the original invoice; a batch lists each invoice", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { elicit: () => ({ action: "decline" }) });
    await s.call("manage_invoice", invoiceArgs(invoiceXml({ number: "TESZT-0002", original: "TESZT-0001" }), "MODIFY"));
    assert.ok(s.asked[0].includes("#1 MODIFY: számlaszám TESZT-0002"), s.asked[0]);
    assert.ok(s.asked[0].includes("Eredeti számla: TESZT-0001 (módosítás sorszáma: 1)"), s.asked[0]);
    // a STORNO without the reference says so instead of passing silently
    await s.call("manage_invoice", invoiceArgs(invoiceXml({ number: "TESZT-0003" }), "STORNO"));
    assert.ok(s.asked[1].includes("Eredeti számla: NINCS MEGADVA"), s.asked[1]);
    await s.call("manage_invoice", invoiceArgs(invoiceXml({ number: "TESZT-0004", batch: ["TESZT-0001", "TESZT-0002"] }), "MODIFY"));
    assert.ok(s.asked[2].includes("Kötegelt módosító okirat, 2 számlára"), s.asked[2]);
    assert.ok(s.asked[2].includes("Eredeti számla: TESZT-0001") && s.asked[2].includes("Eredeti számla: TESZT-0002"), s.asked[2]);
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

test("manage_invoice: a simplified invoice shows its gross total; a gzip-compressed invoice is read too", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { elicit: () => ({ action: "decline" }) });
    await s.call("manage_invoice", invoiceArgs(invoiceXml({ simplified: true })));
    assert.ok(s.asked[0].includes("Bruttó 25400.00 HUF (egyszerűsített számla"), s.asked[0]);
    const gz = gzipSync(Buffer.from(invoiceXml({ number: "TESZT-GZIP" }))).toString("base64");
    await s.call("manage_invoice", { operations: [{ index: 1, operation: "CREATE", invoiceData: gz }], compressed: true });
    assert.ok(s.asked[1].includes("számlaszám TESZT-GZIP"), s.asked[1]);
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

test("manage_annulment: the user sees each annulment and the NAV approval step; an accept sends it", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call("manage_annulment", annulArgs(annulmentXml({ reference: "TESZT-0009", code: "ERRATIC_INVOICE_NUMBER", reason: "Elírt számlaszám" })));
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(s.sent(), ["tokenExchange", "manageAnnulment"]);
    const m = s.asked[0];
    for (const want of [
      "#1 számlaszám TESZT-0009",
      "Kód: ERRATIC_INVOICE_NUMBER (hibás számlaszám)",
      "Ok: Elírt számlaszám",
      "az Online Számla webes felületén jóvá kell hagyni (addig a státusza VERIFICATION_PENDING)",
    ]) assert.ok(m.includes(want), `summary lacks: ${want}\n${m}`);
    await s.close();
  });
});

const NOT_SENT: Array<[string, Elicit]> = [
  ["a decline", () => ({ action: "decline" })],
  ["a cancel", () => ({ action: "cancel" })],
  ["an accept without the box checked", () => ({ action: "accept", content: { confirm: false } })],
  ["a failed confirmation request", () => new Error("client gone")],
];
for (const [label, elicit] of NOT_SENT) {
  for (const [tool, args] of [["manage_invoice", invoiceArgs()], ["manage_annulment", annulArgs()]] as const) {
    test(`${tool}: ${label} sends nothing, and says so`, async () => {
      await withMockNav(REPLIES, async (calls) => {
        const s = await session(calls, { elicit });
        const r = await s.call(tool, args);
        assert.match(r.text, /nothing sent/);
        assert.deepEqual(s.sent(), []);
        await s.close();
      });
    });
  }
}

test("a confirmation request that times out sends nothing", { timeout: 10_000 }, async () => {
  await withMockNav(REPLIES, async (calls) => {
    // the client never answers; the server gives up after 100 ms
    const s = await session(calls, { elicit: () => new Promise(() => {}) as never, elicitationTimeoutMs: 100 });
    for (const [tool, args] of [["manage_invoice", invoiceArgs()], ["manage_annulment", annulArgs()]] as const) {
      const r = await s.call(tool, args);
      assert.equal(r.isError, true);
      assert.match(r.text, /nothing sent.*megerősítés kérése nem sikerült.*timed out/is);
    }
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

// --- a field value cannot forge a line of the summary, or show another value than NAV reads ---

const FORGED = ">>> TESZT NAV <<< (api-test.onlineszamla.nav.gov.hu): a NAV tesztkörnyezete.";
/** As a sender would write it in the XML: "<" as the named entity, which this parser and NAV both decode. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CONTROL: Array<[string, string, string]> = [
  // [the field, the injected text, what the summary shows instead]
  ["supplierName", `Teszt Eladó Kft.\n${FORGED}`, `Teszt Eladó Kft. ${FORGED}`],
  ["customerName", `Teszt Vevő Bt.\r\n${FORGED}`, `Teszt Vevő Bt. ${FORGED}`],
  ["lineDescription", `Teszt tétel 1\u2028${FORGED}`, `Teszt tétel 1 ${FORGED}`],
  ["supplierName", "Teszt \u202Eelő Kft.", "Teszt elő Kft."],
  ["customerName", "Teszt\u200B\u00ADVevő\tBt.", "Teszt Vevő Bt."],
];
for (const [field, injected, shown] of CONTROL) {
  test(`manage_invoice: a control or format character in ${field} (${JSON.stringify(injected).slice(1, 30)}...) stays inside its line`, async () => {
    await withMockNav(REPLIES, async (calls) => {
      const s = await session(calls, { config: NO_ENV, elicit: () => ({ action: "decline" }) });
      const xml = invoiceXml().replace(new RegExp(`<${field}>[^<]*</${field}>`), `<${field}>${esc(injected)}</${field}>`);
      await s.call("manage_invoice", invoiceArgs(xml));
      const lines = s.asked[0].split("\n");
      assert.match(lines[0], /^>>> ÉLES NAV <<< /);
      assert.deepEqual(lines.filter((l) => l.startsWith(">>>")), [lines[0]], "no forged environment line");
      assert.ok(lines.some((l) => l.includes(shown)), `the value shows as one line: ${shown}\n${s.asked[0]}`);
      assert.ok(!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s.asked[0].replace(/\n/g, "")), "no control or format character left");
      assert.deepEqual(s.sent(), []);
      await s.close();
    });
  });
}

test("manage_annulment: a newline in the reason cannot forge a line", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { config: NO_ENV, elicit: () => ({ action: "decline" }) });
    await s.call("manage_annulment", annulArgs(annulmentXml({ reason: esc(`Elírás\n${FORGED}`) })));
    const lines = s.asked[0].split("\n");
    assert.deepEqual(lines.filter((l) => l.startsWith(">>>")), [lines[0]]);
    assert.ok(lines.includes(`   Ok: Elírás ${FORGED}`), s.asked[0]);
    await s.close();
  });
});

const CHAR_REFS: Array<[string, () => Record<string, unknown>, string]> = [
  ["the invoice number", () => invoiceArgs(invoiceXml({ number: "A-&#49;" })), "manage_invoice"],
  ["the supplier name", () => invoiceArgs(invoiceXml().replace("Teszt Eladó Kft.", "Teszt &#x45;ladó Kft.")), "manage_invoice"],
  ["a line description", () => invoiceArgs(invoiceXml().replace("Teszt tétel 2", "Teszt t&#233;tel 2")), "manage_invoice"],
  ["the annulled invoice number", () => annulArgs(annulmentXml({ reference: "A-&#49;" })), "manage_annulment"],
];
for (const [label, args, tool] of CHAR_REFS) {
  test(`${tool}: a character reference in ${label} is refused, as NAV would read another value`, async () => {
    await withMockNav(REPLIES, async (calls) => {
      const s = await session(calls, { elicit: accept });
      const r = await s.call(tool, args());
      assert.equal(r.isError, true);
      assert.match(r.text, /nothing sent.*nem tudom összefoglalni.*karakterhivatkozás/);
      assert.deepEqual(s.asked, []);
      assert.deepEqual(s.sent(), []);
      await s.close();
    });
  });
}

test("manage_invoice: compressed data that unpacks beyond the limit is refused", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { elicit: accept });
    const bomb = gzipSync(Buffer.alloc(MAX_UNZIPPED_BYTES + 1, 0x20)).toString("base64");
    const r = await s.call("manage_invoice", { operations: [{ index: 1, operation: "CREATE", invoiceData: bomb }], compressed: true });
    assert.match(r.text, /nothing sent.*gzip.*32 MiB/);
    assert.deepEqual(s.asked, []);
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

// --- what cannot be summarised is not sent ---

const UNREADABLE: Array<[string, Record<string, unknown>]> = [
  ["not base64", { operations: [{ index: 1, operation: "CREATE", invoiceData: "ez nem base64!" }] }],
  ["not XML", invoiceArgs("<<<nem xml")],
  ["not an invoice", invoiceArgs(annulmentXml())],
  ["no supplier", invoiceArgs(invoiceXml().replace(/<supplierInfo>.*<\/supplierInfo>/, ""))],
  ["no gross total", invoiceArgs(invoiceXml().replace(/<summaryGrossData>.*<\/summaryGrossData>/, ""))],
  ["gzip flag on plain data", { ...invoiceArgs(), compressed: true }],
  ["a DOCTYPE with an internal entity", invoiceArgs(invoiceXml()
    .replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE InvoiceData [<!ENTITY e "Teszt Eladó Kft.">]>')
    .replace("<supplierName>Teszt Eladó Kft.</supplierName>", "<supplierName>&e;</supplierName>"))],
  ["a readable first and an unreadable second operation", { operations: [invoiceArgs().operations[0], { index: 2, operation: "CREATE", invoiceData: b64("<x/>") }] }],
];
for (const [label, args] of UNREADABLE) {
  test(`manage_invoice: ${label}: no summary, so nothing is asked and nothing is sent`, async () => {
    await withMockNav(REPLIES, async (calls) => {
      const s = await session(calls, { elicit: accept });
      const r = await s.call("manage_invoice", args);
      assert.equal(r.isError, true);
      assert.match(r.text, /^Nem küldtem semmit a NAV-nak \(nothing sent\): nem tudom összefoglalni, ezért nem küldöm/);
      assert.deepEqual(s.asked, []);
      assert.deepEqual(s.sent(), []);
      await s.close();
    });
  });
}

test("manage_annulment: an annulment without its code is not sent", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call("manage_annulment", annulArgs(annulmentXml().replace(/<annulmentCode>.*<\/annulmentCode>/, "")));
    assert.match(r.text, /nothing sent.*nem tudom összefoglalni/);
    assert.deepEqual(s.asked, []);
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

// --- without elicitation: the two-step confirmation_id ---

const idOf = (t: string) => /confirmation_id: "([^"]+)"/.exec(t)?.[1];

test("without elicitation: the first call only summarises; the id sends it once", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls);
    const args = invoiceArgs();
    const first = await s.call("manage_invoice", args);
    assert.equal(first.isError, false);
    assert.match(first.text, /^>>> TESZT NAV <<< /);
    assert.match(first.text, /Ez még NEM ment el\. Nem küldtem semmit a NAV-nak \(nothing sent\)/);
    assert.deepEqual(s.sent(), []);
    const id = idOf(first.text);
    assert.ok(id);
    const second = await s.call("manage_invoice", { ...args, confirmation_id: id });
    assert.equal(second.isError, false, second.text);
    assert.deepEqual(s.sent(), ["tokenExchange", "manageInvoice"]);
    const again = await s.call("manage_invoice", { ...args, confirmation_id: id });
    assert.equal(again.isError, true);
    assert.match(again.text, /nothing sent.*ismeretlen vagy már felhasznált/);
    assert.deepEqual(s.sent(), ["tokenExchange", "manageInvoice"], "the id is single-use");
    await s.close();
  });
});

test("without elicitation: the id is bound to the arguments and to the tool", async () => {
  await withMockNav(REPLIES, async (calls) => {
    const s = await session(calls);
    const id = idOf((await s.call("manage_invoice", invoiceArgs())).text);
    const other = await s.call("manage_invoice", { ...invoiceArgs(invoiceXml({ number: "TESZT-MASIK" })), confirmation_id: id });
    assert.match(other.text, /nothing sent.*más paraméterekhez/);
    const id2 = idOf((await s.call("manage_invoice", invoiceArgs())).text);
    const wrongTool = await s.call("manage_annulment", { ...annulArgs(), confirmation_id: id2 });
    assert.match(wrongTool.text, /nothing sent.*más eszközhöz/);
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

test("the confirmation store: an id is bound to its tool, even with the same arguments", () => {
  const store = new ConfirmationStore();
  const args = { operations: [{ index: 1 }] };
  assert.equal(store.consume(store.issue("manage_invoice", args), "manage_annulment", args), "mismatch");
  assert.equal(store.consume(store.issue("manage_invoice", args), "manage_invoice", { ...args, confirmation_id: "x" }), "ok");
});

test("without elicitation: the id expires after five minutes", async () => {
  await withMockNav(REPLIES, async (calls) => {
    let t = 1_000_000;
    const s = await session(calls, { now: () => t });
    const id = idOf((await s.call("manage_annulment", annulArgs())).text);
    t += CONFIRMATION_TTL_MS + 1;
    const late = await s.call("manage_annulment", { ...annulArgs(), confirmation_id: id });
    assert.match(late.text, /nothing sent.*lejárt/);
    assert.deepEqual(s.sent(), []);
    await s.close();
  });
});

test("the read-only tools ask nothing", async () => {
  await withMockNav({ queryTaxpayer: { root: "QueryTaxpayerResponse", inner: "<taxpayerValidity>true</taxpayerValidity>" } }, async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call("query_taxpayer", { taxNumber: PARTNER_TAX });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(s.asked, []);
    assert.deepEqual(s.sent(), ["queryTaxpayer"]);
    await s.close();
  });
});

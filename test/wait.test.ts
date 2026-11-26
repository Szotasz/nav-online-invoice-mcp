// submit_and_wait (src/wait.ts): the same confirmation as manage_invoice, then a bounded wait on queryTransactionStatus.
// Everything runs on the mock NAV layer with a fake clock: a pause only moves the clock, so no test waits for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import { getConfig } from "../src/config.js";
import { registerTools, formatResponse } from "../src/tools.js";
import { ConfirmationStore } from "../src/confirm.js";
import { CALL_BUDGET_MS, MAX_WAIT_MS, submitAndWait, waitForResult, type WaitDeps } from "../src/wait.js";
import {
  FAKE, accept, annulmentXml, b64, connectClient, invoiceXml, textOf, tokenExchangeOk, withMockNav, type Elicit, type NavCall, type Reply,
} from "./helpers.js";

const TX = "TESZTTX000000001";
const { NAV_ENV: _omit, ...NO_ENV } = FAKE;

type Msg = { code: string; errorCode?: string; message?: string };
type Row = { index: number; status: string; business?: Msg[]; technical?: Msg[] };

const msgXml = (tag: string, m: Msg) =>
  `<${tag}><validationResultCode>${m.code}</validationResultCode>` +
  (m.errorCode ? `<validationErrorCode>${m.errorCode}</validationErrorCode>` : "") +
  (m.message ? `<message>${m.message}</message>` : "") + `</${tag}>`;

/** A /queryTransactionStatus answer with one processingResult per row. */
const status = (...rows: Row[]): Reply => ({
  root: "QueryTransactionStatusResponse",
  inner: "<processingResults>" + rows.map((r) =>
    `<processingResult><index>${r.index}</index><invoiceStatus>${r.status}</invoiceStatus>` +
    (r.technical ?? []).map((m) => msgXml("technicalValidationMessages", m)).join("") +
    (r.business ?? []).map((m) => msgXml("businessValidationMessages", m)).join("") +
    `<compressedContentIndicator>false</compressedContentIndicator></processingResult>`).join("") + "</processingResults>",
});

const replies = (statuses: Reply[]): Record<string, Reply | Reply[]> => ({
  tokenExchange: tokenExchangeOk(),
  manageInvoice: { root: "ManageInvoiceResponse", inner: `<transactionId>${TX}</transactionId>` },
  queryTransactionStatus: statuses,
});

/** A fake clock: sleep() only moves it, and throws once the signal is aborted. */
function fakeClock(): WaitDeps & { elapsed: () => number; pauses: number[]; advance: (ms: number) => void } {
  let t = 0;
  const pauses: number[] = [];
  return {
    pauses,
    elapsed: () => t,
    advance: (ms) => { t += ms; },
    now: () => t,
    // The clock moves even when the signal is aborted, so a wait that ignored the stop would still reach its limit.
    sleep: async (ms, signal) => {
      pauses.push(ms);
      t += ms;
      if (signal?.aborted) throw signal.reason;
    },
  };
}

const ARGS = (extra: Record<string, unknown> = {}) => ({ operations: [{ index: 1, operation: "CREATE", invoiceData: b64(invoiceXml()) }], ...extra });

async function session(calls: NavCall[], opts: { elicit?: Elicit; config?: Record<string, string>; clock?: WaitDeps } = {}) {
  const clock = opts.clock ?? fakeClock();
  const server = new McpServer({ name: "nav-test", version: "0" });
  registerTools(server, () => getConfig(opts.config ?? FAKE), { store: new ConfirmationStore(), wait: clock });
  const asked: string[] = [];
  const client = await connectClient(undefined, { elicit: opts.elicit, asked, server });
  const call = async (args: Record<string, unknown>, options?: Parameters<typeof client.callTool>[1]) => {
    const r = await client.callTool({ name: "submit_and_wait", arguments: args }, options);
    return { text: textOf(r), isError: r.isError === true };
  };
  const callTool = (name: string, args: Record<string, unknown>, signal: AbortSignal) =>
    client.callTool({ name, arguments: args }, { signal });
  return { call, callTool, asked, sent: () => calls.map((c) => c.endpoint), close: () => client.close() };
}

test("DONE after PROCESSING: the user confirmed the summary, the invoice is sent once, and the answer says accepted", async () => {
  await withMockNav(replies([status({ index: 1, status: "PROCESSING" }), status({ index: 1, status: "DONE" })]), async (calls) => {
    const s = await session(calls, { config: NO_ENV, elicit: accept });
    const r = await s.call(ARGS());
    assert.equal(r.isError, false, r.text);
    assert.match(s.asked[0], /^>>> ÉLES NAV <<< /, "the same summary, the environment first");
    assert.match(r.text, /^## Processed by NAV/);
    assert.ok(r.text.includes(`**Transaction ID**: \`${TX}\``), r.text);
    assert.ok(r.text.includes("- #1: DONE (accepted)"), r.text);
    assert.deepEqual(s.sent(), ["tokenExchange", "manageInvoice", "queryTransactionStatus", "queryTransactionStatus"]);
    await s.close();
  });
});

test("ABORTED: not accepted, with every message", async () => {
  const err = { code: "ERROR", errorCode: "INVALID_TESZT", message: "Teszt hiba" };
  await withMockNav(replies([status({ index: 1, status: "ABORTED", business: [err] })]), async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call(ARGS());
    assert.ok(r.text.includes("- #1: ABORTED (NOT accepted)"), r.text);
    assert.ok(r.text.includes("ERROR INVALID_TESZT: Teszt hiba"), r.text);
    assert.match(r.text, /fix the data and send the same operation again/);
    await s.close();
  });
});

test("DONE with WARN: accepted, and the warning is shown", async () => {
  const warn = { code: "WARN", errorCode: "TESZT_FIGYELMEZTETES", message: "Teszt figyelmeztetés" };
  await withMockNav(replies([status({ index: 1, status: "DONE", business: [warn] })]), async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call(ARGS());
    assert.ok(r.text.includes("- #1: DONE (accepted, with messages: check them)"), r.text);
    assert.ok(r.text.includes("WARN TESZT_FIGYELMEZTETES: Teszt figyelmeztetés"), r.text);
    await s.close();
  });
});

for (const open of ["RECEIVED", "PROCESSING", "SAVED"]) {
  test(`${open} is not final: the wait ends at the limit with the transaction ID, not as an error`, async () => {
    await withMockNav(replies([status({ index: 1, status: open })]), async (calls) => {
      const clock = fakeClock();
      const s = await session(calls, { elicit: accept, clock });
      const r = await s.call(ARGS());
      assert.equal(r.isError, false);
      assert.match(r.text, /^## Sent, processing not finished yet/);
      assert.ok(r.text.includes(`**Transaction ID**: \`${TX}\``), r.text);
      assert.ok(r.text.includes(`- #1: ${open} (not finished)`), r.text);
      assert.ok(r.text.includes(`query_transaction_status (transactionId \`${TX}\`)`), r.text);
      assert.equal(clock.elapsed(), MAX_WAIT_MS, "the wait stops exactly at the limit");
      assert.deepEqual(clock.pauses.slice(0, 5), [1000, 2000, 4000, 8000, 8000], "a growing pause, capped");
      assert.equal(s.sent().filter((e) => e === "manageInvoice").length, 1, "sent once");
      await s.close();
    });
  });
}

test("maxWaitSeconds lowers the wait; above 45 it is refused before anything is sent", async () => {
  await withMockNav(replies([status({ index: 1, status: "PROCESSING" })]), async (calls) => {
    const clock = fakeClock();
    const s = await session(calls, { elicit: accept, clock });
    const r = await s.call(ARGS({ maxWaitSeconds: 5 }));
    assert.equal(clock.elapsed(), 5000);
    assert.match(r.text, /within 5 s/);
    const sentBefore = s.sent().length;
    const over = await s.call(ARGS({ maxWaitSeconds: 46 }));
    assert.equal(over.isError, true);
    assert.equal(s.sent().length, sentBefore, "nothing more was sent");
    await s.close();
  });
});

// The client's request timeout runs from when it sent tools/call: the confirmation and the submission count too.
test("the wait gets what is left of the 50 s call budget after a slow confirmation", async () => {
  await withMockNav(replies([status({ index: 1, status: "PROCESSING" })]), async (calls) => {
    const clock = fakeClock();
    // the user takes 30 s to confirm
    const s = await session(calls, { clock, elicit: () => { clock.advance(30_000); return { action: "accept", content: { confirm: true } }; } });
    const r = await s.call(ARGS());
    assert.equal(clock.elapsed(), CALL_BUDGET_MS, "the call ends at the budget, not at 30 + 45 s");
    assert.match(r.text, /within 20 s/);
    await s.close();
  });
});

for (const took of [50_000, 55_000]) {
  test(`a confirmation that used up the call budget (${took / 1000} s): nothing is sent, ask again`, async () => {
    await withMockNav(replies([status({ index: 1, status: "DONE" })]), async (calls) => {
      const clock = fakeClock();
      const s = await session(calls, { clock, elicit: () => { clock.advance(took); return { action: "accept", content: { confirm: true } }; } });
      const r = await s.call(ARGS());
      assert.equal(r.isError, true);
      assert.match(r.text, /^Nem küldtem semmit a NAV-nak \(nothing sent\): .*kérd újra/);
      assert.deepEqual(s.sent(), [], "the mock NAV log is empty");
      await s.close();
    });
  });
}

test("budget used up during the submission itself: sent, no status query, the transaction ID at once", async () => {
  await withMockNav(replies([status({ index: 1, status: "DONE" })]), async (calls) => {
    // the clock jumps past the budget while the submission runs (after tokenExchange and manageInvoice)
    const deps: WaitDeps = { now: () => (calls.length >= 2 ? CALL_BUDGET_MS + 1_000 : 0), sleep: async () => {} };
    const r = await submitAndWait(getConfig(FAKE), { operations: ARGS().operations, compressed: false }, undefined, formatResponse, deps, 0);
    const text = textOf(r);
    assert.match(text, /^## Sent, processing not finished yet/);
    assert.ok(text.includes(`**Transaction ID**: \`${TX}\``), text);
    assert.match(text, /had no time left to wait/);
    assert.deepEqual(calls.map((c) => c.endpoint), ["tokenExchange", "manageInvoice"]);
  });
});

test("submitAndWait itself sends nothing when the call is already cancelled (a second line behind withConfirmation)", async () => {
  await withMockNav(replies([status({ index: 1, status: "DONE" })]), async (calls) => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { mcpReq: { signal: controller.signal, _meta: {}, notify: async () => {} } } as unknown as Parameters<typeof submitAndWait>[2];
    const r = await submitAndWait(getConfig(FAKE), { operations: ARGS().operations, compressed: false }, ctx, formatResponse, fakeClock());
    assert.match(textOf(r), /^Nem küldtem semmit a NAV-nak \(nothing sent\)/);
    assert.deepEqual(calls, []);
  });
});

// The client gives up the call while the user decides: it sends notifications/cancelled, then the user's accept
// arrives. Nothing may be sent, by any of the three write tools.
for (const [tool, args] of [
  ["submit_and_wait", ARGS()],
  ["manage_invoice", ARGS()],
  ["manage_annulment", { operations: [{ index: 1, annulmentData: b64(annulmentXml()) }] }],
] as const) {
  test(`${tool}: a call cancelled during the confirmation sends nothing`, async () => {
    await withMockNav(replies([status({ index: 1, status: "DONE" })]), async (calls) => {
      const controller = new AbortController();
      const s = await session(calls, { elicit: () => { controller.abort(); return { action: "accept", content: { confirm: true } }; } });
      const server = s;
      await assert.rejects(s.callTool(tool, args, controller.signal));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(server.sent(), [], "the mock NAV log is empty");
      await s.close();
    });
  });
}

test("maxWaitSeconds still wins when it is shorter than what is left", async () => {
  await withMockNav(replies([status({ index: 1, status: "PROCESSING" })]), async (calls) => {
    const clock = fakeClock();
    const s = await session(calls, { clock, elicit: () => { clock.advance(10_000); return { action: "accept", content: { confirm: true } }; } });
    await s.call(ARGS({ maxWaitSeconds: 5 }));
    assert.equal(clock.elapsed(), 15_000);
    await s.close();
  });
});

test("a batch waits until every invoice is final", async () => {
  const two = { operations: [1, 2].map((index) => ({ index, operation: "CREATE", invoiceData: b64(invoiceXml({ number: `TESZT-000${index}` })) })) };
  await withMockNav(replies([
    status({ index: 1, status: "DONE" }),
    status({ index: 1, status: "DONE" }, { index: 2, status: "PROCESSING" }),
    status({ index: 1, status: "DONE" }, { index: 2, status: "DONE" }),
  ]), async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call(two);
    assert.match(r.text, /^## Processed by NAV/);
    assert.ok(r.text.includes("- #2: DONE (accepted)"), r.text);
    assert.equal(s.sent().filter((e) => e === "queryTransactionStatus").length, 3);
    await s.close();
  });
});

const DECLINED: Array<[string, Elicit]> = [
  ["a decline", () => ({ action: "decline" })],
  ["a cancel", () => ({ action: "cancel" })],
  ["a failed confirmation request", () => new Error("client gone")],
];
for (const [label, elicit] of DECLINED) {
  test(`${label}: nothing is sent and nothing is waited for`, async () => {
    await withMockNav(replies([status({ index: 1, status: "DONE" })]), async (calls) => {
      const clock = fakeClock();
      const s = await session(calls, { elicit, clock });
      const r = await s.call(ARGS());
      assert.match(r.text, /nothing sent/);
      assert.deepEqual(s.sent(), []);
      assert.equal(clock.elapsed(), 0);
      await s.close();
    });
  });
}

test("without elicitation: the first call only summarises (ÉLES first without NAV_ENV); the id sends and waits", async () => {
  await withMockNav(replies([status({ index: 1, status: "DONE" })]), async (calls) => {
    const s = await session(calls, { config: NO_ENV });
    const first = await s.call(ARGS());
    assert.match(first.text, /^>>> ÉLES NAV <<< /);
    assert.deepEqual(s.sent(), []);
    const id = /confirmation_id: "([^"]+)"/.exec(first.text)?.[1];
    assert.ok(id);
    const second = await s.call(ARGS({ confirmation_id: id }));
    assert.match(second.text, /^## Processed by NAV/);
    assert.deepEqual(s.sent(), ["tokenExchange", "manageInvoice", "queryTransactionStatus"]);
    await s.close();
  });
});

test("a confirmation_id of manage_invoice does not work for submit_and_wait", async () => {
  await withMockNav(replies([status({ index: 1, status: "DONE" })]), async (calls) => {
    const server = new McpServer({ name: "nav-test", version: "0" });
    registerTools(server, () => getConfig(FAKE), { wait: fakeClock() });
    const client = await connectClient(undefined, { server });
    const first = textOf(await client.callTool({ name: "manage_invoice", arguments: ARGS() }));
    const id = /confirmation_id: "([^"]+)"/.exec(first)?.[1];
    const r = textOf(await client.callTool({ name: "submit_and_wait", arguments: ARGS({ confirmation_id: id }) }));
    assert.match(r, /nothing sent.*más eszközhöz/);
    assert.deepEqual(calls, []);
    await client.close();
  });
});

test("progress: one notification per status query, naming what is still open", async () => {
  await withMockNav(replies([status({ index: 1, status: "PROCESSING" }), status({ index: 1, status: "DONE" })]), async (calls) => {
    const s = await session(calls, { elicit: accept });
    const progress: Array<{ progress: number; message?: string }> = [];
    await s.call(ARGS(), { onprogress: (p) => { progress.push({ progress: p.progress, message: p.message }); } });
    assert.deepEqual(progress, [
      { progress: 1, message: "query 1: #1 PROCESSING" },
      { progress: 2, message: "query 2: all invoices final" },
    ]);
    await s.close();
  });
});

test("submission refused by NAV: the error is shown and nothing is waited for", async () => {
  await withMockNav({
    tokenExchange: tokenExchangeOk(),
    manageInvoice: { root: "ManageInvoiceResponse", funcCode: "ERROR", errorCode: "INVALID_REQUEST", message: "Teszt hibaüzenet" },
    queryTransactionStatus: status({ index: 1, status: "DONE" }),
  }, async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call(ARGS());
    assert.equal(r.isError, true);
    assert.match(r.text, /^## Error/);
    assert.deepEqual(s.sent(), ["tokenExchange", "manageInvoice"]);
    await s.close();
  });
});

test("a failed status query ends the wait, and says the data was sent", async () => {
  await withMockNav(replies([{ root: "QueryTransactionStatusResponse", funcCode: "ERROR", errorCode: "TESZT_HIBA", message: "Teszt" }]), async (calls) => {
    const s = await session(calls, { elicit: accept });
    const r = await s.call(ARGS());
    assert.match(r.text, /^## Sent, but the status query failed/);
    assert.ok(r.text.includes(`**Transaction ID**: \`${TX}\``), r.text);
    assert.match(r.text, /The data was sent to NAV\. Asking for its status failed: TESZT_HIBA: Teszt/);
    assert.ok(r.text.includes(`query_transaction_status (transactionId \`${TX}\`)`), r.text);
    await s.close();
  });
});

// A time limit, so a wait that ignores the stop fails this test instead of hanging the run.
test("stopping the wait (abort): the answer says the data was already sent, with the transaction ID", { timeout: 10_000 }, async () => {
  await withMockNav(replies([status({ index: 1, status: "PROCESSING" })]), async (calls) => {
    const controller = new AbortController();
    const clock = fakeClock();
    const ctx = {
      mcpReq: {
        signal: controller.signal,
        _meta: {},
        notify: async () => {},
      },
    } as unknown as Parameters<typeof submitAndWait>[2];
    // the user stops the wait after the second status query
    const stopping: WaitDeps = { now: clock.now, sleep: async (ms, signal) => {
      if (calls.filter((c) => c.endpoint === "queryTransactionStatus").length === 2) controller.abort(new Error("stopped"));
      return clock.sleep(ms, signal);
    } };
    const r = await submitAndWait(getConfig(FAKE), { operations: ARGS().operations, compressed: false }, ctx, formatResponse, stopping);
    const text = textOf(r);
    assert.match(text, /^## Waiting stopped/);
    assert.ok(text.includes(`**Transaction ID**: \`${TX}\``), text);
    assert.match(text, /The data was already sent to NAV\. Stopping the wait does not recall it\./);
    assert.ok(text.includes(`query_transaction_status (transactionId \`${TX}\`)`), text);
    assert.equal(calls.filter((c) => c.endpoint === "queryTransactionStatus").length, 2, "no query after the stop");
  });
});

test("waitForResult: an invoice missing from the answer is not final yet", async () => {
  let n = 0;
  const client = { queryTransactionStatus: async () => ({
    result: { funcCode: "OK" }, rawXml: "",
    data: { processingResults: { processingResult: n++ ? [{ index: "1", invoiceStatus: "DONE" }, { index: "2", invoiceStatus: "DONE" }] : [{ index: "1", invoiceStatus: "DONE" }] } },
  }) };
  const out = await waitForResult(client as never, TX, 2, { maxWaitMs: MAX_WAIT_MS }, fakeClock());
  assert.equal(out.kind, "final");
  assert.equal(out.polls, 2);
});

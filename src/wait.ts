import type { ServerContext } from "@modelcontextprotocol/server";
import { NOTHING_SENT } from "./confirm.js";
import { NavClient } from "./nav-client.js";
import type { SentLedger } from "./sent.js";
import type { NavConfig } from "./types.js";

// submit_and_wait: manage_invoice's submission (behind the same confirmation, see src/tools.ts), then a bounded wait
// for NAV's processing result. NAV processes the invoice data asynchronously: the submission returns a transaction ID,
// and the result per invoice comes from /queryTransactionStatus (the read-submission-status skill).
//
// The wait runs inside the one tools/call request. MCP Tasks would fit it better, but the server SDK has no Tasks
// runtime: @modelcontextprotocol/server 2.4.0 describes task methods as "2025-11-25 wire vocabulary with no SDK
// runtime", and @modelcontextprotocol/ext-tasks 0.2.3 receives tasks on the client side only (sampling, elicitation).
// When either one can receive task-augmented tools/call on the server, waitForResult() can run inside a task as is.

/**
 * The longest wait. It stays below the client's request timeout, so the answer arrives before the client gives up:
 * DEFAULT_REQUEST_TIMEOUT_MSEC is 60000 in @modelcontextprotocol/client 2.4.0 (and in the server package of the same
 * version). A caller can only lower it (maxWaitSeconds). Progress notifications are sent, but a client is not relied on
 * to extend its timeout because of them.
 */
export const MAX_WAIT_MS = 45_000;
/**
 * The whole call's budget. The client's request timeout runs from the moment it sends tools/call, so the time the
 * user spends on the confirmation and the submission itself count too: the wait gets what is left of this budget, at
 * most MAX_WAIT_MS. With no time left, the answer comes at once (the transaction ID, "not finished"), so it still
 * arrives before the client gives up and the model does not send the invoice again.
 */
export const CALL_BUDGET_MS = 50_000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

export interface WaitDeps {
  /** Waits `ms`, or rejects when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

export const realDeps: WaitDeps = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  now: Date.now,
};

export interface InvoiceMessage {
  code: string;
  errorCode?: string;
  message?: string;
}
export interface InvoiceResult {
  index: string;
  status: string;
  messages: InvoiceMessage[];
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const str = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

/** The per-invoice results of a /queryTransactionStatus answer. */
export function invoiceResults(data: Record<string, unknown> | undefined): InvoiceResult[] {
  const results = (data?.processingResults as Record<string, unknown> | undefined)?.processingResult;
  return list(results).map((r) => {
    const row = r as Record<string, unknown>;
    const messages = [...list(row.technicalValidationMessages), ...list(row.businessValidationMessages)].map((m) => {
      const msg = m as Record<string, unknown>;
      return { code: str(msg.validationResultCode) ?? "?", errorCode: str(msg.validationErrorCode), message: str(msg.message) };
    });
    return { index: str(row.index) ?? "?", status: str(row.invoiceStatus) ?? "?", messages };
  });
}

/** DONE and ABORTED are the only final states ([SPEC] 1.8.8.2, point 3). */
const isFinal = (r: InvoiceResult) => r.status === "DONE" || r.status === "ABORTED";

export type WaitOutcome =
  | { kind: "final"; results: InvoiceResult[]; polls: number }
  | { kind: "timeout"; results: InvoiceResult[]; polls: number }
  | { kind: "aborted"; results: InvoiceResult[]; polls: number }
  | { kind: "query-error"; results: InvoiceResult[]; polls: number; error: string };

/**
 * Asks for the transaction's status, with a growing pause (1, 2, 4, 8, 8, ... s), until every invoice is final, the
 * wait reaches `maxWaitMs`, or `signal` aborts. `expected` is the number of operations sent.
 */
export async function waitForResult(
  client: Pick<NavClient, "queryTransactionStatus">,
  transactionId: string,
  expected: number,
  opts: { maxWaitMs: number; signal?: AbortSignal; onPoll?: (polls: number, results: InvoiceResult[]) => Promise<void> | void },
  deps: WaitDeps = realDeps,
): Promise<WaitOutcome> {
  const deadline = deps.now() + opts.maxWaitMs;
  let delay = FIRST_DELAY_MS;
  let polls = 0;
  let results: InvoiceResult[] = [];
  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { kind: "timeout", results, polls };
    try {
      await deps.sleep(Math.min(delay, remaining), opts.signal);
    } catch {
      return { kind: "aborted", results, polls };
    }
    if (opts.signal?.aborted) return { kind: "aborted", results, polls };
    let answer;
    try {
      answer = await client.queryTransactionStatus(transactionId);
    } catch (err) {
      return { kind: "query-error", results, polls, error: err instanceof Error ? err.message : String(err) };
    }
    polls++;
    if (answer.result.funcCode !== "OK") {
      return { kind: "query-error", results, polls, error: [answer.result.errorCode, answer.result.message].filter(Boolean).join(": ") };
    }
    results = invoiceResults(answer.data);
    await opts.onPoll?.(polls, results);
    if (results.length >= expected && results.every(isFinal)) return { kind: "final", results, polls };
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

/** One line per invoice: the status, what it means (only DONE is an acceptance), and every message. */
function resultLines(results: InvoiceResult[]): string[] {
  if (!results.length) return ["- no result per invoice yet"];
  return results.map((r) => {
    const verdict =
      r.status === "DONE"
        ? r.messages.length ? "accepted, with messages: check them" : "accepted"
        : r.status === "ABORTED"
          ? "NOT accepted"
          : "not finished";
    const msgs = r.messages.map((m) => `\n    - ${m.code}${m.errorCode ? ` ${m.errorCode}` : ""}${m.message ? `: ${m.message}` : ""}`).join("");
    return `- #${r.index}: ${r.status} (${verdict})${msgs}`;
  });
}

const statusHint = (tx: string) => `Ask for the status with query_transaction_status (transactionId \`${tx}\`).`;

export function formatOutcome(transactionId: string, outcome: WaitOutcome, maxWaitMs: number): string {
  const head = `**Transaction ID**: \`${transactionId}\``;
  switch (outcome.kind) {
    case "final":
      return ["## Processed by NAV", head, "", ...resultLines(outcome.results),
        "", "Only DONE is an acceptance. ABORTED was not accepted: fix the data and send the same operation again."].join("\n");
    case "timeout":
      return ["## Sent, processing not finished yet", head,
        outcome.polls === 0
          ? "The data was sent to NAV. This call had no time left to wait for the result (the confirmation took most of it)."
          : `The data was sent to NAV. NAV has not finished processing it within ${Math.round(maxWaitMs / 1000)} s.`,
        "", "Last status per invoice:", ...resultLines(outcome.results), "", statusHint(transactionId)].join("\n");
    case "aborted":
      return ["## Waiting stopped", head,
        "The data was already sent to NAV. Stopping the wait does not recall it.",
        "", "Last status per invoice:", ...resultLines(outcome.results), "", statusHint(transactionId)].join("\n");
    case "query-error":
      return ["## Sent, but the status query failed", head,
        `The data was sent to NAV. Asking for its status failed: ${outcome.error}`,
        "", statusHint(transactionId)].join("\n");
  }
}

/** The part after the confirmation: send, then wait. */
export async function submitAndWait(
  config: NavConfig,
  args: { operations: Array<{ index: number; operation: string; invoiceData: string; electronicInvoiceHash?: string }>; compressed: boolean; maxWaitSeconds?: number },
  ctx: Pick<ServerContext, "mcpReq"> | undefined,
  formatSubmission: (result: { funcCode: string; errorCode?: string; message?: string }, data: unknown, rawXml?: string) => string,
  deps: WaitDeps = realDeps,
  /** When the tools/call started (deps.now()); the call budget counts from here. */
  startedAt: number = deps.now(),
  /** Where the transaction ID is recorded as soon as NAV gives it, before the wait (src/sent.ts). */
  ledger?: SentLedger,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  // The budget already used up (a slow confirmation) or the call given up: the client is not waiting for an answer any
  // more, so a transaction ID would reach nobody. Nothing is sent.
  if (ctx?.mcpReq.signal.aborted || deps.now() - startedAt >= CALL_BUDGET_MS) {
    return {
      content: [{ type: "text", text: `${NOTHING_SENT}: a megerősítés túl sokáig tartott, ennek a hívásnak lejárt az ideje; kérd újra.` }],
      isError: true,
    };
  }
  const client = new NavClient(config);
  const { result, data, rawXml, transactionId } = await client.manageInvoice(args.operations, args.compressed);
  if (!transactionId) {
    // Not taken in: the same answer as manage_invoice, and nothing to wait for. A transaction ID means NAV took the
    // data in, whatever else the answer says, so then the wait runs and the result per invoice decides.
    return { content: [{ type: "text", text: formatSubmission(result, data, rawXml) }], isError: true };
  }
  ledger?.record(args.operations, args.compressed, transactionId);
  const left = CALL_BUDGET_MS - (deps.now() - startedAt);
  const maxWaitMs = Math.max(0, Math.min(MAX_WAIT_MS, (args.maxWaitSeconds ?? Infinity) * 1000, left));
  const progressToken = ctx?.mcpReq._meta?.progressToken;
  const outcome = await waitForResult(client, transactionId, args.operations.length, {
    maxWaitMs,
    signal: ctx?.mcpReq.signal,
    onPoll: async (polls, results) => {
      if (progressToken === undefined || !ctx) return;
      const open = results.filter((r) => !isFinal(r)).map((r) => `#${r.index} ${r.status}`).join(", ");
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress: polls, message: `query ${polls}: ${open || "all invoices final"}` },
      }).catch(() => {});
    },
  }, deps);
  return { content: [{ type: "text", text: formatOutcome(transactionId, outcome, maxWaitMs) }] };
}

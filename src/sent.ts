import { NOTHING_SENT, argsKey } from "./confirm.js";

// The invoice data this server already sent, by content, with its transaction ID. A client that gives up a call (a
// cancel, or a request timeout shorter than the wait) never shows the model the answer with the transaction ID, so
// the model may send the same data again. While an entry lives, an identical manage_invoice or submit_and_wait sends
// nothing and returns the transaction ID instead, before any confirmation is asked.
//
// The record lives in memory only: after a server restart it is empty, and the same data can be sent again (with the
// confirmation, as always). Only a submission NAV took in (one with a transaction ID) is recorded.
//
// Two identical calls at the same time (parallel tool calls): the first one marks the data as pending before its
// confirmation, and the other one sends nothing while it is pending. The mark goes when that call ends, whatever the
// outcome (sent, declined, refused, failed).

export const RESEND_GUARD_MS = 30 * 60 * 1000;

export interface SentEntry {
  transactionId: string;
  at: number;
}

type Operations = ReadonlyArray<Record<string, unknown>>;

export class SentLedger {
  private sent = new Map<string, SentEntry>();
  private pending = new Set<string>();
  constructor(private now: () => number = Date.now) {}

  /** The same key for both tools: the operations and the compression flag, nothing else. */
  private key(operations: Operations, compressed: boolean): string {
    return argsKey({ operations, compressed });
  }

  record(operations: Operations, compressed: boolean, transactionId: string): void {
    this.sent.set(this.key(operations, compressed), { transactionId, at: this.now() });
  }

  find(operations: Operations, compressed: boolean): SentEntry | undefined {
    const t = this.now();
    for (const [k, e] of this.sent) if (t - e.at > RESEND_GUARD_MS) this.sent.delete(k);
    return this.sent.get(this.key(operations, compressed));
  }

  /** Marks the data as being sent by a call; false when another call already does it. Pair with end(). */
  begin(operations: Operations, compressed: boolean): boolean {
    const k = this.key(operations, compressed);
    if (this.pending.has(k)) return false;
    this.pending.add(k);
    return true;
  }

  end(operations: Operations, compressed: boolean): void {
    this.pending.delete(this.key(operations, compressed));
  }

  /** The answer while an identical call is still running: nothing sent by this one. */
  inProgress(): { content: Array<{ type: "text"; text: string }> } {
    return {
      content: [{
        type: "text",
        text: `${NOTHING_SENT}: pontosan ezt az adatot egy másik hívás épp most küldi (vagy a megerősítésére vár). ` +
          `Annak az eredményét várd meg; a transactionId abban lesz, a státuszt utána a query_transaction_status-szal kérdezd.`,
      }],
    };
  }

  /** The answer to an identical submission: nothing sent, the earlier transaction ID. Not an error. */
  alreadySent(entry: SentEntry): { content: Array<{ type: "text"; text: string }> } {
    const minutes = Math.max(0, Math.round((this.now() - entry.at) / 60000));
    return {
      content: [{
        type: "text",
        text: `${NOTHING_SENT}: pontosan ezt az adatot ${minutes} perce már elküldtem a NAV-nak.\n` +
          `**Transaction ID**: \`${entry.transactionId}\`\n` +
          `Ugyanazt ${RESEND_GUARD_MS / 60000} percen belül még egyszer nem küldöm. A feldolgozás eredményét a ` +
          `query_transaction_status-szal kérdezd. Ha a NAV elutasította (ABORTED), javítsd az adatot, és a javítottat küldd.`,
      }],
    };
  }
}

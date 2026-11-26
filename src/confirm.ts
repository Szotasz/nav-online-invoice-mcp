import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

// A confirmation step in front of the two tools that send data to NAV (manage_invoice, manage_annulment). The same
// pattern as billingo-mcp:
//
// - When the client supports form elicitation, the server asks the user directly (elicitation/create) with a summary
//   of what is about to be sent, and runs the tool only on an explicit accept with "confirm" checked. A decline, a
//   cancel, a failed or timed-out elicitation request runs nothing.
// - When the client does not support elicitation, the tool does not run silently either (fail closed). The first call
//   returns the summary and a one-time confirmation_id; a second call with the same arguments plus that id runs it.
//   The id is single-use, bound to the tool and to the exact arguments, and expires after CONFIRMATION_TTL_MS.
// - When there is no summary (the XML cannot be read, the configuration is missing), nothing is asked and nothing runs.
//
// Every answer that did not run the tool says "nothing sent", so the caller cannot mistake it for a submission.

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export const NOTHING_SENT = "Nem küldtem semmit a NAV-nak (nothing sent)";

export const confirmationIdSchema = z
  .string()
  .optional()
  .describe(
    "Only for a client without confirmation support: the confirmation_id the first call returned. Pass it only after the user has seen the summary and explicitly approved it.",
  );

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface Pending {
  tool: string;
  argsKey: string;
  expiresAt: number;
}

/** A stable key for the arguments: sorted keys, the confirmation id left out. */
export function argsKey(args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .filter((k) => k !== "confirmation_id")
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(args));
}

export class ConfirmationStore {
  private pending = new Map<string, Pending>();
  constructor(private now: () => number = Date.now) {}

  issue(tool: string, args: Record<string, unknown>): string {
    this.sweep();
    const id = randomBytes(12).toString("base64url");
    this.pending.set(id, { tool, argsKey: argsKey(args), expiresAt: this.now() + CONFIRMATION_TTL_MS });
    return id;
  }

  /** Consumes the id: "ok" only for this tool, these arguments, before expiry; the id is gone either way. */
  consume(id: string, tool: string, args: Record<string, unknown>): "ok" | "unknown" | "expired" | "mismatch" {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p) return "unknown";
    if (this.now() > p.expiresAt) return "expired";
    if (p.tool !== tool || p.argsKey !== argsKey(args)) return "mismatch";
    return "ok";
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, p] of this.pending) if (t > p.expiresAt) this.pending.delete(k);
  }
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface ConfirmOptions<A extends Record<string, unknown>> {
  server: McpServer;
  store: ConfirmationStore;
  tool: string;
  /** The summary the user sees before anything is sent. Throws when there is nothing to show; then nothing runs. */
  describe: (args: A) => string;
  /** Runs the tool; `ctx` is the request context (abort signal, progress), when the SDK passes one. */
  run: (args: A, ctx?: ServerContext) => Promise<ToolResult>;
  /** The elicitation request timeout; the SDK default when not set. */
  elicitationTimeoutMs?: number;
}

/** Wraps a tool handler with the confirmation step. */
export function withConfirmation<A extends Record<string, unknown>>(o: ConfirmOptions<A>) {
  return async (args: A, ctx?: ServerContext): Promise<ToolResult> => {
    const id = typeof args.confirmation_id === "string" ? args.confirmation_id : undefined;
    if (id !== undefined) {
      const verdict = o.store.consume(id, o.tool, args);
      if (verdict === "ok") return o.run(args, ctx);
      const why = {
        unknown: "ismeretlen vagy már felhasznált azonosító",
        expired: "lejárt azonosító",
        mismatch: "az azonosító más eszközhöz vagy más paraméterekhez tartozik",
      }[verdict];
      return text(`${NOTHING_SENT}: a confirmation_id nem érvényes (${why}). Kérj új összefoglalót confirmation_id nélkül.`, true);
    }

    let summary: string;
    try {
      summary = o.describe(args);
    } catch (err) {
      return text(`${NOTHING_SENT}: nem tudom összefoglalni, ezért nem küldöm (${message(err)}).`, true);
    }

    if (o.server.server.getClientCapabilities()?.elicitation?.form) {
      let answer;
      try {
        answer = await o.server.server.elicitInput(
          {
            mode: "form",
            message: summary,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: { type: "boolean", title: "Beküldöd?", description: "Pipáld be, ha a fenti adatokat el kell küldeni a NAV-nak." },
              },
              required: ["confirm"],
            },
          },
          // The call's own signal: a client that gives up the call also ends the open confirmation request.
          { signal: ctx?.mcpReq.signal, ...(o.elicitationTimeoutMs === undefined ? {} : { timeout: o.elicitationTimeoutMs }) },
        );
      } catch (err) {
        return text(`${NOTHING_SENT}: a megerősítés kérése nem sikerült (${message(err)}).`, true);
      }
      if (answer.action === "accept" && answer.content?.confirm === true) {
        // The client may have given up the call while the user decided (its request timeout runs from the start of the
        // call): then nobody would receive the answer, so nothing is sent.
        if (ctx?.mcpReq.signal.aborted) return text(`${NOTHING_SENT}: a hívást a kliens közben megszakította; kérd újra.`, true);
        return o.run(args, ctx);
      }
      return text(
        answer.action === "accept"
          ? `${NOTHING_SENT}: a megerősítés nem volt bepipálva.`
          : `${NOTHING_SENT}: a felhasználó ${answer.action === "decline" ? "elutasította" : "megszakította"} a beküldést.`,
      );
    }

    const issued = o.store.issue(o.tool, args);
    const minutes = Math.round(CONFIRMATION_TTL_MS / 60000);
    return text(
      `${summary}\n\nEz még NEM ment el. ${NOTHING_SENT}. A kliens nem tud megerősítést kérni, ezért mutasd meg ezt az összefoglalót a felhasználónak, ` +
        `és csak az ő kifejezett jóváhagyása után hívd meg újra ugyanezekkel a paraméterekkel, ezzel kiegészítve: confirmation_id: "${issued}" ` +
        `(egyszer használható, ${minutes} percig érvényes).`,
    );
  };
}

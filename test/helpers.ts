// The mock NAV layer: fetch is replaced for the duration of one test, and every NAV endpoint answers from fixed XML.
// Nothing is sent anywhere. All data is made up: the tax numbers fail the Hungarian check digit on purpose
// (12345678 and 87654321 are not valid tax numbers), and every name and invoice number is fictional.
import { createCipheriv } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
 * Afterwards the guard is back in place, whatever happened.
 */
export async function withMockNav<T>(replies: Record<string, Reply>, fn: (calls: NavCall[]) => Promise<T>): Promise<T> {
  const calls: NavCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const endpoint = new URL(url).pathname.split("/").pop() ?? "";
    calls.push({ endpoint, url, body: String(init?.body ?? "") });
    const reply = replies[endpoint];
    if (!reply) throw new Error(`mock NAV: no reply for ${endpoint}`);
    return new Response(navXml(reply), { status: 200, headers: { "Content-Type": "application/xml" } });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = guardedFetch;
  }
}

/** An MCP client connected in memory to the Smithery entry point with the fake configuration. */
export async function connectClient(config: Record<string, string> = FAKE): Promise<Client> {
  const server = createServer({ config });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

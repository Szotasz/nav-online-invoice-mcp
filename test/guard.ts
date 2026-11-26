// Loaded before every test file (`node --import tsx --import ./test/guard.ts --test`, see package.json).
// A test run must never reach NAV: not the production API, and not the NAV test environment either. Every fetch to
// nav.gov.hu or any of its subdomains throws here, before a socket is opened. A test that wants a NAV answer installs
// the mock layer (test/helpers.ts), which answers from fixed XML and never calls through to this guard.

export class NavCallBlocked extends Error {
  constructor(public readonly url: string) {
    super(`NAV call blocked in tests: ${url}`);
    this.name = "NavCallBlocked";
  }
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return String(input);
}

export function isNavHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return false;
  }
  return host === "nav.gov.hu" || host.endsWith(".nav.gov.hu");
}

const realFetch = globalThis.fetch;

export const guardedFetch: typeof fetch = async (input, init) => {
  const url = urlOf(input);
  if (isNavHost(url)) throw new NavCallBlocked(url);
  return realFetch(input, init);
};

globalThis.fetch = guardedFetch;
(globalThis as { __navGuardInstalled?: boolean }).__navGuardInstalled = true;

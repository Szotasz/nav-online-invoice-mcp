// The guard (test/guard.ts) is what keeps a test run away from NAV. These tests prove it is installed and that it
// refuses the production API, the NAV test environment and any other nav.gov.hu host, directly and through a tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavCallBlocked, guardedFetch, isNavHost } from "./guard.js";
import { connectClient, textOf, accept, b64, invoiceXml, FAKE } from "./helpers.js";

test("the guard is installed for every test file", () => {
  assert.equal((globalThis as { __navGuardInstalled?: boolean }).__navGuardInstalled, true);
  assert.equal(globalThis.fetch, guardedFetch);
});

test("a direct fetch to any nav.gov.hu host is refused before a request is made", async () => {
  const urls = [
    "https://api.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer",
    "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer",
    "https://API.ONLINESZAMLA.NAV.GOV.HU/invoiceService/v3/tokenExchange",
    "https://api.onlineszamla.nav.gov.hu./invoiceService/v3/manageInvoice",
    "https://user:pw@api.onlineszamla.nav.gov.hu:443/invoiceService/v3/manageInvoice",
    "https://nav.gov.hu/",
    "http://anything.nav.gov.hu/x",
  ];
  for (const u of urls) {
    await assert.rejects(fetch(u, { method: "POST", body: "<x/>" }), NavCallBlocked, u);
  }
  await assert.rejects(fetch(new URL(urls[0])), NavCallBlocked);
  await assert.rejects(fetch(new Request(urls[1], { method: "POST", body: "<x/>" })), NavCallBlocked);
});

test("lookalike hosts are not NAV (decided without a request)", () => {
  for (const u of ["https://nav.gov.hu.example.org/", "https://evilnav.gov.hu.example/", "https://example.org/nav.gov.hu", "not a url"]) {
    assert.equal(isNavHost(u), false, u);
  }
});

test("a tool call without the mock layer is refused in both NAV environments and on a NAV_BASE_URL override", async () => {
  const configs = [
    { ...FAKE, NAV_ENV: "production" as const },
    { ...FAKE, NAV_ENV: "test" as const },
    { ...FAKE, NAV_BASE_URL: "https://other.nav.gov.hu/invoiceService/v3" },
  ];
  for (const config of configs) {
    // the confirmation is accepted, so the write tool goes as far as the request
    const client = await connectClient(config, { elicit: accept });
    for (const [name, args] of [
      ["query_taxpayer", { taxNumber: "87654321" }],
      ["manage_invoice", { operations: [{ index: 1, operation: "CREATE", invoiceData: b64(invoiceXml()) }] }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      assert.equal(res.isError, true, `${name} ${JSON.stringify(config.NAV_ENV)}`);
      assert.match(textOf(res), /NAV call blocked in tests/);
    }
    await client.close();
  }
});

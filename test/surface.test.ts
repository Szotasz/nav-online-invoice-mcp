// One tool set for both entry points. test/fixtures/surface.json is the tool and prompt list the Smithery entry
// (src/index.ts) served on main 78bd5a0, as an MCP client sees it. Both entry points must serve exactly that: names,
// descriptions, input schemas, annotations and prompts. (Before the merge into src/tools.ts, the CLI served the same
// tools with shorter descriptions; nothing else differed.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectClient } from "./helpers.js";

const ROOT = join(__dirname, "..");
const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "surface.json"), "utf8"));

async function surfaceOf(client: Client) {
  return { tools: (await client.listTools()).tools, prompts: (await client.listPrompts()).prompts, server: client.getServerVersion() };
}

test("the Smithery entry point serves the main surface byte for byte", { timeout: 30_000 }, async () => {
  const client = await connectClient();
  try {
    assert.equal(JSON.stringify(await surfaceOf(client), null, 2), JSON.stringify(FIXTURE, null, 2));
  } finally {
    await client.close();
  }
});

// The client is closed in `finally`: a failed assertion must not leave the server process running, or the test run
// waits for it forever instead of failing.
test("the CLI entry point (stdio) serves the same surface", { timeout: 30_000 }, async () => {
  const client = new Client({ name: "test", version: "0" });
  // Listing tools and prompts makes no NAV request, and no NAV credentials are passed.
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", join(ROOT, "src", "cli.ts")], cwd: ROOT,
    env: { PATH: process.env.PATH ?? "" }, stderr: "ignore",
  }));
  try {
    assert.equal(JSON.stringify(await surfaceOf(client), null, 2), JSON.stringify(FIXTURE, null, 2));
  } finally {
    await client.close();
  }
});

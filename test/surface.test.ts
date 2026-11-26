// One tool set for both entry points. test/fixtures/surface.json is the tool and prompt list the Smithery entry
// (src/index.ts) served on main 78bd5a0, as an MCP client sees it. Both entry points must serve exactly that: names,
// descriptions, input schemas, annotations and prompts. (Before the merge into src/tools.ts, the CLI served the same
// tools with shorter descriptions; nothing else differed.)
// The one change since: the two write tools take an optional confirmation_id (the confirmation step, src/confirm.ts).
// withConfirmationId() adds exactly that to the main surface, so any other drift still fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectClient } from "./helpers.js";

const ROOT = join(__dirname, "..");
const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "surface.json"), "utf8"));
// What the CLI served on main 78bd5a0, before the merge: the same tools with shorter descriptions.
const CLI_MAIN = JSON.parse(readFileSync(join(__dirname, "fixtures", "cli-surface-main.json"), "utf8"));

const CONFIRMATION_ID = {
  type: "string",
  description:
    "Only for a client without confirmation support: the confirmation_id the first call returned. Pass it only after the user has seen the summary and explicitly approved it.",
};

/** The main surface plus the optional confirmation_id of manage_invoice and manage_annulment. */
function withConfirmationId(surface: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }) {
  const copy = JSON.parse(JSON.stringify(surface));
  for (const tool of copy.tools) {
    if (tool.name === "manage_invoice" || tool.name === "manage_annulment") tool.inputSchema.properties.confirmation_id = CONFIRMATION_ID;
  }
  return copy;
}
const EXPECTED = withConfirmationId(FIXTURE);

/** The surface with every `description` removed, at any depth. */
function withoutDescriptions(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(withoutDescriptions);
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "description").map(([k, v]) => [k, withoutDescriptions(v)]));
  }
  return o;
}

async function surfaceOf(client: Client) {
  return { tools: (await client.listTools()).tools, prompts: (await client.listPrompts()).prompts, server: client.getServerVersion() };
}

test("the Smithery entry point serves the main surface byte for byte, plus the confirmation_id", { timeout: 30_000 }, async () => {
  const client = await connectClient();
  try {
    assert.equal(JSON.stringify(await surfaceOf(client), null, 2), JSON.stringify(EXPECTED, null, 2));
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
    const surface = await surfaceOf(client);
    assert.equal(JSON.stringify(surface, null, 2), JSON.stringify(EXPECTED, null, 2));
    // the only changes against the CLI on main: descriptions (tool and parameter texts) and the confirmation_id
    assert.deepEqual(withoutDescriptions(surface), withoutDescriptions(withConfirmationId(CLI_MAIN)));
    assert.notDeepEqual(surface, CLI_MAIN);
  } finally {
    await client.close();
  }
});

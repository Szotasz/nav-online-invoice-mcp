// One tool set for both entry points. test/fixtures/surface.json is the tool and prompt list the Smithery entry
// (src/index.ts) served on main 78bd5a0, as an MCP client sees it. Both entry points must serve exactly that: names,
// descriptions, input schemas, annotations and prompts. (Before the merge into src/tools.ts, the CLI served the same
// tools with shorter descriptions; nothing else differed.)
// The one change since: the two write tools take an optional confirmation_id (the confirmation step, src/confirm.ts).
// withConfirmationId() adds exactly that to the main surface, so any other drift still fails.
// The skill-<name> prompts of the NAV guides come after main's three prompts (withSkillPrompts()).
// The move to SDK v2 (2.4.0, zod 4) changed how the same tools are written out; asServedByV2() applies exactly those
// changes to the main fixture, and the comparison is deep equality, so the key order inside a schema does not count:
//   - inputSchema.$schema is JSON Schema 2020-12 instead of draft-07;
//   - `additionalProperties: false` is no longer emitted. It was never enforced: on v1 and on v2 alike, an unknown
//     argument is accepted and dropped before the handler runs (measured on both);
//   - `execution: { taskSupport: "forbidden" }` is no longer emitted; a tool without `execution` does not support
//     tasks either, so nothing changes for a client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { connectClient, SKILL_NAMES } from "./helpers.js";

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
/** The surface as SDK v2 writes it out: see the header for the three differences. */
function asServedByV2<T>(surface: T): T {
  const copy = JSON.parse(JSON.stringify(surface));
  const dropAdditional = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(dropAdditional);
    else if (o && typeof o === "object") {
      delete (o as Record<string, unknown>).additionalProperties;
      Object.values(o).forEach(dropAdditional);
    }
  };
  for (const tool of copy.tools) {
    tool.inputSchema.$schema = "https://json-schema.org/draft/2020-12/schema";
    dropAdditional(tool.inputSchema);
    delete tool.execution;
  }
  return copy;
}
/**
 * The NAV guides (skills/, src/skills.ts) are also served as prompts named skill-<name>, after the three prompts of
 * main. The names are pinned in test/helpers.ts (SKILL_NAMES); the descriptions are the SKILL.md frontmatter's.
 */
function withSkillPrompts<T extends { prompts: unknown[] }>(surface: T): T {
  const copy = JSON.parse(JSON.stringify(surface));
  for (const name of SKILL_NAMES) {
    const md = readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
    const description = /^description:[ \t]*(.+)$/m.exec(md)?.[1].trim();
    copy.prompts.push({ name: `skill-${name}`, description });
  }
  return copy;
}
const EXPECTED = withSkillPrompts(asServedByV2(withConfirmationId(FIXTURE)));

/** The surface with every `description` removed, at any depth. */
function withoutDescriptions(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(withoutDescriptions);
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "description").map(([k, v]) => [k, withoutDescriptions(v)]));
  }
  return o;
}

// As JSON, the way a client receives it over a real transport: the in-memory transport of v2 passes the objects
// through, keys with an undefined value included (prompt _meta, icons, title), which JSON leaves out.
async function surfaceOf(client: Client) {
  const surface = { tools: (await client.listTools()).tools, prompts: (await client.listPrompts()).prompts, server: client.getServerVersion() };
  return JSON.parse(JSON.stringify(surface));
}

test("the Smithery entry point serves the main surface, plus the confirmation_id, as SDK v2 writes it", { timeout: 30_000 }, async () => {
  const client = await connectClient();
  try {
    assert.deepEqual(await surfaceOf(client), EXPECTED);
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
    assert.deepEqual(surface, EXPECTED);
    // the only changes against the CLI on main: descriptions (tool and parameter texts), the confirmation_id and v2
    assert.deepEqual(withoutDescriptions(surface), withoutDescriptions(withSkillPrompts(asServedByV2(withConfirmationId(CLI_MAIN)))));
    assert.notDeepEqual(surface, CLI_MAIN);
  } finally {
    await client.close();
  }
});

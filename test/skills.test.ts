// The NAV guides in skills/: served as MCP skills and as skill-<name> prompts, on both entry points. Nothing here
// calls the NAV: only listing and reading run, and the guard (test/guard.ts) refuses any NAV request anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { SKILLS_DIR } from "../src/skills.js";
import { connectClient, SKILL_NAMES } from "./helpers.js";

const ROOT = join(__dirname, "..");
const MAIN_PROMPTS = ["check-taxpayer", "invoice-details", "search-invoices"];
const files = () => SKILL_NAMES.map((name) => ({ name, text: readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8") }));

/** Lists and reads every skill through the skills extension, and checks each file against its entry. */
async function checkSkills(client: Client) {
  const skills = new SkillsClient(client);
  assert.equal(skills.supported, true, "the skills extension is declared");
  const { skills: entries } = await skills.list();
  assert.deepEqual(entries.map((e) => e.frontmatter.name).sort(), SKILL_NAMES);
  for (const entry of entries) {
    assert.ok(String(entry.frontmatter.description).length > 80, `${entry.frontmatter.name} has a description`);
    const file = await skills.read(entry);
    assert.equal(file.verified, true, `${entry.frontmatter.name} verifies against its entry`);
    assert.ok(file.body && file.body.length > 500, `${entry.frontmatter.name} has a body`);
  }
}

test("the Smithery entry serves the five skills, and every file verifies against its entry", async () => {
  const client = await connectClient();
  try {
    await checkSkills(client);
  } finally {
    await client.close();
  }
});

test("each skill is also a prompt with a stable name, next to the existing prompts, carrying the body", async () => {
  const client = await connectClient();
  try {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), [...MAIN_PROMPTS, ...SKILL_NAMES.map((s) => `skill-${s}`)].sort());
    for (const { name, text } of files()) {
      const r = await client.getPrompt({ name: `skill-${name}` });
      const body = (r.messages[0].content as { text: string }).text;
      assert.doesNotMatch(body, /^---/, "the prompt carries the body, not the frontmatter");
      assert.ok(text.trimEnd().endsWith(body), `skill-${name} is the SKILL.md body`);
    }
  } finally {
    await client.close();
  }
});

test("the stdio entry (cli.ts) serves the skills and the prompts too", { timeout: 30_000 }, async () => {
  // No NAV credentials are passed: listing and reading make no NAV request.
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", join(ROOT, "src", "cli.ts")], cwd: ROOT,
    env: { PATH: process.env.PATH ?? "" }, stderr: "ignore",
  }));
  try {
    await checkSkills(client);
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, MAIN_PROMPTS.length + SKILL_NAMES.length);
  } finally {
    await client.close();
  }
});

test("every tool a skill names exists, and every skill a skill points to exists", async () => {
  const client = await connectClient();
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  await client.close();
  for (const { name, text } of files()) {
    for (const [, word] of text.matchAll(/`([a-z][a-z_]*)`/g)) {
      if (/^(query|manage|submit)_/.test(word)) assert.ok(tools.has(word), `${name} names a tool that does not exist: ${word}`);
    }
    for (const [, word] of text.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
      assert.ok(SKILL_NAMES.includes(word), `${name} points to a skill that does not exist: ${word}`);
    }
  }
});

test("every skill names its source in the NAV's official repository", () => {
  for (const { name, text } of files()) {
    assert.match(text, /nav-gov-hu\/Online-Invoice/, `${name} names the NAV repository`);
    assert.match(text, /Online_Szamla_interfesz specifikacio_HU_v3\.0\. \(2026\.02\.12\)\.pdf/, `${name} names the specification file`);
  }
});

// A public repository: the guides carry rules, never someone's data. These shapes catch the usual slips.
const FORBIDDEN: Array<[string, RegExp]> = [
  ["a Hungarian tax number", /\b\d{8}(-\d-\d{2})?\b/],
  ["an EU VAT number", /\bHU\d{8}\b/],
  ["an email address", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ["a URL", /https?:\/\//i],
  ["an IBAN or account number", /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b|\b\d{8}-\d{8}(-\d{8})?\b/],
  ["a phone number", /\+\d{2}[\s-]?\d|\b06[\s-]?\d{2}[\s-]?\d{3}/],
  ["a long number (an id, an invoice number, an amount from a real case)", /\d{5,}/],
  ["an invoice number", /\b[A-Z]{2,}[-/ ]+\d{4}[-/ ]+\d+/],
];

test("the skills carry no tax number or other personal or account data", () => {
  const found: string[] = [];
  for (const dir of readdirSync(SKILLS_DIR)) {
    for (const file of readdirSync(join(SKILLS_DIR, dir))) {
      const text = readFileSync(join(SKILLS_DIR, dir, file), "utf8");
      for (const [what, rx] of FORBIDDEN) {
        const m = rx.exec(text);
        if (m) found.push(`${dir}/${file}: ${what} (${JSON.stringify(m[0])})`);
      }
    }
  }
  assert.deepEqual(found, []);
});

test("the forbidden shapes do catch a tax number (the guard is not empty)", () => {
  const caught = (t: string) => FORBIDDEN.some(([, rx]) => rx.test(t));
  for (const sample of ["adószám: 12345678-2-42", "törzsszám 12345678", "HU12345678"]) assert.equal(caught(sample), true, sample);
  assert.equal(caught("the first 8 digits of a tax number"), false);
});

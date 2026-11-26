import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { SkillsExtension, skillEntry, type Skill, type SkillSource } from "@modelcontextprotocol/server/ext/skills";

// The NAV guides (skills/<name>/SKILL.md) served two ways, as in billingo-mcp:
// - as MCP skills (the io.modelcontextprotocol/skills extension): a client that supports skills lists them and loads
//   one when it is needed;
// - as prompts named skill-<name>, for clients that do not support skills yet: every client knows prompts.
//
// Unlike billingo-mcp, both entry points serve them, and the Smithery entry builds its server synchronously. So the
// files are read synchronously here, and the extension is attached from a SkillSource (attach() is synchronous). The
// entries (digests, sizes, the frontmatter checks) are built by the SDK's skillEntry() on the first request.

/** The skills folder: next to src/ and dist/, so it resolves the same from the source and from the build. */
export const SKILLS_DIR = join(__dirname, "..", "skills");

interface SkillFile {
  folder: string;
  markdown: string;
  name: string;
  description: string;
}

/** The frontmatter's name and description (single-line values), and the text after it. */
function parse(folder: string, markdown: string): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!m) throw new Error(`skills/${folder}/SKILL.md has no frontmatter`);
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(m[1])?.[1].trim();
  const name = field("name");
  const description = field("description");
  if (!name || !description) throw new Error(`skills/${folder}/SKILL.md lacks a name or a description`);
  return { name, description, body: markdown.slice(m[0].length).trim() };
}

/** Every skills/<folder>/SKILL.md, sorted by folder. A folder without one is an error, not a silently missing guide. */
function readSkills(dir: string): SkillFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((folder) => {
      const markdown = readFileSync(join(dir, folder, "SKILL.md"), "utf8");
      const { name, description } = parse(folder, markdown);
      return { folder, markdown, name, description };
    });
}

/** Serves the skills on `server`, as skills and as skill-<name> prompts. Call before connect. Returns the names. */
export function registerSkills(server: McpServer, dir: string = SKILLS_DIR): string[] {
  const files = readSkills(dir);
  let entries: Promise<Skill[]> | undefined;
  const all = () => (entries ??= Promise.all(files.map((f) => skillEntry(f.folder, { "SKILL.md": f.markdown }))));
  const source: SkillSource = {
    list: async () => ({ skills: await all() }),
    get: async (uri) => (await all()).find((s) => s.uri === uri),
    read: async (uri) => {
      const i = (await all()).findIndex((s) => s.uri === uri);
      return i < 0 ? undefined : { text: files[i].markdown, mimeType: "text/markdown" };
    },
  };
  new SkillsExtension({ source, strict: true }).attach(server);

  for (const f of files) {
    const text = parse(f.folder, f.markdown).body;
    server.registerPrompt(`skill-${f.name}`, { description: f.description }, () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    }));
  }
  return files.map((f) => f.name);
}

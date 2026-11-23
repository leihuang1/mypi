import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

// What the Pi CLI puts in its system prompt and MyPi did not: repo instructions, the skills list and ponytail.
// Formats follow pi-coding-agent's resource-loader.js and skills.js so prompts read the same in both.

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
// agent-browser: web tools wait for Level 2 isolation (plan: Deferred). ponytail: its rules reach the agent only
// through the ponytail section, so the session toggle can turn them off; its other skills stay listed.
const HELD_BACK_SKILLS = new Set(["agent-browser", "ponytail"]);

export interface ContextFile { path: string; content: string }
export interface Skill { name: string; description: string; filePath: string }

const piAgentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const ponytailDir = () => path.join(piAgentDir(), "git", "github.com", "DietrichGebert", "ponytail");
const userSkillDirs = () => [path.join(os.homedir(), ".agents", "skills"), path.join(ponytailDir(), "skills")];

/** `cwd` and its parents up to the git root, root first; only `cwd` outside a repo. */
function repoDirs(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (fs.existsSync(path.join(dir, ".git"))) return dirs;
    if (path.dirname(dir) === dir) return [path.resolve(cwd)];
  }
}

function readContextFile(dir: string): ContextFile | undefined {
  for (const name of CONTEXT_FILE_NAMES) {
    const filePath = path.join(dir, name);
    try {
      if (fs.statSync(filePath).isFile()) return { path: filePath, content: fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "") };
    } catch {
      // Not there; try the next name.
    }
  }
  return undefined;
}

/** One file per directory (AGENTS.override.md first): the global Pi one, then the repo's from its root down to `cwd`. */
export function loadContextFiles(cwd: string, agentDir = piAgentDir()): ContextFile[] {
  const files = [agentDir, ...repoDirs(cwd)].map(readContextFile).filter((f): f is ContextFile => f !== undefined);
  return [...new Map(files.map((f) => [f.path, f])).values()];
}

// shortcut: reads top-level `key: value` and indented continuations (`>`/`|` blocks), not full YAML; use a YAML parser if a skill needs more.
function frontmatter(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\uFEFF/, ""));
  let key: string | undefined;
  for (const line of block?.[1].split(/\r?\n/) ?? []) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      const raw = field[2].trim();
      const value = /^["']/.test(raw) ? raw.replace(/^(["'])(.*)\1$/, "$2") : raw.replace(/\s+#.*$/, "");
      fields[key] = /^[>|][+-]?$/.test(value) ? "" : value;
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

// shortcut: only `<dir>/<name>/SKILL.md`, not Pi's recursive walk; extend if a nested skills folder shows up.
function skillsIn(dir: string): (Skill & { hidden: boolean })[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const filePath = path.join(dir, name, "SKILL.md");
    let fields: Record<string, string>;
    try {
      fields = frontmatter(fs.readFileSync(filePath, "utf8"));
    } catch {
      return [];
    }
    const description = fields.description ?? "";
    const hidden = /^true$/i.test(fields["disable-model-invocation"] ?? "");
    return description ? [{ name: fields.name || name, description, filePath, hidden }] : [];
  });
}

/**
 * Pi's precedence: cwd's `.pi/skills`, then `.agents/skills` from cwd up to the repo root, then the user folders.
 * The first skill of a name wins, even one that only explicit invocation may load (then it is not listed).
 */
export function loadSkills(cwd: string, userDirs = userSkillDirs()): Skill[] {
  const project = [path.join(cwd, ".pi", "skills"), ...repoDirs(cwd).reverse().map((dir) => path.join(dir, ".agents", "skills"))];
  const byName = new Map<string, Skill & { hidden: boolean }>();
  for (const skill of [...project, ...userDirs].flatMap(skillsIn)) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()]
    .filter((skill) => !skill.hidden && !HELD_BACK_SKILLS.has(skill.name))
    .map(({ name, description, filePath }) => ({ name, description, filePath }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function renderProjectContext(files: ContextFile[]): string | undefined {
  if (files.length === 0) return undefined;
  return [
    "Project-specific instructions and guidelines:",
    ...files.map(({ path: p, content }) => `<project_instructions path="${p}">\n${content}\n</project_instructions>`),
  ].join("\n\n");
}

function renderSkills(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
    ...skills.map((s) =>
      `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.filePath)}</location>\n  </skill>`),
    "</available_skills>",
  ].join("\n");
}

/** The ponytail package's own prompt at its configured default level, as the Pi CLI extension builds it. */
export function ponytailInstructions(dir = ponytailDir()): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const { getDefaultMode } = require(path.join(dir, "hooks", "ponytail-config.js"));
    const { getPonytailInstructions } = require(path.join(dir, "hooks", "ponytail-instructions.js"));
    const mode = getDefaultMode();
    return getPonytailInstructions(mode === "off" ? "full" : mode);
  } catch {
    return undefined; // Ponytail not installed on this host.
  }
}

export function createPiCompatExtension(options: { ponytail: () => boolean }) {
  return defineExtension({
    name: "pi-compat",
    sections: [
      section("project_context", ({ env }) => (env ? renderProjectContext(loadContextFiles(env.cwd)) : undefined), { tag: false }),
      section("skills", ({ env }) => (env ? renderSkills(loadSkills(env.cwd)) : undefined), { tag: false }),
      section("ponytail", () => (options.ponytail() ? ponytailInstructions() : undefined)),
    ],
  });
}

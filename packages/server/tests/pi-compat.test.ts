import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { loadContextFiles, loadSkills, ponytailInstructions } from "../src/extensions/pi-compat.js";

function tree(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-compat-")));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const skill = (name: string, description: string, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}.\n`;

it("discovers context files global first, then repo root down to cwd, one per directory, never above the repo", () => {
  const root = tree({
    "agent/AGENTS.md": "global",
    "AGENTS.md": "above the repo",
    "repo/.git/HEAD": "ref: refs/heads/main\n",
    "repo/CLAUDE.md": "root claude",
    "repo/packages/README.md": "no context file here",
    "repo/packages/app/AGENTS.md": "app agents",
    "repo/packages/app/AGENTS.override.md": "app override",
    "repo/packages/app/CLAUDE.md": "app claude",
  });
  try {
    const files = loadContextFiles(path.join(root, "repo/packages/app"), path.join(root, "agent"));
    assert.deepEqual(files.map((f) => [path.relative(root, f.path), f.content]), [
      ["agent/AGENTS.md", "global"],
      ["repo/CLAUDE.md", "root claude"],
      ["repo/packages/app/AGENTS.override.md", "app override"],
    ]);
    // A worktree's `.git` is a file; it still marks the root.
    fs.rmSync(path.join(root, "repo/.git"), { recursive: true });
    fs.writeFileSync(path.join(root, "repo/.git"), "gitdir: /elsewhere\n");
    assert.equal(loadContextFiles(path.join(root, "repo/packages/app"), path.join(root, "agent")).length, 3);
    // Outside any repo, only cwd's own file.
    fs.rmSync(path.join(root, "repo/.git"));
    assert.deepEqual(
      loadContextFiles(path.join(root, "repo/packages/app"), path.join(root, "none")).map((f) => f.content),
      ["app override"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("lists skills with Pi's precedence (cwd .pi, nearest .agents, user), first name wins, hidden ones left out", () => {
  const root = tree({
    "user/diagnose/SKILL.md": skill("diagnose", "User copy loses."),
    "user/caveman/SKILL.md": "---\nname: caveman\ndescription: >\n  Ultra-compressed\n  communication mode.\nallowed-tools: x\n---\n",
    "user/quoted/SKILL.md": skill("quoted", "\"Use when: it's # quoted\""),
    "user/lint/SKILL.md": skill("lint", "Lint it # a YAML comment"),
    "user/teach/SKILL.md": skill("teach", "Manual only.", "disable-model-invocation: True # explicit only\n"),
    "user/zoom-out/SKILL.md": skill("zoom-out", "Manual only.", "disable-model-invocation: true \t\n"),
    "user/tdd/SKILL.md": skill("tdd", "Enabled copy must not replace the repo's hidden one."),
    "user/agent-browser/SKILL.md": skill("agent-browser", "Browser."),
    "user/ponytail/SKILL.md": skill("ponytail", "Lazy senior dev mode. Use on any coding task."),
    "user/no-description/SKILL.md": "---\nname: no-description\n---\n",
    "user/not-a-skill.md": skill("loose", "Root files are not skills here."),
    "repo/.git/HEAD": "",
    "repo/.agents/skills/diagnose/SKILL.md": skill("diagnose", "Repo copy wins."),
    "repo/.agents/skills/release/SKILL.md": skill("release", "Root copy loses."),
    "repo/.agents/skills/tdd/SKILL.md": skill("tdd", "Explicit only.", "disable-model-invocation: true\n"),
    "repo/.pi/skills/ancestor-pi/SKILL.md": skill("ancestor-pi", "Only cwd's .pi/skills counts."),
    "repo/app/.agents/skills/release/SKILL.md": skill("release", "Nearest copy wins."),
    "repo/app/.pi/skills/deploy/SKILL.md": skill("deploy", "Deploy <app> & check."),
  });
  try {
    const skills = loadSkills(path.join(root, "repo/app"), [path.join(root, "user"), path.join(root, "missing")]);
    assert.deepEqual(skills.map((s) => [s.name, s.description, path.relative(root, s.filePath)]), [
      ["caveman", "Ultra-compressed communication mode.", "user/caveman/SKILL.md"],
      ["deploy", "Deploy <app> & check.", "repo/app/.pi/skills/deploy/SKILL.md"],
      ["diagnose", "Repo copy wins.", "repo/.agents/skills/diagnose/SKILL.md"],
      ["lint", "Lint it", "user/lint/SKILL.md"],
      ["quoted", "Use when: it's # quoted", "user/quoted/SKILL.md"],
      ["release", "Nearest copy wins.", "repo/app/.agents/skills/release/SKILL.md"],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("builds ponytail's prompt with the package's own code, at full when its default is off", () => {
  const root = tree({
    "hooks/ponytail-config.js": "module.exports = { getDefaultMode: () => 'off' };",
    "hooks/ponytail-instructions.js": "module.exports = { getPonytailInstructions: (mode) => 'PONYTAIL ' + mode };",
  });
  try {
    assert.equal(ponytailInstructions(root), "PONYTAIL full");
    assert.equal(ponytailInstructions(path.join(root, "missing")), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

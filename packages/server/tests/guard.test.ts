import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { agentShellEnv, checkBashCommand } from "../src/extensions/guard.js";

it("blocks pushing, gh auth and merge, credential reads, and changes to the credential overrides", () => {
  const blocked = [
    "git push",
    "git push -u origin mypi/fix",
    "cd repo && git add -A && git commit -m wip && git push",
    "git -C ../repo push --force",
    "git -c core.pager=cat push",
    "git \\\n  push origin HEAD",
    "FOO=1 /usr/bin/git push",
    "nohup git push &",
    "nice -n 10 git push origin HEAD",
    "sudo -u me git push",
    "if true; then git push; fi",
    "echo $(git push)",
    "echo `git push`",
    'echo "$(git push origin HEAD)"',
    'T="$(gh auth token)"',
    "2>/dev/null gh auth token",
    "bash -c 'git push origin HEAD'",
    'sh -lc "cd x; git push"',
    'eval "git push"',
    "cat <<EOF\n$(git push)\nEOF",
    "cat > notes.md <<'EOF'\ntext\nEOF\ngit push",
    "gh auth status",
    "gh auth token",
    "gh auth login --with-token < token.txt",
    "gh pr merge 12 --squash",
    'echo "$(gh pr merge 12 --squash)"',
    "security find-generic-password -s gh:github.com -w",
    'printf "%s\\n" "$(security find-generic-password -s gh:github.com -w)"',
    "security find-internet-password -s github.com",
    "security dump-keychain -d",
    "printf 'host=github.com\\n' | git credential fill",
    "git credential-osxkeychain get",
    "git-credential-osxkeychain get",
    "unset GH_CONFIG_DIR",
    "unset -v GH_TOKEN GITHUB_TOKEN",
    "env -u GH_CONFIG_DIR gh pr create",
    "env -uGH_CONFIG_DIR gh api user",
    "env -S 'gh auth token'",
    "GH_CONFIG_DIR=~/.config/gh gh pr create",
    "GITHUB_PAT_TOKEN=x ./release.sh",
    "export GITHUB_TOKEN=abc",
    "export -n GH_CONFIG_DIR",
    "GIT_CONFIG_COUNT=0 git fetch",
    "unset GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0",
    "BASH_ENV=~/.creds bash -c true",
    "env -i git fetch",
    "env -i HOME=$HOME bash",
    // Follow-up review: constructs whose boundaries a raw-text scan got wrong.
    'cat <<< "hello"\ngit push',
    "echo $((1 << 3))\ngit push",
    'cat <<< "$(gh auth token)"',
    "cat <(gh auth token)",
    "2>&1 gh auth token",
    "gh 2>&1 auth token",
    "git > push.log push",
    'echo "$((GIT_CONFIG_COUNT = 0))"',
    "echo ${GIT_CONFIG_COUNT:=0}",
    "bash <<'EOF'\ngit push\nEOF",
    "sh -s <<'EOF'\ngh auth token\nEOF",
    "cat <<EOF\n$(\n  gh auth token\n)\nEOF",
    'cat <<E"OF"\ndata\nEOF\ngit push',
    String.raw`echo "$(printf '(')"` + "\ngit push",
    String.raw`echo "$(printf ')'; gh auth token)"`,
    "env -S'gh auth token'",
    "cat <<EOF\n`git \\\n  push`\nEOF",
    "cat <<EOF\nEO\\\nF\ngit push",
    "bash <<< 'git push'",
    // Second follow-up: quotes in ${…}, nested heredoc ownership, continuations, CRLF, $'…', compound commands.
    "printf '%s\\n' \"${x:-\"}\"}\"\ngit push",
    "printf '%s\\n' \"${x//a/'$(git push)'}\"",
    "python3 - <<'PY' \"$(\n gh auth token\n)\"\nimport sys\nprint(sys.argv[1])\nPY",
    "cat <<EOF\npath\\\\\nEOF\ngit push",
    "cat << \\\nEOF\nhello\nEOF\ngit push",
    "cat <<'EOF'\r\nhello\r\nEOF\r\ngit push\n",
    "bash -c $'echo ready\\ngit push'",
    "bash -c $\"git push\"",
    "function publish { git push; }; publish",
    "dash -c 'echo \"$(case ship in ship) git push;; *) echo safe;; esac)\"'",
    "coproc gh auth token",
  ];
  for (const command of blocked) assert.ok(checkBashCommand(command), `should block: ${JSON.stringify(command)}`);

  const allowed = [
    "git status",
    "git commit -m 'fix push handling'",
    "git commit -m 'docs: env GITHUB_TOKEN in CI'",
    "git log --grep=push",
    "git stash push -m wip",
    "rg 'git push' docs",
    "rg 'GITHUB_TOKEN=' .",
    "rg 'unset GH_CONFIG_DIR' .",
    "grep -rn GITHUB_TOKEN .github/workflows",
    "printf '%s\\n' 'GITHUB_TOKEN=example' > .env.example",
    "cat > README.md <<'EOF'\ngit push origin HEAD\nEOF",
    "cat > ci.yml <<EOF\nrun: GITHUB_TOKEN=placeholder npm test\nEOF",
    "# unset GH_CONFIG_DIR\ngit status",
    "echo ok # example; git push",
    "echo \"gh auth is not for agents\"",
    "GH_PAGER=cat gh pr view 12 --json state",
    "gh pr create --draft --fill",
    "npm test && npm run check",
    "env | sort",
    "command -v git",
    "security help",
    // The same text as data, not as a command.
    String.raw`echo "$(printf '%s\n' '1) $(git push)')"`,
    "cat <<EOF\n$(printf '%s' '\n$(git push)\n')\nEOF",
    "cat <<-EOF\n\tgit push\n\tEOF",
    'jq . <<< "$json"',
    "echo $((2 * 3))",
    "echo ${GH_TOKEN:-none}",
    "printf '%s\\n' ${x:-'$(git push)'}",
    "printf '%s\\n' $'it\\'s $(git push)'",
    "[[ -n x && GH_TOKEN=example == GH_TOKEN=* ]] && echo ok",
    "case $1 in ship) echo 'git push is for MyPi';; esac",
  ];
  for (const command of allowed) assert.equal(checkBashCommand(command), undefined, `should allow: ${JSON.stringify(command)}`);
});

it("runs the agent's shell without GitHub credentials, even when the daemon's env and config carry them", async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mypi-guard-")));
  const file = (name: string, content: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(tmp, name)), { recursive: true });
    fs.writeFileSync(path.join(tmp, name), content, { mode });
    return path.join(tmp, name);
  };
  const helper = (marker: string) => `"!f() { echo username=x; echo password=${marker}; }; f"`;
  // Helpers like gh's (generic, host- and owner-scoped), an askpass program, BASH_ENV and -c parameters.
  const leaky = file("leaky.gitconfig", [
    "[credential]", `\thelper = ${helper("LEAK_GENERIC")}`,
    '[credential "https://github.com"]', `\thelper = ${helper("LEAK_HOST")}`,
    '[credential "https://github.com/owner"]', `\thelper = ${helper("LEAK_PATH")}`, "\tuseHttpPath = true",
    "[core]", `\taskPass = ${file("askpass.sh", "#!/bin/sh\necho LEAK_ASKPASS\n", 0o755)}`,
    "",
  ].join("\n"));
  const bashEnv = file("bash-env.sh", "export GH_TOKEN=LEAK_BASH_ENV\nunset GIT_CONFIG_COUNT\n");
  const dataDir = path.join(tmp, "data");
  file("data/agent-gh/hosts.yml", "github.com:\n    oauth_token: LEAK_HOSTS_FILE\n"); // left by an earlier run

  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: path.join(tmp, "home"),
    GH_TOKEN: "LEAK_ENV", GITHUB_TOKEN: "LEAK_ENV", GITHUB_PAT_TOKEN: "LEAK_ENV",
    GIT_CONFIG_GLOBAL: leaky, GIT_CONFIG_NOSYSTEM: "1", BASH_ENV: bashEnv,
    GIT_CONFIG_PARAMETERS: `'credential.helper'='!f() { echo username=x; echo password=LEAK_PARAMS; }; f'`,
  });
  const env = new NodeExecutionEnv({ cwd: tmp, shellEnv: agentShellEnv(dataDir) });
  const run = async (command: string) => {
    let output = "";
    const result = await env.exec(command, { timeout: 30, onOutput: (text) => { output += text; } }, BACKGROUND_CONTEXT);
    assert.ok(result.ok, `could not run ${command}`);
    return { output, exitCode: result.value.exitCode };
  };
  try {
    const vars = await run('echo "token=${GH_TOKEN-}${GITHUB_TOKEN-}${GITHUB_PAT_TOKEN-} prompt=$GIT_TERMINAL_PROMPT gh=$(ls -A "$GH_CONFIG_DIR")"');
    assert.equal(vars.output.trim(), "token= prompt=0 gh=");

    const fill = await run("printf 'protocol=https\\nhost=github.com\\npath=owner/repo.git\\n\\n' | git credential fill");
    assert.notEqual(fill.exitCode, 0);
    assert.ok(!fill.output.includes("LEAK"), "a credential helper or askpass still answered");

    if (!commandExists("gh")) return t.skip("gh is not installed");
    // Exit 4 is gh's "authentication required", decided before any request; a token would reach the network.
    const gh = await run("gh api user");
    assert.equal(gh.exitCode, 4);
  } finally {
    process.env = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function commandExists(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

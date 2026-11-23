import fs from "node:fs";
import path from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

// Level 1 guardrails (plan decision 6): the agent's shell runs with GitHub credentials removed, and a bash guard
// stops the ordinary ways to push or get them back. Not a sandbox: GitHub rulesets are the backstop.

/** Overrides for the agent's shell, on top of the daemon's environment; `undefined` removes a variable. */
export function agentShellEnv(dataDir: string, daemonEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Emptied at every start, so gh API calls are unauthenticated. `gh auth token` still finds the keychain token
  // (gh 2.83), which is why the guard blocks `gh auth`.
  const ghConfigDir = path.join(dataDir, "agent-gh");
  fs.rmSync(ghConfigDir, { recursive: true, force: true });
  fs.mkdirSync(ghConfigDir, { recursive: true });
  // Every GitHub variable (a personal GITHUB_PAT_TOKEN too), and inherited git config passed through the env.
  const inherited = Object.keys(daemonEnv).filter((name) => /^(GH|GITHUB)_|^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/i.test(name));
  return {
    ...Object.fromEntries(inherited.map((name) => [name, undefined])),
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_CONFIG_DIR: ghConfigDir,
    // Given last, an empty credential.helper clears every helper the config files set, URL-scoped ones too;
    // an empty core.askPass stops a configured askpass program from answering for git.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.askPass",
    GIT_CONFIG_VALUE_1: "",
    GIT_TERMINAL_PROMPT: "0",
    // An editor terminal's askpass would hand git the editor's GitHub login; BASH_ENV runs before every command.
    GIT_ASKPASS: undefined,
    SSH_ASKPASS: undefined,
    BASH_ENV: undefined,
  };
}

/** Variables the agent may not set, unset or un-export: the overrides above and GitHub tokens. */
const PROTECTED = /^(?:(?:GH|GITHUB)_\w*TOKEN|GH_CONFIG_DIR|GIT_CONFIG_\w+|GIT_TERMINAL_PROMPT|GIT_ASKPASS|SSH_ASKPASS|BASH_ENV)$/;
/** Commands that run the next word as the command, with their options that take a value. */
const WRAPPERS = new Map<string, string[]>([
  ["sudo", ["-u", "-g", "-C", "-h", "-p", "-U"]],
  ["env", ["-u", "-S", "-C", "-P"]],
  ["nice", ["-n"]],
  ["xargs", ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]],
  ["time", ["-f", "-o"]],
  ["exec", ["-a"]],
  ["command", []],
  ["nohup", []],
]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
const ASSIGNING = new Set(["export", "unset", "declare", "typeset", "readonly", "local"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

const PUSH = "`git push` is blocked in MyPi's agent shell: commit locally, and MyPi pushes the branch when the user ships it.";
const GH = "`gh auth` and `gh pr merge` are blocked in MyPi's agent shell.";
const SECRETS = "Reading stored credentials is blocked in MyPi's agent shell.";
const ENV = "MyPi's agent shell runs without GitHub credentials on purpose; changing its credential variables is blocked.";

// Bash's blanks and the metacharacters that end a word. A CR is an ordinary character to bash, so here too.
const BLANK = /[ \t]/;
const WORD_END = /[ \t\n;&|()<>]/;
const REDIRECT = /(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/y;
const ANSI_C: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };

interface ParsedCommand {
  words: string[];
  /** Heredoc bodies and here-strings fed to the command: a script when the command is a shell. */
  heredocs: string[];
}

interface Heredoc {
  command: ParsedCommand;
  delimiter: string;
  literal: boolean;
  stripTabs: boolean;
}

// shortcut: a small bash scanner, not a full parser. It reads quotes ('…', "…", $'…', $"…"), escapes, comments,
// redirects, heredocs, `$(…)`, backticks, `${…}`, `$((…))`, process substitution, `case` arms and `[[ … ]]` the
// same way at every depth, so it finds the commands a script runs. It does not catch someone hiding a push
// (`p=push; git $p`, an alias, a script file). Inputs nested thousands deep overflow the stack; the harness then
// blocks the call.
class ShellScanner {
  private i = 0;

  constructor(
    private readonly s: string,
    /** Every simple command found, nested ones included. */
    readonly commands: ParsedCommand[] = [],
    /** Problems found while scanning: a protected variable assigned in `${…}` or `$((…))`. */
    readonly reasons: string[] = [],
  ) {}

  /** Commands up to `stop` (the `)` of a substitution or subshell) or the end, consuming `stop`. */
  list(stop?: string): void {
    let command: ParsedCommand = { words: [], heredocs: [] };
    const finish = () => {
      if (command.words.length > 0) this.commands.push(command);
      command = { words: [], heredocs: [] };
    };
    // Heredocs opened in this context: their bodies start after its next newline.
    const pending: Heredoc[] = [];
    // Open `case` commands: the subject until `in`, then patterns (ending at `)`) and bodies (ending at `;;`).
    const cases: ("subject" | "pattern" | "body")[] = [];
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      const next = this.s[this.i + 1];
      const inCase = cases[cases.length - 1];
      const inTest = command.words[0] === "[[" && !command.words.includes("]]");
      if (BLANK.test(c)) {
        this.i++;
      } else if (c === "\\" && next === "\n") {
        this.i += 2;
      } else if (c === "\n") {
        this.i++;
        finish();
        this.heredocBodies(pending);
      } else if (c === "#") {
        this.i = this.indexOf("\n", this.i);
      } else if (inCase === "pattern" && (c === "|" || c === "(")) {
        this.i++;
      } else if (inCase === "pattern" && c === ")") {
        this.i++;
        command = { words: [], heredocs: [] };
        cases[cases.length - 1] = "body";
      } else if (inCase === "body" && c === ";" && (next === ";" || next === "&")) {
        this.i += this.s[this.i + 2] === "&" ? 3 : 2;
        finish();
        cases[cases.length - 1] = "pattern";
      } else if (c === stop) {
        this.i++;
        break;
      } else if (inTest && "&|()<>".includes(c)) {
        // Inside [[ … ]] these are operators of the test, not command separators.
        const op = (c === "&" || c === "|") && next === c ? c + c : c;
        this.i += op.length;
        command.words.push(op);
      } else if (c === "(" && next === "(") {
        this.i += 2;
        this.arithmetic();
      } else if ((c === "<" || c === ">") && next === "(") {
        this.i += 2;
        this.list(")");
        command.words.push("");
      } else if (this.redirect(command, pending)) {
        // consumed
      } else if (";&|()".includes(c)) {
        this.i++;
        finish();
        if (c === "(") this.list(")");
      } else {
        const start = this.i;
        const word = this.word();
        if (this.i === start) {
          this.i++;
          continue;
        }
        command.words.push(word);
        if (command.words.length === 1 && word === "case") cases.push("subject");
        else if (command.words.length === 1 && word === "esac" && cases.length > 0) cases.pop();
        else if (inCase === "subject" && word === "in") {
          command = { words: [], heredocs: [] };
          cases[cases.length - 1] = "pattern";
        }
      }
    }
    finish();
  }

  /** A redirect at `i`, consumed with its target; false when there is none. */
  private redirect(command: ParsedCommand, pending: Heredoc[]): boolean {
    REDIRECT.lastIndex = this.i;
    const m = REDIRECT.exec(this.s);
    if (!m) return false;
    this.i += m[0].length;
    if (m[2] === "<<" || m[2] === "<<-") {
      pending.push(this.heredoc(command, m[2] === "<<-"));
    } else {
      // The target is not a command word, but its substitutions still run; a here-string is stdin, like a heredoc.
      this.skipBlanks();
      const target = this.word();
      if (m[2] === "<<<") command.heredocs.push(target);
    }
    return true;
  }

  /** One word without its quotes; the substitutions inside it are scanned. */
  private word(): string {
    let out = "";
    while (this.i < this.s.length && !WORD_END.test(this.s[this.i])) {
      const c = this.s[this.i];
      const next = this.s[this.i + 1];
      if (c === "'") {
        const end = this.indexOf("'", this.i + 1);
        out += this.s.slice(this.i + 1, end);
        this.i = end + 1;
      } else if (c === "$" && next === "'") {
        this.i += 2;
        out += this.ansiC();
      } else if (c === '"' || (c === "$" && next === '"')) {
        this.i += c === "$" ? 2 : 1;
        out += this.text('"');
      } else {
        out += this.expansion(false) ?? this.s[this.i++];
      }
    }
    return out;
  }

  /** The value of `$'…'` after its opening quote: escapes decoded, nothing expanded. */
  private ansiC(): string {
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== "'") {
      if (this.s[this.i] === "\\") {
        const escaped = this.s[this.i + 1] ?? "";
        out += ANSI_C[escaped] ?? escaped;
        this.i += 2;
      } else {
        out += this.s[this.i++];
      }
    }
    this.i++;
    return out;
  }

  /** Double-quoted text up to `end`, consuming it; without `end`, a whole expanding heredoc body. */
  text(end?: string): string {
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== end) out += this.expansion(true) ?? this.s[this.i++];
    this.i++;
    return out;
  }

  /** An escape or an expansion at `i`, consumed; `undefined` when there is none. */
  private expansion(quoted: boolean): string | undefined {
    const c = this.s[this.i];
    const next = this.s[this.i + 1];
    if (c === "\\") {
      this.i += 2;
      return next === "\n" ? "" : (next ?? "");
    }
    if (c === "`") {
      let body = "";
      for (this.i++; this.i < this.s.length && this.s[this.i] !== "`"; this.i++) {
        if (this.s[this.i] === "\\") this.i++;
        if (this.s[this.i] !== "\n" || this.s[this.i - 1] !== "\\") body += this.s[this.i] ?? "";
      }
      this.i++;
      new ShellScanner(body, this.commands, this.reasons).list();
      return "";
    }
    if (c !== "$") return undefined;
    if (next === "(" && this.s[this.i + 2] === "(") {
      this.i += 3;
      this.arithmetic();
    } else if (next === "(") {
      this.i += 2;
      this.list(")");
    } else if (next === "{") {
      this.i += 2;
      this.parameter(quoted);
    } else {
      return undefined;
    }
    return "";
  }

  /** `${…}` after its `{`. Quotes inside work as in the enclosing context: within "…", single quotes are literal. */
  private parameter(quoted: boolean): void {
    const name = /[#!]?(\w+)/y;
    name.lastIndex = this.i;
    const m = name.exec(this.s);
    if (m) this.i += m[0].length;
    if (m && PROTECTED.test(m[1]) && /^:?=/.test(this.s.slice(this.i, this.i + 2))) this.reasons.push(ENV);
    while (this.i < this.s.length && this.s[this.i] !== "}") {
      const c = this.s[this.i];
      if (c === "'" && !quoted) {
        this.i = this.indexOf("'", this.i + 1) + 1;
      } else if (c === '"') {
        this.i++;
        this.text('"');
      } else if (this.expansion(quoted) === undefined) {
        this.i++;
      }
    }
    this.i++;
  }

  /** `((…))` or `$((…))` after its opening parentheses. Naming a protected variable there can assign it. */
  private arithmetic(): void {
    let depth = 0;
    let text = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === ")" && depth === 0 && this.s[this.i + 1] === ")") {
        this.i += 2;
        break;
      }
      if (this.expansion(false) !== undefined) continue;
      if (c === "(") depth++;
      if (c === ")") depth--;
      text += c;
      this.i++;
    }
    if ((text.match(/[A-Za-z_]\w*/g) ?? []).some((name) => PROTECTED.test(name))) this.reasons.push(ENV);
  }

  /** The delimiter after `<<`, with bash's quote removal; the body is read after the line ends. */
  private heredoc(command: ParsedCommand, stripTabs: boolean): Heredoc {
    this.skipBlanks();
    let delimiter = "";
    let literal = false;
    while (this.i < this.s.length && !WORD_END.test(this.s[this.i])) {
      const c = this.s[this.i];
      const next = this.s[this.i + 1];
      if (c === "\\" && next === "\n") {
        this.i += 2;
      } else if (c === "$" && (next === "'" || next === '"')) {
        this.i++;
      } else if (c === "'" || c === '"') {
        literal = true;
        const end = this.indexOf(c, this.i + 1);
        delimiter += this.s.slice(this.i + 1, end);
        this.i = end + 1;
      } else if (c === "\\") {
        literal = true;
        delimiter += next ?? "";
        this.i += 2;
      } else {
        delimiter += this.s[this.i++];
      }
    }
    return { command, delimiter, literal, stripTabs };
  }

  private heredocBodies(pending: Heredoc[]): void {
    for (const doc of pending.splice(0)) {
      const lines: string[] = [];
      while (this.i < this.s.length) {
        // In an expanding body, a line ending in an odd number of backslashes continues on the next one.
        const parts: string[] = [];
        let continued: boolean;
        do {
          const end = this.indexOf("\n", this.i);
          const part = this.s.slice(this.i, end);
          this.i = end + 1;
          let backslashes = 0;
          while (part[part.length - 1 - backslashes] === "\\") backslashes++;
          continued = !doc.literal && backslashes % 2 === 1 && this.i < this.s.length;
          parts.push(continued ? part.slice(0, -1) : part);
        } while (continued);
        const line = parts.join("");
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      doc.command.heredocs.push(body);
      if (!doc.literal) new ShellScanner(body, this.commands, this.reasons).text();
    }
  }

  private skipBlanks(): void {
    for (;;) {
      if (BLANK.test(this.s[this.i] ?? "")) this.i++;
      else if (this.s[this.i] === "\\" && this.s[this.i + 1] === "\n") this.i += 2;
      else return;
    }
  }

  private indexOf(ch: string, from: number): number {
    const at = this.s.indexOf(ch, from);
    return at === -1 ? this.s.length : at;
  }
}

/** Positional words after `start`, skipping options and the values of `valueOptions`. */
function positionals(words: string[], start: number, valueOptions = new Set<string>()): string[] {
  const out: string[] = [];
  for (let i = start; i < words.length; i++) {
    if (valueOptions.has(words[i])) i++;
    else if (!words[i].startsWith("-")) out.push(words[i]);
  }
  return out;
}

function checkSimpleCommand({ words, heredocs }: ParsedCommand): string | undefined {
  // Skip what can stand before the real command: assignments, wrappers with their options, keywords.
  let i = 0;
  let wrapper: string | undefined;
  for (; i < words.length; i++) {
    const w = words[i];
    const assigned = /^(\w+)=/.exec(w)?.[1];
    if (assigned) {
      if (PROTECTED.test(assigned)) return ENV;
    } else if (WRAPPERS.has(path.basename(w))) {
      wrapper = path.basename(w);
    } else if (wrapper && w.startsWith("-")) {
      if (wrapper === "env") {
        if (w === "-i" || w === "-" || w === "--ignore-environment") return ENV;
        const unset = /^(?:-u|--unset=)(.+)$/.exec(w)?.[1] ?? (w === "-u" ? words[i + 1] : undefined);
        if (unset && PROTECTED.test(unset)) return ENV;
        const script = /^-S(.+)$/.exec(w)?.[1] ?? (w === "-S" ? words[i + 1] : undefined);
        const split = script === undefined ? undefined : checkBashCommand(script);
        if (split) return split;
      }
      if (WRAPPERS.get(wrapper)?.includes(w)) i++;
    } else if (w === "function" || w === "coproc") {
      if (w === "function" || words[i + 2] === "{") i++; // the function's or coprocess's name
    } else if (!KEYWORDS.has(w)) {
      break;
    }
  }
  const name = path.basename(words[i] ?? "");
  if (ASSIGNING.has(name) && words.slice(i + 1).some((arg) => PROTECTED.test(arg.split("=")[0]))) return ENV;
  if (name.startsWith("git-credential")) return SECRETS;
  if (name === "git") {
    const [sub] = positionals(words, i + 1, GIT_VALUE_OPTIONS);
    if (sub === "push") return PUSH;
    if (sub?.startsWith("credential")) return SECRETS;
  }
  if (name === "gh") {
    const [sub, action] = positionals(words, i + 1, new Set(["-R", "--repo", "--hostname"]));
    if (sub === "auth" || (sub === "pr" && action === "merge")) return GH;
  }
  if (name === "security") {
    const [sub] = positionals(words, i + 1);
    if (sub?.startsWith("find-") || sub === "dump-keychain") return SECRETS;
  }
  if (SHELLS.has(name)) {
    const flag = words.findIndex((w, j) => j > i && /^-\w*c\w*$/.test(w));
    const scripts = flag === -1 ? heredocs : [words[flag + 1] ?? ""];
    for (const script of scripts) {
      const reason = checkBashCommand(script);
      if (reason) return reason;
    }
  }
  if (name === "eval") return checkBashCommand(words.slice(i + 1).join(" "));
  return undefined;
}

/** Why the agent may not run `command`, or `undefined` when it may. */
export function checkBashCommand(command: string): string | undefined {
  const scanner = new ShellScanner(command);
  scanner.list();
  if (scanner.reasons.length > 0) return scanner.reasons[0];
  for (const parsed of scanner.commands) {
    const reason = checkSimpleCommand(parsed);
    if (reason) return reason;
  }
  return undefined;
}

export const GuardExtension = defineExtension({
  name: "mypi-guard",
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => {
        if (call.name !== "bash") return undefined;
        const command = (call.arguments as { command?: unknown }).command;
        const reason = typeof command === "string" ? checkBashCommand(command) : undefined;
        return reason ? { block: reason } : undefined;
      },
    }),
  ],
});

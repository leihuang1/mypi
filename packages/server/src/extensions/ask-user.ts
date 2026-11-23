import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { AskedQuestion, RawEntryRecord } from "@mypi/shared";

export const ASK_USER = "ask_user";

const askUser = defineTool({
  name: ASK_USER,
  description: [
    "Ask the user a question and end this run. Use it only when you can't go on without their decision or information;",
    "don't use it to report progress or to say you're done. Their answer arrives as the next user message.",
    "Call it alone, as the only tool call in your response, and ask everything you need in one question.",
    "Offer `choices` when the answer is one of a few options; they appear as buttons, and the user can still type.",
  ].join(" "),
  parameters: Type.Object({
    question: Type.String({ minLength: 1, description: "The question, self-contained: the user reads it in a phone notification." }),
    choices: Type.Optional(Type.Array(Type.String(), { maxItems: 6, description: "Short answers to offer, if any." })),
  }),
  replay: "safe",
  execute: async (args) => {
    if (!args.question.trim()) throw new Error("The question is empty: ask it in words, or carry on without asking.");
    return {
      // The run ends here unless other tools ran in the same round; then the model is asked again, and must stop.
      output: [{ type: "text", text: "Asked. Stop now, without calling another tool: the user's answer arrives as the next message." }],
      control: { terminate: true },
    };
  },
});

/** In a section, not the stored agent instructions, so sessions created before it get it too. */
const instructions = section("mypi_worker", () => [
  "The user is often away from the session. When you can't go on without their decision, call ask_user; otherwise finish the task.",
  "Start your final reply with one line that says what you did: it becomes the notification the user sees.",
].join("\n"));

export const AskUserExtension = defineExtension({ name: "mypi-ask-user", tools: [askUser], sections: [instructions] });

type Part = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };

function question(args: unknown): AskedQuestion | undefined {
  const { question: text, choices } = (args ?? {}) as { question?: unknown; choices?: unknown };
  if (typeof text !== "string" || !text.trim()) return undefined;
  const offered = Array.isArray(choices)
    ? choices.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim().slice(0, 80)).slice(0, 6)
    : [];
  return { text: text.trim().slice(0, 500), ...(offered.length ? { choices: offered } : {}) };
}

/** An assistant message's text, and the question it asks if it calls `ask_user` (several calls: all their questions). */
export function assistantTurn(message: Record<string, unknown>): { text: string; question?: AskedQuestion } {
  const parts = (Array.isArray(message.content) ? message.content : []) as Part[];
  let text = "";
  const asked: AskedQuestion[] = [];
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") text += part.text;
    if (part?.type === "toolCall" && part.name === ASK_USER) {
      const q = question(part.arguments);
      if (q) asked.push(q);
    }
  }
  const joined = asked.length > 1 ? { text: asked.map((q) => q.text).join("\n\n").slice(0, 500) } : asked[0];
  return { text: text.trim(), question: joined };
}

/** The text of the last assistant message that has any: the agent's latest reply. */
export function lastReply(entries: readonly RawEntryRecord[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const messages = (entries[i].model ?? []) as Record<string, unknown>[];
    for (let j = messages.length - 1; j >= 0; j--) {
      if (messages[j].role !== "assistant") continue;
      const { text } = assistantTurn(messages[j]);
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Where a conversation stands, from the model messages since the user last spoke: the `ask_user` question they
 * haven't answered (it stands even if the agent went on, having asked alongside other tools), whether the last model
 * request failed, and whether the agent finished a reply.
 */
export function conversationState(entries: readonly RawEntryRecord[]): { question?: AskedQuestion; failed: boolean; finished: boolean } {
  const messages = entries.flatMap((entry) => (entry.model ?? []) as Record<string, unknown>[]);
  let latest: Record<string, unknown> | undefined;
  let asked: AskedQuestion | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") break;
    if (message.role !== "assistant") continue; // tool results and system sections
    latest ??= message;
    asked ??= assistantTurn(message).question;
  }
  const failed = latest?.stopReason === "error";
  return { ...(asked ? { question: asked } : {}), failed, finished: Boolean(latest) && !failed && latest!.stopReason !== "aborted" };
}

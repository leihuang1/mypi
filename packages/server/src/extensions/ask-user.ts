import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { AskedQuestion, RawEntryRecord } from "@mypi/shared";

export const ASK_USER = "ask_user";

const askUser = defineTool({
  name: ASK_USER,
  description: [
    "Ask the user a question and end this run. Use it only when you can't go on without their decision or information;",
    "don't use it to report progress or to say you're done. Their answer arrives as the next user message.",
    "Offer `choices` when the answer is one of a few options; they appear as buttons, and the user can still type.",
  ].join(" "),
  parameters: Type.Object({
    question: Type.String({ description: "The question, self-contained: the user reads it in a phone notification." }),
    choices: Type.Optional(Type.Array(Type.String(), { maxItems: 6, description: "Short answers to offer, if any." })),
  }),
  replay: "safe",
  execute: async () => ({
    output: [{ type: "text", text: "Asked. This run ends here; the user's answer arrives as the next message." }],
    control: { terminate: true },
  }),
});

export const AskUserExtension = defineExtension({ name: "mypi-ask-user", tools: [askUser] });

type Part = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };

function question(args: unknown): AskedQuestion | undefined {
  const { question: text, choices } = (args ?? {}) as { question?: unknown; choices?: unknown };
  if (typeof text !== "string" || !text.trim()) return undefined;
  const offered = Array.isArray(choices)
    ? choices.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim().slice(0, 80)).slice(0, 6)
    : [];
  return { text: text.trim().slice(0, 500), ...(offered.length ? { choices: offered } : {}) };
}

/** An assistant message's text, and the question it asks if it calls `ask_user`. */
export function assistantTurn(message: Record<string, unknown>): { text: string; question?: AskedQuestion } {
  const parts = (Array.isArray(message.content) ? message.content : []) as Part[];
  let text = "";
  let asked: AskedQuestion | undefined;
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") text += part.text;
    if (part?.type === "toolCall" && part.name === ASK_USER) asked = question(part.arguments) ?? asked;
  }
  return { text: text.trim(), question: asked };
}

/**
 * Where a conversation stands, from its last model messages: waiting on the user's answer to `ask_user`, stopped by
 * a failed model request, and whether the user has said anything at all.
 */
export function conversationState(entries: readonly RawEntryRecord[]): { question?: AskedQuestion; failed: boolean; started: boolean } {
  const messages = entries.flatMap((entry) => (entry.model ?? []) as Record<string, unknown>[]);
  const started = messages.some((m) => m.role === "user");
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") break;
    if (message.role !== "assistant") continue; // tool results and system sections
    if (message.stopReason === "error") return { failed: true, started };
    return { question: assistantTurn(message).question, failed: false, started };
  }
  return { failed: false, started };
}

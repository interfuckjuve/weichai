import type { BaseMessage } from "@langchain/core/messages";

/** Message text of a plain or content-block assistant message. */
export function messageText(message: BaseMessage | undefined): string {
  if (message === undefined) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(block => {
    if (typeof block === "string") return block;
    if (typeof block === "object" && block !== null && "text" in block) {
      return String((block as { text: unknown }).text ?? "");
    }
    return "";
  }).join("");
}

/** Characters this message contributes to the persisted thread context. */
export function messageCharacters(message: BaseMessage): number {
  let characters = messageText(message).length;
  const calls = (message as { tool_calls?: Array<{ name?: string; args?: unknown }> }).tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      characters += (call?.name?.length ?? 0) + valueCharacters(call?.args);
    }
  }
  return characters;
}

export function valueCharacters(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Keep an opt-in trace payload small without dropping the tool result itself. */
export function boundedValue(value: unknown, maximum: number): unknown {
  if (typeof value === "string") {
    return value.length <= maximum ? value : `${value.slice(0, maximum)}...(truncated)`;
  }
  try {
    const text = JSON.stringify(value) ?? "";
    return text.length <= maximum
      ? value
      : `${text.slice(0, maximum)}...(truncated)`;
  } catch {
    return "(unserializable value)";
  }
}

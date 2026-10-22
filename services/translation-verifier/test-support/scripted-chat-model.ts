import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";

type ScriptedResponse = (messages: readonly BaseMessage[]) => AIMessage | Promise<AIMessage>;

/** Script only model replies; exercise the real LangChain tools and message history. */
export class ScriptedChatModel extends BaseChatModel {
  readonly observations: BaseMessage[][] = [];
  readonly toolNames: string[][] = [];
  readonly toolDescriptions: string[][] = [];
  private index = 0;

  constructor(private readonly script: ScriptedResponse[]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(tools: StructuredToolInterface[]): this {
    this.toolNames.push(tools.map(tool => tool.name));
    this.toolDescriptions.push(tools.map(tool => tool.description));
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.observations.push([...messages]);
    const next = this.script[this.index++];
    if (next === undefined) throw new Error("Scripted model ran out of responses.");
    const message = await next(messages);
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

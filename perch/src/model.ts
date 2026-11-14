import OpenAI from "openai";
import { logOutbound } from "./outbound.js";
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions/completions.js";
import type { FunctionParameters } from "openai/resources/shared.js";

export type ToolDef = {
  name: string;
  description: string;
  parameters: FunctionParameters;
  execute: (args: any, ctx: TurnContext) => Promise<unknown> | unknown;
};

export type TurnContext = {
  hootId: string;
  threadId: string;
  turnId: string;
};

export type LoopCallbacks = {
  onItem: (item: { kind: string; role?: string | null; content: unknown }) => void;
};

export type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  params: Record<string, unknown> | null;
};

export const ToolLoopMaxHops = 8;
export const ToolLoopMaxHopsComputer = 16;

export async function runTurn(
  model: ModelConfig,
  messages: ChatCompletionMessageParam[],
  tools: ToolDef[],
  ctx: TurnContext,
  cb: LoopCallbacks,
  maxHops = ToolLoopMaxHops,
  deadlineMs = 0
): Promise<string> {
  const startedAt = Date.now();
  const client = new OpenAI({ baseURL: model.baseUrl, apiKey: model.apiKey });
  const openaiTools: ChatCompletionTool[] = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const convo = [...messages];
  for (let hop = 0; hop < maxHops; hop++) {
    if (deadlineMs && Date.now() - startedAt > deadlineMs) break;
    logOutbound("model", `turn ${ctx.turnId} hop ${hop + 1}`, JSON.stringify(convo).length);
    const res = await client.chat.completions.create({
      model: model.model,
      messages: convo,
      ...(openaiTools.length ? { tools: openaiTools } : {}),
      ...model.params,
    });
    const msg = res.choices[0].message;
    convo.push(msg as ChatCompletionMessageParam);

    if (msg.tool_calls?.length) {
      // Providers occasionally emit the same call twice; run it once.
      const seen = new Set<string>();
      const unique = (msg.tool_calls as ChatCompletionMessageFunctionToolCall[]).filter((c) => {
        const key = `${c.function.name}:${c.function.arguments}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length !== msg.tool_calls.length) {
        // keep the trailing ids satisfied so the convo stays valid
        for (const dup of (msg.tool_calls as ChatCompletionMessageFunctionToolCall[]).filter((c) => !unique.includes(c))) {
          convo.push({ role: "tool", tool_call_id: dup.id, content: JSON.stringify({ deduped: true }) } as any);
        }
      }
      for (const call of unique) {
        const def = tools.find((t) => t.name === call.function.name);
        let result: unknown;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          if (!def) throw new Error(`unknown tool ${call.function.name}`);
          result = await def.execute(args, ctx);
        } catch (err: any) {
          result = { error: String(err?.message ?? err) };
        }
        cb.onItem({
          kind: "tool_call",
          content: { name: call.function.name, arguments: call.function.arguments },
        });
        cb.onItem({
          kind: "tool_result",
          content: { name: call.function.name, result },
        });
        convo.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        } as ChatCompletionMessageParam);
      }
      continue;
    }

    const text = msg.content ?? "";
    cb.onItem({ kind: "message", role: "hoot", content: { text } });
    return text;
  }
  // Out of hops: one last tool-free pass so the turn still ends with words.
  const wrap = await client.chat.completions.create({
    model: model.model,
    messages: [...convo, { role: "user", content: "Stop calling tools. In two lines: what did you manage, and what is left?" }],
    ...model.params,
  });
  const text = wrap.choices[0]?.message?.content ?? "(stopped after too many steps)";
  cb.onItem({ kind: "message", role: "hoot", content: { text } });
  return text;
}

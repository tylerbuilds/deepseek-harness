// src/agent/loop.ts

import { buildContext } from "./context.js";
import type { AgentSession, ChatMessage } from "./session.js";
import {
  addAssistantMessage,
  addToolResult,
  addUserMessage,
  updateSessionCost,
} from "./session.js";
import { consumeStream } from "./stream.js";
import { createToolRegistry, type ToolRegistry } from "./tools.js";

export interface AgentCallbacks {
  onText: (text: string) => void;
  onToolStart: (name: string, params: Record<string, unknown>) => void;
  onToolEnd: (name: string, summary: string, error?: string) => void;
  onTurnEnd: (text: string, toolCalls: number, tokens: number) => void;
}

function selectModel(sessionModel: string): string {
  return sessionModel;
}

function estimateCost(model: string, tokens: number): number {
  const ratePerMillion = model === "deepseek-v4-pro" ? 5.0 : 1.10;
  return (tokens / 1_000_000) * ratePerMillion;
}

export async function agentTurn(
  session: AgentSession,
  apiKey: string,
  userInput: string,
  callbacks: AgentCallbacks,
  registry: ToolRegistry = createToolRegistry()
): Promise<void> {
  // 1. Store user message
  addUserMessage(session, userInput);

  // 2. Build context (system prompt + pinned files + history + user input)
  const ctx = buildContext(session);

  // 3. Select model
  const model = selectModel(session.model);

  // 4. Agent loop — iterate until model responds without tool calls
  let turnText = "";
  let toolCallCount = 0;
  let totalTokens = 0;

  while (true) {
    const result = await consumeStream(
      apiKey,
      ctx.messages,
      registry.describe(),
      model,
      {
        onText: (text) => {
          turnText += text;
          callbacks.onText(text);
        },
      }
    );

    totalTokens += result.usage?.total_tokens ?? 0;

    // No tool calls? Turn is done.
    if (result.toolCalls.length === 0) {
      const assistantMsg: ChatMessage = { role: "assistant", content: result.text || null };
      ctx.messages.push(assistantMsg);
      addAssistantMessage(session, result.text || null, null, result.usage?.total_tokens ?? null);
      break;
    }

    // Execute each tool call
    for (const tc of result.toolCalls) {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(tc.function.arguments);
      } catch {
        // Invalid JSON — pass empty params, tool will error
      }

      callbacks.onToolStart(tc.function.name, params);
      const execResult = await registry.execute(tc.function.name, params, session.cwd);
      callbacks.onToolEnd(tc.function.name, execResult.summary, execResult.error);

      toolCallCount++;

      // Add tool result to in-memory context
      ctx.messages.push({
        role: "tool",
        content: execResult.content,
        tool_call_id: tc.id,
      });

      // Persist tool result
      addToolResult(session, tc.id, execResult.content);
    }

    // Store assistant message with its tool calls
    const toolCallsForStore = result.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: tc.function,
    }));
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: result.text || null,
      tool_calls: toolCallsForStore,
    };
    ctx.messages.push(assistantMsg);
    addAssistantMessage(session, result.text || null, toolCallsForStore, result.usage?.total_tokens ?? null);
  }

  // 5. Update session cost
  updateSessionCost(session, estimateCost(model, totalTokens));
  callbacks.onTurnEnd(turnText, toolCallCount, totalTokens);
}

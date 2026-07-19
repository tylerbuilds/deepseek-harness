import { HarnessError } from "../errors.js";
import { buildContext } from "./context.js";
import {
  toAgentEventSink,
  type AgentCallbacks,
  type AgentEventSink,
  type TokenUsage,
} from "./events.js";
import type { AgentSession, ChatMessage } from "./session.js";
import {
  addAssistantMessage,
  addToolResult,
  addUserMessage,
  updateSessionCost,
  updateSessionTokens,
} from "./session.js";
import { consumeStream } from "./stream.js";
import { createToolRegistry, ToolRegistry } from "./tools.js";

export { callbacksToEventSink } from "./events.js";
export type { AgentCallbacks, AgentEvent, AgentEventSink, TokenUsage } from "./events.js";

export interface AgentTurnOptions {
  signal?: AbortSignal;
  maxToolRounds?: number;
  maxToolCalls?: number;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_MAX_TOOL_CALLS = 32;

function selectModel(sessionModel: string): string {
  return sessionModel;
}

function estimateCost(model: string, usage: TokenUsage | null): number {
  if (!usage) return 0;
  const rates = model === "deepseek-v4-pro"
    ? { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 }
    : { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 };
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens = usage.prompt_cache_miss_tokens
    ?? Math.max(0, usage.prompt_tokens - cacheHitTokens);
  return (
    cacheHitTokens * rates.cacheHit
    + cacheMissTokens * rates.cacheMiss
    + usage.completion_tokens * rates.output
  ) / 1_000_000;
}

export function agentTurn(
  session: AgentSession,
  apiKey: string,
  userInput: string,
  sinkOrCallbacks: AgentEventSink | AgentCallbacks,
  options?: AgentTurnOptions,
): Promise<void>;
export function agentTurn(
  session: AgentSession,
  apiKey: string,
  userInput: string,
  sinkOrCallbacks: AgentEventSink | AgentCallbacks,
  registry: ToolRegistry,
  options?: AgentTurnOptions,
): Promise<void>;
export async function agentTurn(
  session: AgentSession,
  apiKey: string,
  userInput: string,
  sinkOrCallbacks: AgentEventSink | AgentCallbacks,
  registryOrOptions?: ToolRegistry | AgentTurnOptions,
  explicitOptions: AgentTurnOptions = {},
): Promise<void> {
  const registry = registryOrOptions instanceof ToolRegistry
    ? registryOrOptions
    : createToolRegistry();
  const options = registryOrOptions instanceof ToolRegistry
    ? explicitOptions
    : registryOrOptions ?? explicitOptions;
  const maxToolRounds = boundedLimit(
    options.maxToolRounds,
    DEFAULT_MAX_TOOL_ROUNDS,
    "maxToolRounds",
  );
  const maxToolCalls = boundedLimit(
    options.maxToolCalls,
    DEFAULT_MAX_TOOL_CALLS,
    "maxToolCalls",
  );
  const emit = toAgentEventSink(sinkOrCallbacks);

  throwIfAborted(options.signal);
  addUserMessage(session, userInput);
  const context = buildContext(session);
  const model = selectModel(session.model);
  let turnText = "";
  let turnReasoning = "";
  let toolCallCount = 0;
  let toolRoundCount = 0;
  let totalTokens = 0;

  while (true) {
    throwIfAborted(options.signal);
    const result = await consumeStream(
      apiKey,
      context.messages,
      registry.describe(),
      model,
      emit,
      {
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
    );

    turnText += result.text;
    turnReasoning += result.reasoningContent;
    const responseTokens = result.usage?.total_tokens ?? 0;
    totalTokens += responseTokens;
    updateSessionCost(session, estimateCost(model, result.usage));

    if (result.toolCalls.length > 0) {
      if (toolRoundCount >= maxToolRounds) {
        updateSessionTokens(session, responseTokens);
        throw new HarnessError(
          "agent_tool_round_limit_exceeded",
          `Agent exceeded the per-turn tool round limit of ${maxToolRounds}.`,
          { max_tool_rounds: maxToolRounds, attempted_round: toolRoundCount + 1 },
        );
      }
      if (toolCallCount + result.toolCalls.length > maxToolCalls) {
        updateSessionTokens(session, responseTokens);
        throw new HarnessError(
          "agent_tool_call_limit_exceeded",
          `Agent exceeded the per-turn tool call limit of ${maxToolCalls}.`,
          {
            max_tool_calls: maxToolCalls,
            completed_tool_calls: toolCallCount,
            requested_tool_calls: result.toolCalls.length,
          },
        );
      }
    }

    const toolCallsForStore = result.toolCalls.length > 0
      ? result.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: toolCall.function,
        }))
      : null;
    const assistantContent = toolCallsForStore ? result.text : result.text || null;
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: assistantContent,
      ...(result.reasoningContent
        ? { reasoning_content: result.reasoningContent }
        : {}),
      ...(toolCallsForStore ? { tool_calls: toolCallsForStore } : {}),
    };
    context.messages.push(assistantMessage);
    addAssistantMessage(
      session,
      assistantContent,
      toolCallsForStore,
      result.usage?.total_tokens ?? null,
      result.reasoningContent || null,
    );

    if (!toolCallsForStore) break;
    toolRoundCount++;

    for (const toolCall of result.toolCalls) {
      throwIfAborted(options.signal);
      let params: Record<string, unknown> = {};
      let argumentError: string | null = null;
      try {
        const parsed: unknown = JSON.parse(toolCall.function.arguments);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("tool arguments must be a JSON object");
        }
        params = parsed as Record<string, unknown>;
      } catch {
        argumentError = "Tool arguments were not a valid JSON object.";
      }

      emit({
        type: "tool_start",
        toolCallId: toolCall.id,
        name: toolCall.function.name,
        params,
      });
      const execution = argumentError
        ? {
            content: argumentError,
            summary: `Invalid arguments: ${toolCall.function.name}`,
            error: "invalid_tool_arguments",
          }
        : await registry.execute(
            toolCall.function.name,
            params,
            session.cwd,
            { signal: options.signal },
          );
      toolCallCount++;

      context.messages.push({
        role: "tool",
        content: execution.content,
        tool_call_id: toolCall.id,
      });
      addToolResult(session, toolCall.id, execution.content);
      emit({
        type: "tool_end",
        toolCallId: toolCall.id,
        name: toolCall.function.name,
        summary: execution.summary,
        ...(execution.error ? { error: execution.error } : {}),
      });
      throwIfAborted(options.signal);
    }
  }

  emit({
    type: "turn_complete",
    text: turnText,
    reasoningContent: turnReasoning,
    toolCalls: toolCallCount,
    toolRounds: toolRoundCount,
    tokens: totalTokens,
  });
}

function boundedLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new HarnessError(
      "invalid_agent_turn_limit",
      `${name} must be a non-negative safe integer.`,
      { option: name, value: limit },
    );
  }
  return limit;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HarnessError("agent_turn_aborted", "Agent turn was aborted.");
  }
}

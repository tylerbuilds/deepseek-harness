import { HarnessError } from "../errors.js";
import type { AgentEventSink, TokenUsage } from "./events.js";

export interface StreamMessage {
  role: string;
  content: string | null;
  reasoning_content?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface StreamResponse {
  text: string;
  reasoningContent: string;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  usage: TokenUsage | null;
}

export interface StreamOptions {
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamCallbacks {
  onText: (text: string) => void;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export async function consumeStream(
  apiKey: string,
  messages: StreamMessage[],
  tools: Array<Record<string, unknown>>,
  model: string,
  sinkOrCallbacks: AgentEventSink | StreamCallbacks,
  baseUrlOrOptions: string | StreamOptions = DEFAULT_BASE_URL,
  legacyTimeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<StreamResponse> {
  const options: StreamOptions = typeof baseUrlOrOptions === "string"
    ? { baseUrl: baseUrlOrOptions, timeoutMs: legacyTimeoutMs }
    : baseUrlOrOptions;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const safeTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs >= 0
    ? Math.min(requestedTimeoutMs, MAX_TIMEOUT_MS)
    : MAX_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(safeTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const emit: AgentEventSink = typeof sinkOrCallbacks === "function"
    ? sinkOrCallbacks
    : (event) => {
        if (event.type === "text_delta") {
          sinkOrCallbacks.onText(event.delta);
        }
      };

  if (options.signal?.aborted) {
    throw new HarnessError("agent_turn_aborted", "Agent turn was aborted before the DeepSeek request.");
  }

  const body: Record<string, unknown> = {
    model,
    messages: messages.map((message) => {
      const serialised: Record<string, unknown> = { role: message.role };
      if (message.content !== null) serialised.content = message.content;
      if (message.reasoning_content !== undefined) {
        serialised.reasoning_content = message.reasoning_content;
      }
      if (message.tool_calls) serialised.tool_calls = message.tool_calls;
      if (message.tool_call_id) serialised.tool_call_id = message.tool_call_id;
      return serialised;
    }),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length > 0) body.tools = tools;

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw mapAbortError(error, options.signal, timeoutSignal);
  }

  if (!response.ok || !response.body) {
    const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
    throw new HarnessError(
      "deepseek_api_error",
      `DeepSeek API request failed (HTTP ${response.status})`,
      { http_status: response.status, provider_error: raw?.error ?? null }
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let fullReasoning = "";
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
  let usage: TokenUsage | null = null;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data: ")) return;
    const data = trimmed.slice(6);
    if (data === "[DONE]") return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.usage) {
      const rawUsage = parsed.usage as Record<string, unknown>;
      usage = {
        prompt_tokens: Number(rawUsage.prompt_tokens ?? 0),
        completion_tokens: Number(rawUsage.completion_tokens ?? 0),
        total_tokens: Number(rawUsage.total_tokens ?? 0),
        ...(rawUsage.prompt_cache_hit_tokens !== undefined
          ? { prompt_cache_hit_tokens: Number(rawUsage.prompt_cache_hit_tokens) }
          : {}),
        ...(rawUsage.prompt_cache_miss_tokens !== undefined
          ? { prompt_cache_miss_tokens: Number(rawUsage.prompt_cache_miss_tokens) }
          : {}),
      };
      emit({ type: "usage", usage });
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      fullText += delta.content;
      emit({ type: "text_delta", delta: delta.content });
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      fullReasoning += delta.reasoning_content;
      emit({ type: "reasoning_delta", delta: delta.reasoning_content });
    }
    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
        const index = toolCall.index as number;
        if (!toolCallMap.has(index)) {
          toolCallMap.set(index, { id: (toolCall.id as string) ?? "", name: "", args: "" });
        }
        const entry = toolCallMap.get(index)!;
        if (toolCall.id) entry.id = toolCall.id as string;
        const functionDelta = toolCall.function as Record<string, unknown> | undefined;
        if (functionDelta?.name) entry.name += functionDelta.name as string;
        if (functionDelta?.arguments) entry.args += functionDelta.arguments as string;
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
  } catch (error) {
    throw mapAbortError(error, options.signal, timeoutSignal);
  } finally {
    reader.releaseLock();
  }

  const toolCalls = Array.from(toolCallMap.values()).map((toolCall) => ({
    id: toolCall.id,
    type: "function" as const,
    function: { name: toolCall.name, arguments: toolCall.args },
  }));

  return { text: fullText, reasoningContent: fullReasoning, toolCalls, usage };
}

function mapAbortError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): unknown {
  if (externalSignal?.aborted) {
    return new HarnessError("agent_turn_aborted", "Agent turn was aborted during the DeepSeek request.");
  }
  if (timeoutSignal.aborted) {
    return new HarnessError("deepseek_request_timeout", "DeepSeek request timed out.");
  }
  return error;
}

export function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY ?? "";
}

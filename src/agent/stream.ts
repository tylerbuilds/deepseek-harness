// src/agent/stream.ts

import { HarnessError } from "../errors.js";

export interface StreamResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export async function consumeStream(
  apiKey: string,
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }>,
  tools: Array<Record<string, unknown>>,
  model: string,
  callbacks: { onText: (text: string) => void },
  baseUrl = "https://api.deepseek.com",
  timeoutMs = 120_000,
): Promise<StreamResponse> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role };
      if (m.content !== null) msg.content = m.content;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
    stream: true,
  };
  if (tools.length > 0) body.tools = tools;

  // Validate timeoutMs: AbortSignal.timeout only accepts values in [0, 2^32-1]
  const MAX_TIMEOUT_MS = 4_294_967_295; // 2^32 - 1
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
    : MAX_TIMEOUT_MS;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(safeTimeoutMs),
  });

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
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Skip malformed SSE data lines
          continue;
        }
	        const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
	        const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
        if (!delta) continue;
        if (delta.content) {
          fullText += delta.content as string;
          callbacks.onText(delta.content as string);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = tc.index as number;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: (tc.id as string) ?? "", name: "", args: "" });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id as string;
            if ((tc.function as Record<string, unknown> | undefined)?.name) entry.name += (tc.function as Record<string, unknown>).name;
            if ((tc.function as Record<string, unknown> | undefined)?.arguments) entry.args += (tc.function as Record<string, unknown>).arguments as string;
          }
        }
        if (parsed.usage) {
          const u = parsed.usage as Record<string, unknown>;
          usage = {
            prompt_tokens: Number(u.prompt_tokens ?? 0),
            completion_tokens: Number(u.completion_tokens ?? 0),
            total_tokens: Number(u.total_tokens ?? 0),
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const resultToolCalls = Array.from(toolCallMap.values()).map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.args },
  }));

  return { text: fullText, toolCalls: resultToolCalls, usage };
}

export function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY ?? "";
}

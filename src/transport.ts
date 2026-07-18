import crypto from "node:crypto";
import { HarnessError } from "./errors.js";
import { classifyOutboundPayload } from "./privacy.js";
import type { RunItem, RunManifest } from "./schema.js";

export interface CompletionResult {
  content: string;
  raw: unknown;
  usage: unknown;
}

export interface CompletionTransport {
  complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult>;
}

function itemMessages(item: RunItem): { role: string; content: string }[] {
  if (item.messages) {
    return item.messages;
  }
  return [{ role: "user", content: item.prompt ?? "" }];
}

export class FakeTransport implements CompletionTransport {
  async complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult> {
    const hash = crypto.createHash("sha256").update(JSON.stringify({ project: manifest.project, item })).digest("hex");
    const content =
      manifest.response_format === "json_object"
        ? JSON.stringify({ item_id: item.id, fake: true, digest: hash.slice(0, 12) })
        : `fake:${item.id}:${hash.slice(0, 12)}`;

    return {
      content,
      raw: { fake: true, item_id: item.id, digest: hash },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 }
    };
  }
}

export class DeepSeekDryRunTransport implements CompletionTransport {
  async complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult> {
    const request = buildDeepSeekRequest(manifest, item);
    return {
      content: JSON.stringify({ dry_run: true, request }, null, 2),
      raw: { dry_run: true, request },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 }
    };
  }
}

export class DeepSeekLiveTransport implements CompletionTransport {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(apiKey: string, baseUrl = "https://api.deepseek.com", timeoutMs = 120_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
      throw new HarnessError("invalid_deepseek_timeout", "DeepSeek request timeout must be an integer between 1 and 3600000 milliseconds");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult> {
    const request = buildDeepSeekRequest(manifest, item);
    const privacy = classifyOutboundPayload(item.id, request);
    if (!privacy.external_deepseek_allowed) {
      throw new HarnessError(
        "outbound_privacy_check_failed",
        "Exact outbound payload failed the privacy gate",
        { findings: privacy.findings }
      );
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new HarnessError("deepseek_request_timeout", "DeepSeek API request exceeded the configured timeout");
      }
      throw error;
    }

    const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const providerError = raw?.error && typeof raw.error === "object"
        ? raw.error as Record<string, unknown>
        : {};
      throw new HarnessError("deepseek_api_error", "DeepSeek API request failed", {
        http_status: response.status,
        provider_code: typeof providerError.code === "string" ? providerError.code.slice(0, 100) : null,
        request_id: response.headers.get("x-request-id") ?? response.headers.get("request-id")
      });
    }

    if (raw?.model !== manifest.model) {
      throw new HarnessError("deepseek_response_model_mismatch", "DeepSeek response model did not match the approved model", {
        expected_model: manifest.model,
        observed_model: typeof raw?.model === "string" ? raw.model : null
      });
    }

    const choices = raw?.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content ?? "";
    return {
      content,
      raw,
      usage: raw?.usage ?? null
    };
  }
}

export function buildDeepSeekRequest(manifest: RunManifest, item: RunItem): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: manifest.model,
    messages: itemMessages(item),
    thinking: manifest.thinking,
    stream: false,
    response_format: { type: manifest.response_format }
  };

  if (manifest.thinking.reasoning_effort) {
    request.reasoning_effort = manifest.thinking.reasoning_effort;
  }
  if (manifest.temperature !== undefined) {
    request.temperature = manifest.temperature;
  }
  if (manifest.max_tokens !== undefined) {
    request.max_tokens = manifest.max_tokens;
  }

  return request;
}

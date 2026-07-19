// src/agent/dispatch.ts

import { subagentSystemPrompt, specReviewPrompt, codeQualityPrompt } from "./prompts.js";
import { consumeStream, getApiKey } from "./stream.js";
import { createToolRegistry } from "./tools.js";

export type SubagentStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

export interface SubagentResult {
  status: SubagentStatus;
  summary: string;
  concerns?: string;
  contextNeeded?: string;
  blocker?: string;
  output: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

function parseStatusBlock(text: string): {
  status: SubagentStatus;
  summary: string;
  concerns?: string;
  contextNeeded?: string;
  blocker?: string;
} {
  const validStatuses: SubagentStatus[] = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"];
  const match = text.match(/```status\r?\n([\s\S]*?)\r?\n```/);
  if (!match) {
    return { status: "DONE", summary: text.slice(0, 200) };
  }
  const block = match[1];
  const lines = block.split(/\r?\n/).map((l) => l.trim());
  const rawStatus = lines.find((l) => l.startsWith("status:"))?.split(":").slice(1).join(":").trim() ?? "DONE";
  const status = validStatuses.includes(rawStatus as SubagentStatus) ? (rawStatus as SubagentStatus) : "DONE";
  const summary = lines.find((l) => l.startsWith("summary:"))?.split(":").slice(1).join(":").trim() ?? "";
  const concerns = lines.find((l) => l.startsWith("concerns:"))?.split(":").slice(1).join(":").trim();
  const contextNeeded = lines.find((l) => l.startsWith("context_needed:"))?.split(":").slice(1).join(":").trim();
  const blocker = lines.find((l) => l.startsWith("blocker:"))?.split(":").slice(1).join(":").trim();
  return { status, summary, concerns, contextNeeded, blocker };
}

export interface DispatchParams {
  task: string;
  context?: string;
  model?: string;
}

export async function dispatchSubagent(params: DispatchParams): Promise<SubagentResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      status: "BLOCKED",
      summary: "No DeepSeek API key configured",
      blocker: "DEEPSEEK_API_KEY not set",
      output: "",
      usage: null,
    };
  }

  const registry = createToolRegistry();
  const toolDesc = registry.toolDescriptions();
  const model = params.model ?? "deepseek-v4-flash";

  const systemPrompt = subagentSystemPrompt(
    params.task,
    params.context ?? "No additional context provided.",
    toolDesc
  );

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: "Complete the task described in the system prompt." },
  ];

  let fullOutput = "";
  const result = await consumeStream(apiKey, messages, [], model, {
    onText: (text) => { fullOutput += text; },
  });

  const parsed = parseStatusBlock(fullOutput);

  return {
    status: parsed.status,
    summary: parsed.summary,
    concerns: parsed.concerns,
    contextNeeded: parsed.contextNeeded,
    blocker: parsed.blocker,
    output: fullOutput,
    usage: result.usage,
  };
}

export async function dispatchSpecReview(plan: string, implementation: string): Promise<SubagentResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      status: "BLOCKED",
      summary: "No DeepSeek API key configured",
      blocker: "DEEPSEEK_API_KEY not set",
      output: "",
      usage: null,
    };
  }

  const prompt = specReviewPrompt(plan, implementation);
  const messages = [
    { role: "system" as const, content: prompt },
    { role: "user" as const, content: "Review the implementation against the spec." },
  ];

  let fullOutput = "";
  const result = await consumeStream(apiKey, messages, [], "deepseek-v4-pro", {
    onText: (text) => { fullOutput += text; },
  });

  const parsed = parseStatusBlock(fullOutput);
  return {
    status: parsed.status,
    summary: parsed.summary,
    concerns: parsed.concerns,
    output: fullOutput,
    usage: result.usage,
  };
}

export async function dispatchCodeQualityReview(code: string, files: string[]): Promise<SubagentResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      status: "BLOCKED",
      summary: "No DeepSeek API key configured",
      blocker: "DEEPSEEK_API_KEY not set",
      output: "",
      usage: null,
    };
  }

  const prompt = codeQualityPrompt(code, files);
  const messages = [
    { role: "system" as const, content: prompt },
    { role: "user" as const, content: "Review the code for quality issues." },
  ];

  let fullOutput = "";
  const result = await consumeStream(apiKey, messages, [], "deepseek-v4-pro", {
    onText: (text) => { fullOutput += text; },
  });

  const parsed = parseStatusBlock(fullOutput);
  return {
    status: parsed.status,
    summary: parsed.summary,
    output: fullOutput,
    usage: result.usage,
  };
}

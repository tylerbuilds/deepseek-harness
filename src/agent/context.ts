// src/agent/context.ts

import fs from "node:fs";
import path from "node:path";
import { baseSystemPrompt } from "./prompts.js";
import { createToolRegistry } from "./tools.js";

const MAX_RECENT_MESSAGES = 25;
const PINNED_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "COPILOT.md"];

// ── Types defined inline (will move to session.ts in Task 4) ──

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: "function";
    function?: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface AgentSession {
  cwd: string;
}

function loadMessages(_session: AgentSession): ChatMessage[] {
  // TODO: Replace with actual store query when session.ts is implemented (Task 4)
  return [];
}

// ── Context Package ──

export interface ContextPackage {
  messages: ChatMessage[];
  estimatedTokens: number;
  summarised: boolean;
}

export function buildContext(session: AgentSession, userInput?: string): ContextPackage {
  const messages: ChatMessage[] = [];

  // 1. System prompt with tool descriptions
  const registry = createToolRegistry();
  messages.push({
    role: "system",
    content: baseSystemPrompt(registry.toolDescriptions()),
  });

  // 2. Pinned project context
  const pinned = readPinnedFiles(session.cwd);
  if (pinned) {
    messages.push({
      role: "system",
      content: `Project context:\n\n${pinned}`,
    });
  }

  // 3. Message history
  const allMessages = loadMessages(session);
  const totalMessages = allMessages.length;

  if (totalMessages <= MAX_RECENT_MESSAGES) {
    for (const msg of allMessages) {
      messages.push(msg);
    }
  } else {
    const recent = allMessages.slice(-MAX_RECENT_MESSAGES);
    const olderCount = totalMessages - MAX_RECENT_MESSAGES;
    messages.push({
      role: "system",
      content: `[${olderCount} earlier messages have been compressed. The most recent ${MAX_RECENT_MESSAGES} messages follow.]`,
    });
    for (const msg of recent) {
      messages.push(msg);
    }
  }

  // 4. Current user input
  if (userInput) {
    messages.push({ role: "user", content: userInput });
  }

  // 5. Estimate tokens (rough heuristic: 1 token ≈ 4 chars)
  const charCount = messages.reduce((sum, m) => {
    let chars = (m.content ?? "").length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    return sum + chars;
  }, 0);
  const estimatedTokens = Math.ceil(charCount / 4);

  return {
    messages,
    estimatedTokens,
    summarised: totalMessages > MAX_RECENT_MESSAGES,
  };
}

function readPinnedFiles(cwd: string): string | null {
  const parts: string[] = [];
  for (const filename of PINNED_FILES) {
    const filePath = path.join(cwd, filename);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      parts.push(`### ${filename}\n\n${content}`);
    } catch {
      // File doesn't exist, skip
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n---\n\n");
}

export function contextSummary(context: ContextPackage): string {
  return `Context: ${context.messages.length} messages, ~${context.estimatedTokens} tokens${context.summarised ? " (summarised)" : ""}`;
}

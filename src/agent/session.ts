// src/agent/session.ts

import { randomUUID } from "node:crypto";
import { HarnessStore, type MessageRecord, type SessionRecord } from "../store.js";

export interface AgentSession {
  id: string;
  cwd: string;
  model: string;
  store: HarnessStore;
  record: SessionRecord;
}

export function createSession(store: HarnessStore, cwd: string, model = "deepseek-v4-flash"): AgentSession {
  const id = `sess_${randomUUID().split("-").join("_").slice(0, 20)}`;
  const record = store.createSession(id, cwd, model);
  return { id, cwd, model, store, record };
}

export function resumeSession(store: HarnessStore, sessionId: string): AgentSession {
  const record = store.getSession(sessionId);
  return { id: record.id, cwd: record.cwd, model: record.model, store, record };
}

export function listSessions(store: HarnessStore, limit = 20): SessionRecord[] {
  return store.listSessions(limit);
}

export function addUserMessage(session: AgentSession, content: string): number {
  const id = session.store.addMessage(session.id, { role: "user", content });
  session.store.updateSession(session.id, {
    message_count: session.store.countMessages(session.id),
  });
  return id;
}

export function addAssistantMessage(
  session: AgentSession,
  content: string | null,
  toolCalls: unknown[] | null,
  tokenCount: number | null
): number {
  const id = session.store.addMessage(session.id, {
    role: "assistant",
    content,
    tool_calls_json: toolCalls ? JSON.stringify(toolCalls) : null,
    token_count: tokenCount,
  });
  session.store.updateSession(session.id, {
    message_count: session.store.countMessages(session.id),
    total_tokens: session.record.total_tokens + (tokenCount ?? 0),
  });
  return id;
}

export function addToolResult(session: AgentSession, toolCallId: string, content: string): number {
  return session.store.addMessage(session.id, {
    role: "tool",
    content,
    tool_call_id: toolCallId,
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export function loadMessages(session: AgentSession, limit?: number, offset?: number): ChatMessage[] {
  const records = session.store.getMessages(session.id, limit, offset);
  return records.map(toChatMessage);
}

function toChatMessage(record: MessageRecord): ChatMessage {
  const msg: ChatMessage = { role: record.role as ChatMessage["role"], content: record.content };
  if (record.tool_calls_json) {
    msg.tool_calls = JSON.parse(record.tool_calls_json);
  }
  if (record.tool_call_id) {
    msg.tool_call_id = record.tool_call_id;
  }
  return msg;
}

export function updateSessionSummary(session: AgentSession, summary: string): void {
  session.store.updateSession(session.id, { summary });
}

export function updateSessionCost(session: AgentSession, additionalCostUsd: number): void {
  session.store.updateSession(session.id, {
    total_cost_usd: session.record.total_cost_usd + additionalCostUsd,
  });
}

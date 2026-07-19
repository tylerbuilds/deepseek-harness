import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "../src/errors.js";
import type { AgentEvent } from "../src/agent/events.js";
import { agentTurn } from "../src/agent/loop.js";
import { createSession } from "../src/agent/session.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { HarnessStore, STATE_SCHEMA_VERSION } from "../src/store.js";

interface CapturedRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  stream_options?: Record<string, unknown>;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sseResponse(chunks: Array<Record<string, unknown>>): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function fakeFetchQueue(
  responses: Response[],
  requests: CapturedRequest[],
  urls: string[] = [],
): typeof fetch {
  return (async (url: URL | RequestInfo, init?: RequestInit) => {
    urls.push(url.toString());
    requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
    const response = responses.shift();
    assert.ok(response, "fake SSE response queue exhausted");
    return response;
  }) as typeof fetch;
}

function toolCallChunk(id: string, name: string, args = "{}"): Record<string, unknown> {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: "function",
          function: { name, arguments: args },
        }],
      },
    }],
  };
}

function usageChunk(totalTokens: number, cacheHitTokens = 0): Record<string, unknown> {
  const promptTokens = totalTokens - 2;
  return {
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 2,
      total_tokens: totalTokens,
      prompt_cache_hit_tokens: cacheHitTokens,
      prompt_cache_miss_tokens: promptTokens - cacheHitTokens,
    },
  };
}

test("agent protocol persists assistant tool calls first and round-trips reasoning", async () => {
  const stateDir = tempDir("deepseek-agent-protocol-");
  const workspace = tempDir("deepseek-agent-workspace-");
  const store = new HarnessStore(stateDir);
  const session = createSession(store, workspace);
  const registry = new ToolRegistry();
  const requests: CapturedRequest[] = [];
  const urls: string[] = [];
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  let recordsAtExecution: ReturnType<HarnessStore["getMessages"]> = [];
  let receivedSignal: AbortSignal | undefined;

  registry.register({
    definition: {
      name: "inspect_marker",
      description: "Inspect a marker",
      parameters: [{
        name: "path",
        type: "string",
        description: "Marker path",
        required: true,
      }],
    },
    tier: 1,
    async execute(_params, _cwd, signal) {
      receivedSignal = signal;
      recordsAtExecution = store.getMessages(session.id);
      return { content: "marker-ready", summary: "Marker inspected" };
    },
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = fakeFetchQueue([
      sseResponse([
        { choices: [{ delta: { reasoning_content: "Need " } }] },
        { choices: [{ delta: { reasoning_content: "a marker. " } }] },
        toolCallChunk("call_1", "inspect_marker", '{"path":"marker.txt"}'),
        usageChunk(11, 3),
      ]),
      sseResponse([
        { choices: [{ delta: { reasoning_content: "The marker is ready." } }] },
        { choices: [{ delta: { content: "Done." } }] },
        usageChunk(7),
      ]),
      sseResponse([
        { choices: [{ delta: { reasoning_content: "Use prior context." } }] },
        { choices: [{ delta: { content: "Still done." } }] },
        usageChunk(5),
      ]),
    ], requests, urls);

    await agentTurn(
      session,
      "test-key",
      "Inspect the marker",
      (event) => events.push(event),
      registry,
      {
        baseUrl: "http://fake-deepseek.local/v1/",
        signal: controller.signal,
      },
    );

    const firstTurnEvents = events.slice();
    await agentTurn(
      session,
      "test-key",
      "Use that result again",
      (event) => events.push(event),
      registry,
      { baseUrl: "http://fake-deepseek.local/v1/" },
    );

    assert.equal(receivedSignal, controller.signal);
    assert.deepEqual(
      recordsAtExecution.map((record) => record.role),
      ["user", "assistant"],
    );
    assert.equal(recordsAtExecution[1].reasoning_content, "Need a marker. ");
    assert.equal(recordsAtExecution[1].content, "");
    assert.equal(JSON.parse(recordsAtExecution[1].tool_calls_json!)[0].id, "call_1");

    const persisted = store.getMessages(session.id);
    assert.deepEqual(
      persisted.map((record) => record.role),
      ["user", "assistant", "tool", "assistant", "user", "assistant"],
    );
    assert.deepEqual(
      persisted
        .filter((record) => record.role === "assistant")
        .map((record) => record.reasoning_content),
      ["Need a marker. ", "The marker is ready.", "Use prior context."],
    );
    assert.ok(Math.abs(session.record.total_cost_usd - 0.0000036484) < 1e-12);

    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.deepEqual(
      requests[1].messages.slice(-2).map((message) => message.role),
      ["assistant", "tool"],
    );
    assert.equal(
      requests[1].messages.at(-2)?.reasoning_content,
      "Need a marker. ",
    );
    assert.equal(requests[1].messages.at(-2)?.content, "");
    assert.deepEqual(
      requests[2].messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoning_content),
      ["Need a marker. ", "The marker is ready."],
    );
    assert.deepEqual(urls, [
      "http://fake-deepseek.local/v1/chat/completions",
      "http://fake-deepseek.local/v1/chat/completions",
      "http://fake-deepseek.local/v1/chat/completions",
    ]);

    assert.deepEqual(
      firstTurnEvents.map((event) => event.type),
      [
        "reasoning_delta",
        "reasoning_delta",
        "usage",
        "tool_start",
        "tool_end",
        "reasoning_delta",
        "text_delta",
        "usage",
        "turn_complete",
      ],
    );
    const firstUsage = firstTurnEvents.find((event) => event.type === "usage");
    assert.deepEqual(firstUsage, {
      type: "usage",
      usage: {
        prompt_tokens: 9,
        completion_tokens: 2,
        total_tokens: 11,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 6,
      },
    });
    const completed = firstTurnEvents.at(-1);
    assert.deepEqual(completed, {
      type: "turn_complete",
      text: "Done.",
      reasoningContent: "Need a marker. The marker is ready.",
      toolCalls: 1,
      toolRounds: 1,
      tokens: 18,
    });
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test("agent turn exposes typed cancellation and tool bounds", async () => {
  const originalFetch = globalThis.fetch;
  try {
    {
      const store = new HarnessStore(tempDir("deepseek-agent-abort-"));
      const session = createSession(store, tempDir("deepseek-agent-abort-workspace-"));
      const controller = new AbortController();
      controller.abort();
      let fetched = false;
      globalThis.fetch = (async () => {
        fetched = true;
        return sseResponse([]);
      }) as typeof fetch;

      try {
        await assert.rejects(
          () => agentTurn(session, "test-key", "stop", () => {}, { signal: controller.signal }),
          (error: unknown) => error instanceof HarnessError && error.code === "agent_turn_aborted",
        );
        assert.equal(fetched, false);
        assert.equal(store.countMessages(session.id), 0);
      } finally {
        store.close();
      }
    }

    {
      const store = new HarnessStore(tempDir("deepseek-agent-call-limit-"));
      const session = createSession(store, tempDir("deepseek-agent-call-workspace-"));
      const registry = new ToolRegistry();
      let executions = 0;
      registry.register({
        definition: { name: "bounded", description: "Bounded tool", parameters: [] },
        tier: 1,
        async execute() {
          executions++;
          return { content: "ok", summary: "ok" };
        },
      });
      const requests: CapturedRequest[] = [];
      globalThis.fetch = fakeFetchQueue([
        sseResponse([{
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "bounded", arguments: "{}" } },
                { index: 1, id: "call_2", function: { name: "bounded", arguments: "{}" } },
              ],
            },
          }],
        }, usageChunk(9)]),
      ], requests);

      try {
        await assert.rejects(
          () => agentTurn(
            session,
            "test-key",
            "too many calls",
            () => {},
            registry,
            { maxToolCalls: 1 },
          ),
          (error: unknown) => error instanceof HarnessError
            && error.code === "agent_tool_call_limit_exceeded",
        );
        assert.equal(executions, 0);
        assert.equal(session.record.total_tokens, 9);
        assert.ok(session.record.total_cost_usd > 0);
      } finally {
        store.close();
      }
    }

    {
      const store = new HarnessStore(tempDir("deepseek-agent-round-limit-"));
      const session = createSession(store, tempDir("deepseek-agent-round-workspace-"));
      const registry = new ToolRegistry();
      let executions = 0;
      registry.register({
        definition: { name: "bounded", description: "Bounded tool", parameters: [] },
        tier: 1,
        async execute() {
          executions++;
          return { content: "ok", summary: "ok" };
        },
      });
      const requests: CapturedRequest[] = [];
      globalThis.fetch = fakeFetchQueue([
        sseResponse([toolCallChunk("call_1", "bounded"), usageChunk(7)]),
        sseResponse([toolCallChunk("call_2", "bounded"), usageChunk(9)]),
      ], requests);

      try {
        await assert.rejects(
          () => agentTurn(
            session,
            "test-key",
            "too many rounds",
            () => {},
            registry,
            { maxToolRounds: 1 },
          ),
          (error: unknown) => error instanceof HarnessError
            && error.code === "agent_tool_round_limit_exceeded",
        );
        assert.equal(executions, 1);
        assert.equal(requests.length, 2);
        assert.equal(session.record.total_tokens, 16);
        assert.ok(session.record.total_cost_usd > 0);
      } finally {
        store.close();
      }
    }

    {
      const store = new HarnessStore(tempDir("deepseek-agent-invalid-arguments-"));
      const session = createSession(store, tempDir("deepseek-agent-invalid-arguments-workspace-"));
      const registry = new ToolRegistry();
      let executions = 0;
      registry.register({
        definition: { name: "bounded", description: "Bounded tool", parameters: [] },
        tier: 1,
        async execute() {
          executions++;
          return { content: "unsafe", summary: "unsafe" };
        },
      });
      const events: AgentEvent[] = [];
      globalThis.fetch = fakeFetchQueue([
        sseResponse([toolCallChunk("call_invalid", "bounded", "[1,2,3]")]),
        sseResponse([{ choices: [{ delta: { content: "Recovered safely." } }] }]),
      ], []);

      try {
        await agentTurn(session, "test-key", "invalid arguments", (event) => events.push(event), registry);
        assert.equal(executions, 0);
        assert.equal(store.getMessages(session.id).find((message) => message.role === "tool")?.content, "Tool arguments were not a valid JSON object.");
        assert.ok(events.some((event) => event.type === "tool_end" && event.error === "invalid_tool_arguments"));
      } finally {
        store.close();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("schema version 2 message stores migrate reasoning content", () => {
  const stateDir = tempDir("deepseek-agent-schema-");
  const dbPath = path.join(stateDir, "deepseek-harness.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      token_count INTEGER,
      created_at TEXT NOT NULL
    );
    PRAGMA user_version = 2;
  `);
  legacy.close();

  const store = new HarnessStore(stateDir);
  try {
    assert.equal(store.schemaVersion, STATE_SCHEMA_VERSION);
    store.createSession("sess-reasoning", "/tmp", "deepseek-reasoner");
    store.addMessage("sess-reasoning", {
      role: "assistant",
      reasoning_content: "persist me",
    });
    assert.equal(
      store.getMessages("sess-reasoning")[0].reasoning_content,
      "persist me",
    );
  } finally {
    store.close();
  }
});

// test/agent-chat.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessStore } from "../src/store.js";
import { createSession, addUserMessage, loadMessages, addAssistantMessage, addToolResult } from "../src/agent/session.js";
import { buildContext } from "../src/agent/context.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { dispatchSubagent } from "../src/agent/dispatch.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-chat-"));
}

function approvedToolRegistry() {
  const registry = createToolRegistry();
  registry.setTier2Gate({
    async check() {
      return { allowed: true, scope: "once" };
    },
  });
  return registry;
}

test("session creates and persists messages", () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, "/tmp/test-project", "deepseek-v4-flash");
    assert.ok(session.id.startsWith("sess_"));
    assert.equal(session.model, "deepseek-v4-flash");

    addUserMessage(session, "Hello, can you help?");
    addAssistantMessage(session, "Of course!", null, 5);
    addUserMessage(session, "Read the file please");
    addAssistantMessage(session, null, [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ file_path: "/tmp/foo.txt" }) } }
    ], 15);
    addToolResult(session, "call_1", "file contents here");

    const msgs = loadMessages(session);
    assert.equal(msgs.length, 5);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content, "Hello, can you help?");
    assert.equal(msgs[3].role, "assistant");
    assert.ok(msgs[3].tool_calls);
    assert.equal(msgs[3].tool_calls![0].function.name, "read_file");
    assert.equal(msgs[4].role, "tool");
  } finally {
    store.close();
  }
});

test("buildContext assembles system prompt, pinned files, and history", () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const projectDir = tempDir();
    fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Test Project\n\nThese are workspace instructions.", "utf8");

    const session = createSession(store, projectDir, "deepseek-v4-flash");
    addUserMessage(session, "hello");

    const ctx = buildContext(session);
    assert.ok(ctx.messages.length >= 3); // system prompt + project context + user message
    const systemMsg = ctx.messages[0];
    assert.equal(systemMsg.role, "system");
    assert.ok(systemMsg.content?.includes("DeepSeek Harness Chat"));
    assert.ok(ctx.messages.some((m) => m.content?.includes("Test Project")));
    assert.ok(ctx.messages.some((m) => m.content === "hello"));
  } finally {
    store.close();
  }
});

test("buildContext never splits a tool-call turn at the recent-history boundary", () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    for (let i = 0; i < 5; i++) {
      addUserMessage(session, `old-${i}`);
    }
    addUserMessage(session, "tool turn starts here");
    addAssistantMessage(session, "", [
      { id: "call_boundary", type: "function", function: { name: "read_file", arguments: "{}" } },
    ], 1, "Need the file.");
    addToolResult(session, "call_boundary", "contents");
    addAssistantMessage(session, "finished", null, 1, "Done.");
    for (let i = 0; i < 23; i++) {
      addUserMessage(session, `new-${i}`);
    }

    const ctx = buildContext(session);
    const history = ctx.messages.filter((message) => message.role !== "system");
    const startIndex = history.findIndex((message) => message.content === "tool turn starts here");

    assert.equal(ctx.summarised, true);
    assert.ok(startIndex >= 0);
    assert.deepEqual(
      history.slice(startIndex, startIndex + 4).map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(history[startIndex + 1].reasoning_content, "Need the file.");
    assert.ok(ctx.messages.some((message) => message.content?.includes("earlier messages were omitted")));
  } finally {
    store.close();
  }
});

test("tool registry describes all 8 tools with correct names", () => {
  const registry = createToolRegistry();
  const described = registry.describe();
  assert.equal(described.length, 8);
  const names = described.map((d) => d.function.name).sort();
  assert.deepStrictEqual(names, [
    "delete_file",
    "edit_file",
    "list_directory",
    "read_file",
    "run_command",
    "search_content",
    "search_files",
    "write_file",
  ]);
});

test("read_file tool works", async () => {
  const registry = createToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "line one\nline two\n", "utf8");

  const result = await registry.execute("read_file", { file_path: filePath }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.content.includes("line one"));
  assert.ok(result.summary.includes("test.txt"));
});

test("write_file tool creates file", async () => {
  const registry = approvedToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "nested", "out.txt");

  const result = await registry.execute("write_file", { file_path: filePath, content: "test content" }, dir);
  assert.equal(result.error, undefined);
  assert.equal(fs.readFileSync(filePath, "utf8"), "test content");
});

test("edit_file replaces text", async () => {
  const registry = approvedToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "edit.txt");
  fs.writeFileSync(filePath, "const A = 1;\nconst B = 2;\n", "utf8");

  const result = await registry.execute("edit_file", {
    file_path: filePath,
    old_string: "const A = 1;",
    new_string: "const A = 42;",
  }, dir);
  assert.equal(result.error, undefined);
  assert.ok(fs.readFileSync(filePath, "utf8").includes("const A = 42;"));
});

test("delete_file blocked without tier 2 approval", async () => {
  const registry = createToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "target.txt");
  fs.writeFileSync(filePath, "keep me", "utf8");

  const result = await registry.execute("delete_file", { file_path: filePath }, dir);
  assert.ok(result.error);
  assert.ok(result.error.includes("approval_required"));
  assert.ok(fs.existsSync(filePath));
});

test("dispatchSubagent blocked without API key", async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await dispatchSubagent({
      task: "Write a hello world function in TypeScript",
    });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blocker?.includes("DEEPSEEK_API_KEY"));
  } finally {
    if (originalKey) process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

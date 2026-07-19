import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessStore } from "../src/store.js";

function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-agent-store-"));
}

test("createSession stores and retrieves session", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    const session = store.createSession("sess-1", "/home/user/project", "deepseek-v4-flash");
    assert.equal(session.id, "sess-1");
    assert.equal(session.cwd, "/home/user/project");
    assert.equal(session.model, "deepseek-v4-flash");
    assert.equal(session.message_count, 0);
    assert.equal(session.total_tokens, 0);
  } finally {
    store.close();
  }
});

test("getSession throws for missing session", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    assert.throws(() => store.getSession("nonexistent"), { code: "session_not_found" });
  } finally {
    store.close();
  }
});

test("listSessions returns sessions ordered by updated_at", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-a", "/a", "deepseek-v4-flash");
    store.createSession("sess-b", "/b", "deepseek-v4-pro");
    const sessions = store.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, "sess-b"); // most recent first
  } finally {
    store.close();
  }
});

test("addMessage and getMessages store and retrieve chat messages", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/project", "deepseek-v4-flash");
    store.addMessage("sess-1", { role: "user", content: "hello" });
    store.addMessage("sess-1", { role: "assistant", content: "hi there", token_count: 42 });
    store.addMessage("sess-1", { role: "tool", content: "result", tool_call_id: "call_1" });

    const messages = store.getMessages("sess-1");
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].token_count, 42);
    assert.equal(messages[2].tool_call_id, "call_1");
  } finally {
    store.close();
  }
});

test("getMessages with limit and offset", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/p", "deepseek-v4-flash");
    store.addMessage("sess-1", { role: "user", content: "a" });
    store.addMessage("sess-1", { role: "assistant", content: "b" });
    store.addMessage("sess-1", { role: "user", content: "c" });
    store.addMessage("sess-1", { role: "assistant", content: "d" });

    const page = store.getMessages("sess-1", 2, 1);
    assert.equal(page.length, 2);
    assert.equal(page[0].content, "b");
    assert.equal(page[1].content, "c");
  } finally {
    store.close();
  }
});

test("updateSession modifies metadata", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/p", "deepseek-v4-flash");
    store.updateSession("sess-1", { summary: "fixed the auth bug", message_count: 12, total_tokens: 1500, total_cost_usd: 0.003 });
    const session = store.getSession("sess-1");
    assert.equal(session.summary, "fixed the auth bug");
    assert.equal(session.message_count, 12);
    assert.equal(session.total_tokens, 1500);
  } finally {
    store.close();
  }
});

test("deleteSession cascade-deletes messages", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/p", "deepseek-v4-flash");
    store.addMessage("sess-1", { role: "user", content: "hello" });
    store.deleteSession("sess-1");
    assert.throws(() => store.getSession("sess-1"), { code: "session_not_found" });
    assert.equal(store.getMessages("sess-1").length, 0);
  } finally {
    store.close();
  }
});

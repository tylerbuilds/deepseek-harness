import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPlainApprovalGate,
  createSessionApprovalGate,
  formatApprovalRequest,
  selectChatMode,
} from "../src/agent/cli.js";
import { loadCorpusJobs } from "../src/agent/jobs.js";
import {
  composerSegments,
  initialTuiState,
  shouldExitOnCtrlD,
  transcriptLines,
  tuiReducer,
} from "../src/agent/tui-state.js";

test("selectChatMode chooses TUI only for an unforced interactive terminal", () => {
  // Given
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };

  // When
  const automatic = selectChatMode({}, tty);
  const plain = selectChatMode({ plain: true }, tty);
  const prompt = selectChatMode({ prompt: "status" }, tty);
  const piped = selectChatMode({}, { stdinIsTTY: false, stdoutIsTTY: true });

  // Then
  assert.equal(automatic, "tui");
  assert.equal(plain, "plain");
  assert.equal(prompt, "prompt");
  assert.equal(piped, "plain");
});

test("selectChatMode rejects forced TUI without two TTY streams", () => {
  // Given
  const piped = { stdinIsTTY: true, stdoutIsTTY: false };

  // When / Then
  assert.throws(
    () => selectChatMode({ tui: true }, piped),
    (error: unknown) => error instanceof Error && error.message.includes("requires a TTY"),
  );
});

test("selectChatMode rejects mutually exclusive mode flags", () => {
  // Given
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };

  // When / Then
  assert.throws(
    () => selectChatMode({ plain: true, tui: true }, tty),
    (error: unknown) => error instanceof Error && error.message.includes("mutually exclusive"),
  );
});

test("session approval caches only the approved tool name", async () => {
  // Given
  const requested: string[] = [];
  const gate = createSessionApprovalGate(async (request) => {
    requested.push(request.toolName);
    return "session";
  });

  // When
  const first = await gate.check("write_file", { file_path: "/tmp/a" });
  const cached = await gate.check("write_file", { file_path: "/tmp/b" });
  const differentTool = await gate.check("run_command", { command: "pwd" });

  // Then
  assert.equal(first.allowed, true);
  assert.equal(cached.allowed, true);
  assert.equal(differentTool.allowed, true);
  assert.deepEqual(requested, ["write_file", "run_command"]);
});

test("one-shot and declined approvals are never cached", async () => {
  // Given
  const choices = ["once", "decline"] as const;
  let requestCount = 0;
  const gate = createSessionApprovalGate(async () => choices[requestCount++] ?? "decline");

  // When
  const once = await gate.check("edit_file", { file_path: "/tmp/a" });
  const declined = await gate.check("edit_file", { file_path: "/tmp/a" });

  // Then
  assert.equal(once.allowed, true);
  assert.equal(once.scope, "once");
  assert.equal(declined.allowed, false);
  assert.equal(requestCount, 2);
});

test("plain approval denies without consulting input outside a real TTY", async () => {
  // Given
  let prompted = false;
  const gate = createPlainApprovalGate(false, async () => {
    prompted = true;
    return "session";
  });

  // When
  const decision = await gate.check("write_file", { file_path: "/tmp/a" });

  // Then
  assert.equal(decision.allowed, false);
  assert.equal(prompted, false);
});

test("approval formatting identifies the exact tool and parameters", () => {
  // Given
  const request = {
    toolName: "run_command",
    params: { command: "npm test", timeout_ms: 30000 },
  };

  // When
  const formatted = formatApprovalRequest(request);

  // Then
  assert.equal(
    formatted,
    "Tool: run_command\nParameters:\n{\n  \"command\": \"npm test\",\n  \"timeout_ms\": 30000\n}",
  );
});

test("loadCorpusJobs returns recent valid ledger display data", () => {
  // Given
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-tui-jobs-"));
  const corpusRoot = path.join(artifactRoot, "corpus");
  fs.mkdirSync(path.join(corpusRoot, "older"), { recursive: true });
  fs.mkdirSync(path.join(corpusRoot, "newer"), { recursive: true });
  fs.mkdirSync(path.join(corpusRoot, "broken"), { recursive: true });
  fs.writeFileSync(path.join(corpusRoot, "older", "ledger.json"), JSON.stringify({
    job_id: "older-job",
    project: "archive",
    status: "completed",
    updated_at: "2026-07-18T09:00:00.000Z",
    shards: [{ status: "succeeded" }, { status: "succeeded" }],
  }));
  fs.writeFileSync(path.join(corpusRoot, "newer", "ledger.json"), JSON.stringify({
    job_id: "newer-job",
    project: "translation",
    status: "running",
    updated_at: "2026-07-19T09:00:00.000Z",
    shards: [{ status: "succeeded" }, { status: "running" }, { status: "pending" }],
  }));
  fs.writeFileSync(path.join(corpusRoot, "broken", "ledger.json"), "not-json");

  // When
  const jobs = loadCorpusJobs(artifactRoot, 5);

  // Then
  assert.deepEqual(jobs, [
    {
      jobId: "newer-job",
      project: "translation",
      status: "running",
      updatedAt: "2026-07-19T09:00:00.000Z",
      completedShards: 1,
      totalShards: 3,
    },
    {
      jobId: "older-job",
      project: "archive",
      status: "completed",
      updatedAt: "2026-07-18T09:00:00.000Z",
      completedShards: 2,
      totalShards: 2,
    },
  ]);
});

test("tuiReducer represents reasoning, tool activity and completed text", () => {
  // Given
  const actions = [
    { type: "submit", input: "inspect the repo" },
    { type: "event", event: { type: "reasoning_delta", delta: "Checking structure" } },
    { type: "event", event: { type: "text_delta", delta: "I will inspect first." } },
    { type: "event", event: { type: "tool_start", toolCallId: "call-1", name: "search_files", params: { pattern: "*.ts" } } },
    { type: "event", event: { type: "tool_end", toolCallId: "call-1", name: "search_files", summary: "8 files" } },
    { type: "event", event: { type: "text_delta", delta: "Found the source." } },
    { type: "event", event: { type: "turn_complete", text: "Found the source.", reasoningContent: "Checking structure", toolCalls: 1, toolRounds: 1, tokens: 42 } },
  ] as const;

  // When
  const state = actions.reduce(tuiReducer, initialTuiState());
  const lines = transcriptLines(state, 20);

  // Then
  assert.equal(state.status, "idle");
  assert.equal(state.tokens, 42);
  assert.deepEqual(lines, [
    "you › inspect the repo",
    "reasoning › Checking structure",
    "deepseek › I will inspect first.",
    "tool › search_files {\"pattern\":\"*.ts\"}",
    "tool ✓ search_files — 8 files",
    "deepseek › Found the source.",
  ]);
});

test("transcriptLines keeps the most recent bounded rows", () => {
  // Given
  const state = ["one", "two", "three", "four"].reduce(
    (current, message) => tuiReducer(current, { type: "message", message }),
    initialTuiState(),
  );

  // When
  const lines = transcriptLines(state, 2);

  // Then
  assert.deepEqual(lines, ["system › three", "system › four"]);
});

test("composerSegments exposes the cursor without changing the draft", () => {
  // Given
  const draft = "abcd";

  // When
  const segments = composerSegments(draft, 2);

  // Then
  assert.deepEqual(segments, { before: "ab", cursor: "c", after: "d" });
});

test("Ctrl-D exits only when the composer is empty", () => {
  // Given
  const emptyDraft = "";
  const activeDraft = "keep this";

  // When
  const emptyDecision = shouldExitOnCtrlD(emptyDraft);
  const activeDecision = shouldExitOnCtrlD(activeDraft);

  // Then
  assert.equal(emptyDecision, true);
  assert.equal(activeDecision, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "../src/agent/tools.js";

const registry = createToolRegistry();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-tools-"));
}

function allowTier2(registry: ReturnType<typeof createToolRegistry>, requests?: Array<{ toolName: string; params: Record<string, unknown> }>) {
  registry.setTier2Gate({
    async check(toolName, params) {
      requests?.push({ toolName, params });
      return { allowed: true, scope: "once" };
    },
  });
  return registry;
}

test("tool registry describes all 8 tools as function definitions", () => {
  const described = registry.describe();
  assert.equal(described.length, 8);
  for (const def of described) {
    assert.equal(def.type, "function");
    assert.ok(def.function.name.length > 0);
    assert.ok(def.function.description.length > 0);
  }
});

test("read_file returns numbered lines", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "line one\nline two\nline three\n", "utf8");
  const result = await registry.execute("read_file", { file_path: filePath }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.content.includes("     1\tline one"));
  assert.ok(result.content.includes("     2\tline two"));
  assert.ok(result.summary.includes("test.txt"));
});

test("read_file rejects relative paths", async () => {
  const result = await registry.execute("read_file", { file_path: "relative/path.txt" }, "/tmp");
  assert.ok(result.error);
});

test("write_file creates file and parent directories", async () => {
  const approvedRegistry = allowTier2(createToolRegistry());
  const dir = tempDir();
  const filePath = path.join(dir, "nested", "subdir", "out.txt");
  const result = await approvedRegistry.execute("write_file", { file_path: filePath, content: "hello world" }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.summary.includes("out.txt"));
  assert.equal(fs.readFileSync(filePath, "utf8"), "hello world");
});

test("edit_file replaces exact string", async () => {
  const approvedRegistry = allowTier2(createToolRegistry());
  const dir = tempDir();
  const filePath = path.join(dir, "edit.txt");
  fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n", "utf8");
  const result = await approvedRegistry.execute("edit_file", {
    file_path: filePath,
    old_string: "const x = 1;",
    new_string: "const x = 42;",
  }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.summary.includes("edit.txt"));
  assert.ok(fs.readFileSync(filePath, "utf8").includes("const x = 42;"));
});

test("edit_file fails when old_string is not unique", async () => {
  const approvedRegistry = allowTier2(createToolRegistry());
  const dir = tempDir();
  const filePath = path.join(dir, "dup.txt");
  fs.writeFileSync(filePath, "foo\nfoo\n", "utf8");
  const result = await approvedRegistry.execute("edit_file", {
    file_path: filePath,
    old_string: "foo",
    new_string: "bar",
  }, dir);
  assert.ok(result.error);
});

test("edit_file fails when old and new strings are identical", async () => {
  const approvedRegistry = allowTier2(createToolRegistry());
  const dir = tempDir();
  const filePath = path.join(dir, "same.txt");
  fs.writeFileSync(filePath, "hello", "utf8");
  const result = await approvedRegistry.execute("edit_file", {
    file_path: filePath,
    old_string: "hello",
    new_string: "hello",
  }, dir);
  assert.ok(result.error);
});

test("search_content finds matches", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.ts"), "const API_KEY = 'secret';", "utf8");
  fs.writeFileSync(path.join(dir, "b.ts"), "const apiKey = process.env.KEY;", "utf8");
  const result = await registry.execute("search_content", { pattern: "KEY", directory: dir }, dir);
  assert.ok(result.summary.includes("matches"));
});

test("list_directory returns entries with type indicators", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "", "utf8");
  fs.mkdirSync(path.join(dir, "subdir"));
  const result = await registry.execute("list_directory", { directory: dir }, dir);
  assert.ok(result.content.includes("a.txt"));
  assert.ok(result.content.includes("subdir/"));
});

test("unknown tool returns error", async () => {
  const result = await registry.execute("nonexistent_tool", {}, "/tmp");
  assert.ok(result.error);
});

test("tier 2 tools blocked without gate authorisation", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "target.txt");
  fs.writeFileSync(filePath, "delete me", "utf8");
  const result = await registry.execute("delete_file", { file_path: filePath }, dir);
  assert.ok(result.error);
  assert.ok(result.error.includes("approval_required"));
  assert.ok(fs.existsSync(filePath)); // file still exists
});

test("mutating tools and shell commands fail closed before approval", async () => {
  const dir = tempDir();
  const target = path.join(dir, "target.txt");
  const edited = path.join(dir, "edited.txt");
  const marker = path.join(dir, "command-ran");
  fs.writeFileSync(target, "keep", "utf8");
  fs.writeFileSync(edited, "before", "utf8");

  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`;
  const calls = [
    ["write_file", { file_path: path.join(dir, "new.txt"), content: "blocked" }],
    ["edit_file", { file_path: edited, old_string: "before", new_string: "after" }],
    ["run_command", { command }],
    ["delete_file", { file_path: target }],
  ] as const;

  for (const [name, params] of calls) {
    const result = await registry.execute(name, params, dir);
    assert.equal(result.error, "approval_required");
  }

  assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
  assert.equal(fs.readFileSync(edited, "utf8"), "before");
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(target), true);
});

test("approval receives exact tool data and each allowed call executes once", async () => {
  const dir = tempDir();
  const requests: Array<{ toolName: string; params: Record<string, unknown> }> = [];
  const approvedRegistry = allowTier2(createToolRegistry(), requests);
  const filePath = path.join(dir, "created.txt");
  const marker = path.join(dir, "command-ran");
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`)}`;
  const writeParams = { file_path: filePath, content: "created" };
  const commandParams = { command };

  const writeResult = await approvedRegistry.execute("write_file", writeParams, dir);
  const commandResult = await approvedRegistry.execute("run_command", commandParams, dir);

  assert.equal(writeResult.error, undefined);
  assert.equal(commandResult.error, undefined);
  assert.equal(fs.readFileSync(filePath, "utf8"), "created");
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  assert.deepEqual(requests, [
    { toolName: "write_file", params: writeParams },
    { toolName: "run_command", params: commandParams },
  ]);
});

test("once and session scopes remain explicit and are not cached by the registry", async () => {
  const dir = tempDir();
  const requests: string[] = [];
  const approvedRegistry = createToolRegistry();
  approvedRegistry.setTier2Gate({
    async check(toolName) {
      requests.push(toolName);
      return { allowed: true, scope: requests.length === 1 ? "session" : "once" };
    },
  });

  await approvedRegistry.execute("write_file", { file_path: path.join(dir, "one.txt"), content: "1" }, dir);
  await approvedRegistry.execute("write_file", { file_path: path.join(dir, "two.txt"), content: "2" }, dir);

  assert.deepEqual(requests, ["write_file", "write_file"]);
});

test("run_command honours an AbortSignal", async () => {
  const dir = tempDir();
  const marker = path.join(dir, "cancelled-command-ran");
  const approvedRegistry = allowTier2(createToolRegistry());
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 1000)`)}`;
  const controller = new AbortController();
  const execution = approvedRegistry.execute("run_command", { command }, dir, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const result = await execution;

  assert.equal(result.error, "aborted");
  assert.match(result.summary, /cancel/i);
  assert.equal(fs.existsSync(marker), false);
});

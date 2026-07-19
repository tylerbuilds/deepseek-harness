import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "../src/errors.js";
import { HarnessStore, STATE_SCHEMA_VERSION } from "../src/store.js";

test("new and legacy state directories migrate to the supported schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-state-schema-"));
  const store = new HarnessStore(root);
  try {
    assert.equal(store.schemaVersion, STATE_SCHEMA_VERSION);
    const row = store.db.prepare("PRAGMA user_version;").get() as { user_version?: number };
    assert.equal(row.user_version, STATE_SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test("newer state schemas are refused without mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-state-newer-"));
  const dbPath = path.join(root, "deepseek-harness.sqlite");
  const newerVersion = STATE_SCHEMA_VERSION + 1;
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${newerVersion};`);
  db.close();

  assert.throws(
    () => new HarnessStore(root),
    (error: unknown) => {
      assert.equal(error instanceof HarnessError, true);
      const harnessError = error as HarnessError;
      assert.equal(harnessError.code, "state_schema_too_new");
      assert.match(harnessError.message, /Upgrade deepseek-harness/);
      return true;
    }
  );

  const verification = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = verification.prepare("PRAGMA user_version;").get() as { user_version?: number };
    assert.equal(row.user_version, newerVersion);
  } finally {
    verification.close();
  }
});

test("concurrent legacy state opens serialise the reasoning-column migration", { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-state-concurrent-migration-"));
  const dbPath = path.join(root, "deepseek-harness.sqlite");
  const barrier = path.join(root, "start");
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

  const storeModule = new URL("../src/store.js", import.meta.url).href;
  const childCode = `
    import fs from "node:fs";
    import { HarnessStore } from ${JSON.stringify(storeModule)};
    while (!fs.existsSync(process.argv[2])) await new Promise((resolve) => setTimeout(resolve, 5));
    const store = new HarnessStore(process.argv[1]);
    store.close();
  `;
  const children = Array.from({ length: 8 }, () => spawn(
    process.execPath,
    ["--input-type=module", "--eval", childCode, root, barrier],
    { stdio: ["ignore", "ignore", "pipe"] },
  ));
  fs.writeFileSync(barrier, "go");

  const outcomes = await Promise.all(children.map((child) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stderr }));
  })));

  assert.deepEqual(outcomes, Array.from({ length: 8 }, () => ({ code: 0, stderr: "" })));
  const verification = new HarnessStore(root);
  try {
    const columns = verification.db.prepare("PRAGMA table_info(messages);").all() as Array<{ name: string }>;
    assert.equal(columns.filter((column) => column.name === "reasoning_content").length, 1);
    assert.equal(verification.schemaVersion, STATE_SCHEMA_VERSION);
  } finally {
    verification.close();
  }
});

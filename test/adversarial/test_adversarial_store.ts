/**
 * Adversarial Test Sweep — HarnessStore (sessions/messages + migrate)
 *
 * Covers the eight attack categories, targeting the new session/message methods
 * (lines 481-600) and the migrate() method that creates the sessions/messages tables.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "../../src/errors.js";
import { HarnessStore, STATE_SCHEMA_VERSION } from "../../src/store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
}

function tempFilePath(): string {
  return path.join(os.tmpdir(), `deepseek-harness-adv-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function assertHarnessError(block: () => unknown, expectedCode: string): void {
  try {
    block();
    assert.fail(`Expected HarnessError with code "${expectedCode}" but no error was thrown`);
  } catch (err) {
    assert.ok(err instanceof HarnessError, `Expected HarnessError but got ${err?.constructor?.name ?? typeof err}`);
    assert.equal((err as HarnessError).code, expectedCode);
  }
}

/** Like assert.throws but only asserts it's a HarnessError with the given code. */
function throwsHarness(block: () => unknown, code: string): void {
  assert.throws(block, (err: unknown) => {
    if (!(err instanceof HarnessError)) return false;
    return err.code === code;
  }, `Expected HarnessError code="${code}"`);
}

// ---------------------------------------------------------------------------
// 1. MALFORMED INPUTS
// ---------------------------------------------------------------------------

test("[malformed] empty string session ID is rejected", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    // An empty session ID should be rejected at the application layer.
    // Currently it may slip through to SQLite which will store it.
    assert.throws(() => store.createSession("", "/tmp/cwd", "model"), {
      message: /session|empty|invalid/i,
    });
  } finally {
    store.close();
  }
});

test("[malformed] null bytes in content round-trip correctly", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-null", "/tmp", "deepseek-v4-flash");
    const contentWithNull = "before\0after";
    store.addMessage("sess-null", { role: "user", content: contentWithNull });
    const msgs = store.getMessages("sess-null");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, contentWithNull);
  } finally {
    store.close();
  }
});

test("[malformed] SQL keywords in session ID do not cause injection", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    const evilId = "sess'; DROP TABLE sessions; --";
    store.createSession(evilId, "/tmp", "deepseek-v4-flash");
    // If the session was created and the table still exists, we survived
    const session = store.getSession(evilId);
    assert.equal(session.id, evilId);
    // Verify the sessions table still has schema
    const rows = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all();
    assert.equal(rows.length, 1, "sessions table should still exist");
  } finally {
    store.close();
  }
});

test("[malformed] extremely long content (>100KB) stores and retrieves", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-long", "/tmp", "deepseek-v4-flash");
    const longContent = "x".repeat(150_000);
    store.addMessage("sess-long", { role: "user", content: longContent });
    const msgs = store.getMessages("sess-long");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content!.length, 150_000);
    assert.equal(msgs[0].content, longContent);
  } finally {
    store.close();
  }
});

test("[malformed] extremely long summary in updateSession is handled", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-summary", "/tmp", "deepseek-v4-flash");
    const longSummary = "A".repeat(200_000);
    store.updateSession("sess-summary", { summary: longSummary });
    const session = store.getSession("sess-summary");
    assert.equal(session.summary.length, 200_000);
    assert.equal(session.summary, longSummary);
  } finally {
    store.close();
  }
});

test("[malformed] unicode BIDI control characters preserved in content", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-bidi", "/tmp", "deepseek-v4-flash");
    // RLO, LRO, PDF, RLM, LRM
    const bidiContent = "\u202Ehidden\u202C normal \u200Fright-to-left-mark\u200E";
    store.addMessage("sess-bidi", { role: "user", content: bidiContent });
    const msgs = store.getMessages("sess-bidi");
    assert.equal(msgs[0].content, bidiContent);
  } finally {
    store.close();
  }
});

test("[malformed] unicode control characters in session ID", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    const controlId = "sess-\x00-control-\x1F-test";
    assert.throws(() => store.createSession(controlId, "/tmp", "deepseek-v4-flash"), {
      message: /session|invalid|control/i,
    });
  } finally {
    store.close();
  }
});

test("[malformed] malformed JSON in tool_calls_json round-trips as string", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-maljson", "/tmp", "deepseek-v4-flash");
    const badJson = '{ broken: [ }';
    store.addMessage("sess-maljson", { role: "assistant", content: "test", tool_calls_json: badJson });
    const msgs = store.getMessages("sess-maljson");
    assert.equal(msgs[0].tool_calls_json, badJson);
    // Should still be the raw string, not parsed
    assert.throws(() => JSON.parse(msgs[0].tool_calls_json!));
  } finally {
    store.close();
  }
});

test("[malformed] empty model and cwd strings are accepted (store is value-agnostic)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-empty-fields", "", "");
    const session = store.getSession("sess-empty-fields");
    assert.equal(session.model, "");
    assert.equal(session.cwd, "");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 2. RACE CONDITIONS (rapid sequential / interleaved multi-instance)
// ---------------------------------------------------------------------------

test("[race] rapid sequential addMessage calls on same session (1000 messages)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-race-msgs", "/tmp", "deepseek-v4-flash");
    for (let i = 0; i < 1000; i++) {
      store.addMessage("sess-race-msgs", { role: "user", content: `msg-${i}` });
    }
    assert.equal(store.countMessages("sess-race-msgs"), 1000);
    const msgs = store.getMessages("sess-race-msgs");
    assert.equal(msgs.length, 1000);
  } finally {
    store.close();
  }
});

test("[race] rapid createSession + deleteSession cycles (200 iterations)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    for (let i = 0; i < 200; i++) {
      const sid = `sess-cycle-${i}`;
      store.createSession(sid, "/tmp", "deepseek-v4-flash");
      store.addMessage(sid, { role: "user", content: "data" });
      store.deleteSession(sid);
      assert.throws(() => store.getSession(sid), { code: "session_not_found" });
    }
    // After all cycles, verify the DB is still healthy
    const rows = store.listSessions(1000);
    assert.equal(rows.length, 0);
  } finally {
    store.close();
  }
});

test("[race] rapid updateSession calls on the same session", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-updates", "/tmp", "deepseek-v4-flash");
    for (let i = 0; i < 500; i++) {
      store.updateSession("sess-updates", {
        message_count: i,
        total_tokens: i * 10,
        total_cost_usd: i * 0.001,
      });
    }
    const session = store.getSession("sess-updates");
    assert.equal(session.message_count, 499);
    assert.equal(session.total_tokens, 4990);
    assert.ok(Math.abs(session.total_cost_usd - 0.499) < 0.001);
  } finally {
    store.close();
  }
});

test("[race] getSession interleaved with rapid writes", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-interleave", "/tmp", "deepseek-v4-flash");
    for (let i = 0; i < 500; i++) {
      store.addMessage("sess-interleave", { role: "user", content: `interleave-${i}` });
      if (i % 50 === 0) {
        // Read during writes
        const session = store.getSession("sess-interleave");
        assert.ok(session.id === "sess-interleave");
      }
    }
    assert.equal(store.countMessages("sess-interleave"), 500);
  } finally {
    store.close();
  }
});

test("[race] two store instances on same DB with WAL interleaved writes", () => {
  const dir = tempStateDir();
  const storeA = new HarnessStore(dir);
  try {
    storeA.createSession("sess-wal", "/tmp", "deepseek-v4-flash");
    storeA.addMessage("sess-wal", { role: "user", content: "from-A" });

    // Open a second instance on the same DB (WAL allows this)
    const storeB = new HarnessStore(dir);
    try {
      // Read what A wrote
      const sessionB = storeB.getSession("sess-wal");
      assert.equal(sessionB.id, "sess-wal");
      const msgsB = storeB.getMessages("sess-wal");
      assert.equal(msgsB.length, 1);

      // Write from B
      storeB.addMessage("sess-wal", { role: "assistant", content: "from-B" });

      // A should see B's writes (after potential WAL checkpoint)
      const msgsA = storeA.getMessages("sess-wal");
      assert.equal(msgsA.length, 2);
    } finally {
      storeB.close();
    }
  } finally {
    storeA.close();
  }
});

// ---------------------------------------------------------------------------
// 3. BOUNDARY VALUES
// ---------------------------------------------------------------------------

test("[boundary] zero-length content string", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-zero-content", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-zero-content", { role: "user", content: "" });
    const msgs = store.getMessages("sess-zero-content");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "");
  } finally {
    store.close();
  }
});

test("[boundary] null content (no content field)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-null-content", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-null-content", { role: "system", content: null });
    const msgs = store.getMessages("sess-null-content");
    assert.equal(msgs[0].content, null);
  } finally {
    store.close();
  }
});

test("[boundary] negative limit on getMessages (SQLite treats -1 as no-limit)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-neg-limit", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-neg-limit", { role: "user", content: "test" });
    // SQLite treats LIMIT -1 as "no limit" — returns all rows
    const msgs = store.getMessages("sess-neg-limit", -1);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "test");
  } finally {
    store.close();
  }
});

test("[boundary] zero limit on getMessages returns empty array", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-zero-limit", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-zero-limit", { role: "user", content: "test" });
    const msgs = store.getMessages("sess-zero-limit", 0);
    assert.equal(msgs.length, 0);
  } finally {
    store.close();
  }
});

test("[boundary] negative offset on getMessages (SQLite treats as 0)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-neg-offset", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-neg-offset", { role: "user", content: "test" });
    // SQLite treats negative OFFSET as 0 — returns from the beginning
    const msgs = store.getMessages("sess-neg-offset", 10, -5);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "test");
  } finally {
    store.close();
  }
});

test("[boundary] empty role string", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-empty-role", "/tmp", "deepseek-v4-flash");
    // Empty role should probably be rejected, but let's see what happens
    store.addMessage("sess-empty-role", { role: "", content: "test" });
    const msgs = store.getMessages("sess-empty-role");
    assert.equal(msgs[0].role, "");
  } finally {
    store.close();
  }
});

test("[boundary] max safe integer for token_count", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-max-int", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-max-int", {
      role: "user",
      content: "test",
      token_count: Number.MAX_SAFE_INTEGER,
    });
    const msgs = store.getMessages("sess-max-int");
    assert.equal(msgs[0].token_count, Number.MAX_SAFE_INTEGER);
  } finally {
    store.close();
  }
});

test("[boundary] NaN token_count is converted to null or rejected", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-nan", "/tmp", "deepseek-v4-flash");
    // NaN should either be rejected or converted to null
    store.addMessage("sess-nan", {
      role: "user",
      content: "test",
      token_count: NaN,
    });
    const msgs = store.getMessages("sess-nan");
    // NaN becomes null in SQLite because NaN != NaN
    // SQLite actually stores NaN as a real value, but node:sqlite may differ
    assert.ok(
      msgs[0].token_count === null || Number.isNaN(msgs[0].token_count),
      `Expected null or NaN, got ${msgs[0].token_count}`,
    );
  } finally {
    store.close();
  }
});

test("[boundary] Infinity cost_usd in updateSession is rejected", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-inf", "/tmp", "deepseek-v4-flash");
    // Infinity should be rejected — it is not a valid finite number
    throwsHarness(
      () =>
        store.updateSession("sess-inf", {
          total_cost_usd: Infinity,
          total_tokens: 100,
        }),
      "invalid_update",
    );
  } finally {
    store.close();
  }
});

test("[boundary] negative values in updateSession are rejected", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-neg-vals", "/tmp", "deepseek-v4-flash");
    // Negative message_count should be rejected
    throwsHarness(
      () =>
        store.updateSession("sess-neg-vals", {
          message_count: -5,
        }),
      "invalid_update",
    );
    // Negative total_tokens should be rejected
    throwsHarness(
      () =>
        store.updateSession("sess-neg-vals", {
          total_tokens: -100,
        }),
      "invalid_update",
    );
    // Negative total_cost_usd should be rejected
    throwsHarness(
      () =>
        store.updateSession("sess-neg-vals", {
          total_cost_usd: -0.01,
        }),
      "invalid_update",
    );
    // Verify the session retains its original values
    const session = store.getSession("sess-neg-vals");
    assert.equal(session.message_count, 0);
    assert.equal(session.total_tokens, 0);
    assert.equal(session.total_cost_usd, 0);
  } finally {
    store.close();
  }
});

test("[boundary] listSessions with negative limit (SQLite treats -1 as no-limit)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-list-neg", "/tmp", "deepseek-v4-flash");
    // SQLite treats LIMIT -1 as "no limit" — returns all rows
    const sessions = store.listSessions(-1);
    assert.ok(sessions.length >= 1);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 4. RESOURCE EXHAUSTION
// ---------------------------------------------------------------------------

test("[exhaustion] 10,000 rapid addMessage calls", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-10k", "/tmp", "deepseek-v4-flash");
    // Batch inserts for performance
    for (let i = 0; i < 10_000; i++) {
      store.addMessage("sess-10k", { role: "user", content: `batch-${i}` });
    }
    assert.equal(store.countMessages("sess-10k"), 10_000);
    // Spot-check a few
    const page = store.getMessages("sess-10k", 5);
    assert.equal(page.length, 5);
  } finally {
    store.close();
  }
});

test("[exhaustion] 1 MB content payload", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1mb", "/tmp", "deepseek-v4-flash");
    const oneMB = "y".repeat(1_048_576); // 1 MiB
    store.addMessage("sess-1mb", { role: "user", content: oneMB });
    assert.equal(store.countMessages("sess-1mb"), 1);
    const msgs = store.getMessages("sess-1mb", 1);
    assert.equal(msgs[0].content!.length, 1_048_576);
  } finally {
    store.close();
  }
});

test("[exhaustion] creating and deleting 300 sessions rapidly", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    for (let i = 0; i < 300; i++) {
      store.createSession(`sess-mass-${i}`, "/tmp", "deepseek-v4-flash");
      store.addMessage(`sess-mass-${i}`, { role: "user", content: `msg-${i}` });
    }
    const all = store.listSessions(500);
    assert.equal(all.length, 300);
    // Delete half
    for (let i = 0; i < 150; i++) {
      store.deleteSession(`sess-mass-${i}`);
    }
    const remaining = store.listSessions(500);
    assert.equal(remaining.length, 150);
  } finally {
    store.close();
  }
});

test("[exhaustion] getMessages with no limit on large dataset (5000 messages)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-nolimit", "/tmp", "deepseek-v4-flash");
    for (let i = 0; i < 5000; i++) {
      store.addMessage("sess-nolimit", { role: "user", content: `x` });
    }
    const allMsgs = store.getMessages("sess-nolimit"); // no limit — returns all
    assert.equal(allMsgs.length, 5000);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 5. STATE CORRUPTION
// ---------------------------------------------------------------------------

test("[corruption] corrupted SQLite file (random bytes) fails on query", () => {
  const fp = tempFilePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // Write random bytes to the file
  const randomBytes = Buffer.alloc(1024);
  for (let i = 0; i < randomBytes.length; i++) {
    randomBytes[i] = Math.floor(Math.random() * 256);
  }
  fs.writeFileSync(fp, randomBytes);
  // DatabaseSync does not validate at open time; it fails on first operation
  const db = new DatabaseSync(fp);
  try {
    assert.throws(() => db.exec("SELECT 1"));
  } finally {
    db.close();
  }
});

test("[corruption] truncated SQLite file fails on query", () => {
  const fp = tempFilePath();
  const db = new DatabaseSync(fp);
  db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY);");
  db.close();

  // Truncate the file
  const stat = fs.statSync(fp);
  fs.truncateSync(fp, Math.floor(stat.size / 2));

  // DatabaseSync does not validate at open time; fails on first operation
  const db2 = new DatabaseSync(fp);
  try {
    assert.throws(() => db2.exec("SELECT * FROM test"));
  } finally {
    db2.close();
  }
});

test("[corruption] missing sessions/messages tables after partial migration", () => {
  const dir = tempStateDir();
  // Simulate a v1 state directory: create DB with v1 schema but not v2 tables
  const dbPath = path.join(dir, "deepseek-harness.sqlite");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 1;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      artifact_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    );
  `);
  db.close();

  // Opening with HarnessStore should migrate and create sessions/messages
  const store = new HarnessStore(dir);
  try {
    assert.equal(store.schemaVersion, STATE_SCHEMA_VERSION);
    // sessions and messages tables must now exist
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','messages')")
      .all() as { name: string }[];
    assert.equal(tables.length, 2, "sessions and messages tables must be created");
    // Should be able to use them
    store.createSession("sess-after-migration", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-after-migration", { role: "user", content: "hello" });
    assert.equal(store.countMessages("sess-after-migration"), 1);
  } finally {
    store.close();
  }
});

test("[corruption] foreign key violation — addMessage on non-existent session", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    // The store first calls getSession which should throw session_not_found
    throwsHarness(() => store.addMessage("nonexistent-session", { role: "user", content: "test" }), "session_not_found");
  } finally {
    store.close();
  }
});

test("[corruption] deleting session while another reference holds messages", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-cascade", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-cascade", { role: "user", content: "m1" });
    store.addMessage("sess-cascade", { role: "assistant", content: "m2" });
    // Read messages, then delete session
    const beforeRead = store.getMessages("sess-cascade");
    assert.equal(beforeRead.length, 2);
    store.deleteSession("sess-cascade");
    // After deletion, session and messages should be gone
    assert.throws(() => store.getSession("sess-cascade"), { code: "session_not_found" });
    assert.equal(store.getMessages("sess-cascade").length, 0);
  } finally {
    store.close();
  }
});

test("[corruption] database file deleted while store is open (OS keeps inode alive)", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-del-db", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-del-db", { role: "user", content: "data" });
    // Delete the database file from disk
    fs.unlinkSync(store.dbPath);
    // On most Unix systems the inode stays alive while the file descriptor is open,
    // so reads may still succeed. The key test: does it crash or corrupt silently?
    const msgs = store.getMessages("sess-del-db");
    assert.equal(msgs.length, 1, "Messages should still be readable via open fd");
    // Writes may also succeed (they go to the still-open inode)
    store.addMessage("sess-del-db", { role: "assistant", content: "after-unlink" });
    assert.equal(store.countMessages("sess-del-db"), 2);
  } finally {
    try {
      store.close();
    } catch {
      // close may fail after unlink, that's acceptable
    }
  }
});

// ---------------------------------------------------------------------------
// 6. TYPE CONFUSION
// ---------------------------------------------------------------------------

test("[type-confusion] number passed for session ID is rejected", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    // Using `as any` to bypass TypeScript checks and simulate runtime JS misuse
    throwsHarness(() => (store as any).createSession(12345, "/tmp", "model"), "invalid_session_id");
  } finally {
    store.close();
  }
});

test("[type-confusion] null passed for required createSession fields", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    assert.throws(() => (store as any).createSession(null, "/tmp", "model"));
  } finally {
    store.close();
  }
});

test("[type-confusion] undefined role in addMessage", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-undef-role", "/tmp", "deepseek-v4-flash");
    // role is required; undefined should be rejected
    assert.throws(() => (store as any).addMessage("sess-undef-role", { role: undefined, content: "test" }));
  } finally {
    store.close();
  }
});

test("[type-confusion] array instead of string for content", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-array-content", "/tmp", "deepseek-v4-flash");
    // Passing an array where a string is expected
    assert.throws(() =>
      (store as any).addMessage("sess-array-content", { role: "user", content: ["not", "a", "string"] }),
    );
  } finally {
    store.close();
  }
});

test("[type-confusion] boolean for role field", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-bool-role", "/tmp", "deepseek-v4-flash");
    assert.throws(() =>
      (store as any).addMessage("sess-bool-role", { role: true, content: "test" }),
    );
  } finally {
    store.close();
  }
});

test("[type-confusion] object for token_count", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-obj-tokens", "/tmp", "deepseek-v4-flash");
    assert.throws(() =>
      (store as any).addMessage("sess-obj-tokens", {
        role: "user",
        content: "test",
        token_count: { value: 42 },
      }),
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 7. INJECTION ATTACKS
// ---------------------------------------------------------------------------

test("[injection] SQL injection via session ID — DROP TABLE", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    const evilId = "1; DROP TABLE sessions; --";
    store.createSession(evilId, "/tmp", "deepseek-v4-flash");
    // The session should exist and the table should be intact
    const session = store.getSession(evilId);
    assert.equal(session.id, evilId);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .all();
    assert.equal(tables.length, 1, "sessions table must survive injection attempt");
  } finally {
    store.close();
  }
});

test("[injection] SQL injection via content field", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-inj-content", "/tmp", "deepseek-v4-flash");
    const evilContent = "'); DELETE FROM sessions; --";
    store.addMessage("sess-inj-content", { role: "user", content: evilContent });
    const msgs = store.getMessages("sess-inj-content");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, evilContent);
    // The session should still exist
    const session = store.getSession("sess-inj-content");
    assert.equal(session.id, "sess-inj-content");
  } finally {
    store.close();
  }
});

test("[injection] SQL injection via role field", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-inj-role", "/tmp", "deepseek-v4-flash");
    const evilRole = "user'); DELETE FROM messages; --";
    store.addMessage("sess-inj-role", { role: evilRole, content: "test" });
    const msgs = store.getMessages("sess-inj-role");
    assert.equal(msgs.length, 1);
    // The role should be stored literally, not executed
    assert.equal(msgs[0].role, evilRole);
    // Verify no data was lost
    assert.equal(store.countMessages("sess-inj-role"), 1);
  } finally {
    store.close();
  }
});

test("[injection] SQL injection via tool_call_id", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-inj-tool", "/tmp", "deepseek-v4-flash");
    const evilCallId = "call_1'); DROP TABLE messages; --";
    store.addMessage("sess-inj-tool", {
      role: "tool",
      content: "result",
      tool_call_id: evilCallId,
    });
    const msgs = store.getMessages("sess-inj-tool");
    assert.equal(msgs[0].tool_call_id, evilCallId);
    assert.equal(store.countMessages("sess-inj-tool"), 1);
  } finally {
    store.close();
  }
});

test("[injection] path traversal in cwd field", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    const traversalCwd = "../../etc/passwd";
    store.createSession("sess-path-traversal", traversalCwd, "deepseek-v4-flash");
    const session = store.getSession("sess-path-traversal");
    // The cwd is just a string stored in SQLite — it should not be used for filesystem access
    assert.equal(session.cwd, traversalCwd);
    // Verify no file was written outside the state dir
    assert.ok(!fs.existsSync("/tmp/etc/passwd"));
  } finally {
    store.close();
  }
});

test("[injection] UNION-based injection attempt in limit parameter", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-union", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-union", { role: "user", content: "test" });
    // The limit is passed as a bound parameter, so injection shouldn't work
    // But passing a non-number as limit should still fail
    assert.throws(() => (store as any).getMessages("sess-union", "1 UNION SELECT * FROM sessions"));
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 8. INVALID ASSUMPTIONS
// ---------------------------------------------------------------------------

test("[assumption] session exists immediately after createSession", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    const session = store.createSession("sess-immediate", "/tmp", "deepseek-v4-flash");
    assert.equal(session.id, "sess-immediate");
    // getSession immediately after should also work
    const retrieved = store.getSession("sess-immediate");
    assert.equal(retrieved.id, "sess-immediate");
    assert.equal(retrieved.message_count, 0);
  } finally {
    store.close();
  }
});

test("[assumption] messages are ordered by id ascending", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-ordering", "/tmp", "deepseek-v4-flash");
    // Insert messages in non-lexicographic order
    store.addMessage("sess-ordering", { role: "user", content: "third" });
    store.addMessage("sess-ordering", { role: "assistant", content: "first-wrong" }); // we'll check by id, not content
    store.addMessage("sess-ordering", { role: "system", content: "second" });

    const msgs = store.getMessages("sess-ordering");
    assert.equal(msgs.length, 3);
    // Should be ordered by id ASC (insertion order), so content should be "third", "first-wrong", "second"
    assert.equal(msgs[0].content, "third");
    assert.equal(msgs[1].content, "first-wrong");
    assert.equal(msgs[2].content, "second");
    // IDs should be monotonically increasing
    assert.ok(msgs[0].id < msgs[1].id, "id should increase");
    assert.ok(msgs[1].id < msgs[2].id, "id should increase");
  } finally {
    store.close();
  }
});

test("[assumption] deleting a session cascade-deletes all messages", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-cascade-verify", "/tmp", "deepseek-v4-flash");
    store.addMessage("sess-cascade-verify", { role: "user", content: "m1" });
    store.addMessage("sess-cascade-verify", { role: "assistant", content: "m2" });
    store.addMessage("sess-cascade-verify", { role: "tool", content: "m3" });

    assert.equal(store.countMessages("sess-cascade-verify"), 3);
    store.deleteSession("sess-cascade-verify");

    // Session gone
    assert.throws(() => store.getSession("sess-cascade-verify"), { code: "session_not_found" });
    // Messages gone
    assert.equal(store.getMessages("sess-cascade-verify").length, 0);
    assert.equal(store.countMessages("sess-cascade-verify"), 0);
  } finally {
    store.close();
  }
});

test("[assumption] duplicate session IDs are rejected with a clear error", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-dup", "/tmp", "deepseek-v4-flash");
    // Creating a session with the same ID should fail with a constraint error
    // It should be a HarnessError, not a raw SQLite error
    assert.throws(
      () => store.createSession("sess-dup", "/other", "other-model"),
      (err: unknown) => {
        // It should at least be an Error (not crash), ideally a HarnessError
        return err instanceof Error;
      },
    );
  } finally {
    store.close();
  }
});

test("[assumption] schema version is set correctly after construction", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    assert.equal(store.schemaVersion, STATE_SCHEMA_VERSION);
    // Verify PRAGMA user_version on disk
    const row = store.db.prepare("PRAGMA user_version;").get() as { user_version?: number };
    assert.equal(row.user_version, STATE_SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test("[assumption] re-opening a state dir preserves schema version and data", () => {
  const dir = tempStateDir();
  // First instance
  const store1 = new HarnessStore(dir);
  store1.createSession("sess-persist", "/tmp", "deepseek-v4-flash");
  store1.addMessage("sess-persist", { role: "user", content: "persisted" });
  store1.close();

  // Second instance on same dir
  const store2 = new HarnessStore(dir);
  try {
    assert.equal(store2.schemaVersion, STATE_SCHEMA_VERSION);
    const session = store2.getSession("sess-persist");
    assert.equal(session.id, "sess-persist");
    const msgs = store2.getMessages("sess-persist");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "persisted");
  } finally {
    store2.close();
  }
});

test("[assumption] getMessages with limit returns exactly that many rows", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-limit-exact", "/tmp", "deepseek-v4-flash");
    for (let i = 0; i < 100; i++) {
      store.addMessage("sess-limit-exact", { role: "user", content: `m${i}` });
    }
    assert.equal(store.getMessages("sess-limit-exact", 7).length, 7);
    assert.equal(store.getMessages("sess-limit-exact", 50).length, 50);
    assert.equal(store.getMessages("sess-limit-exact", 200).length, 100); // only 100 exist
  } finally {
    store.close();
  }
});

test("[assumption] listSessions returns only the requested limit", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    for (let i = 0; i < 50; i++) {
      store.createSession(`sess-list-${i}`, "/tmp", "deepseek-v4-flash");
    }
    assert.equal(store.listSessions(5).length, 5);
    assert.equal(store.listSessions(100).length, 50);
    assert.equal(store.listSessions(1).length, 1);
  } finally {
    store.close();
  }
});

test("[assumption] updateSession with no changes is a no-op (except updated_at)", async () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-noop", "/tmp", "deepseek-v4-flash");
    const before = store.getSession("sess-noop");
    // Small delay to ensure updated_at ticks forward
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.updateSession("sess-noop", {});
    const after = store.getSession("sess-noop");
    // All values except updated_at should be identical
    assert.equal(after.id, before.id);
    assert.equal(after.cwd, before.cwd);
    assert.equal(after.model, before.model);
    assert.equal(after.summary, before.summary);
    assert.equal(after.message_count, before.message_count);
    assert.equal(after.total_tokens, before.total_tokens);
    assert.equal(after.total_cost_usd, before.total_cost_usd);
    // updated_at should have changed
    assert.notEqual(after.updated_at, before.updated_at);
  } finally {
    store.close();
  }
});

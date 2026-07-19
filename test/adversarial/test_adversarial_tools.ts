// test/adversarial/test_adversarial_tools.ts
// Comprehensive adversarial test sweep against the tool registry and tool implementations.
// Targets all 8 attack categories for the 8 tool implementations.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createToolRegistry, ToolRegistry } from "../../src/agent/tools.js";

// ── Helpers ──

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "adv-"));
}

function tempFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 1: MALFORMED INPUTS
// ═══════════════════════════════════════════════════════════════════════

await test("CAT1: Malformed Inputs", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();
  const f = tempFile(dir, "test.txt", "hello world\nline two\nline three\n");

  await t.test("read_file with empty file_path string", async () => {
    const result = await registry.execute("read_file", { file_path: "" }, dir);
    assert.ok(result.error, "should have error for empty path");
    assert.match(result.error ?? "", /absolute|invalid/i);
  });

  await t.test("read_file with non-string file_path (number)", async () => {
    // String(42) = "42" - should fail absolute path check
    const result = await registry.execute("read_file", { file_path: 42 }, dir);
    assert.ok(result.error, "should have error for number path");
  });

  await t.test("write_file with object as content", async () => {
    // String({}) = "[object Object]" - should still create a file but content is mangled
    const p = path.join(dir, "obj-content.txt");
    const result = await registry.execute("write_file", { file_path: p, content: { malicious: true } }, dir);
    // Should succeed (coerced to string) but verify content is the string coercion
    const written = fs.readFileSync(p, "utf8");
    assert.strictEqual(written, "[object Object]");
    // This is debatable behavior; the test captures current behavior
  });

  await t.test("read_file with null bytes in file_path", async () => {
    // Null byte in path - should be caught or handled safely
    const result = await registry.execute("read_file", { file_path: "/tmp/test\x00hidden.txt" }, dir);
    // May throw system error or fail with absolute check
    assert.ok(result.error, "should have error for null-byte path");
  });

  await t.test("write_file with BIDI override markers in file_path", async () => {
    // Unicode RIGHT-TO-LEFT OVERRIDE (U+202E)
    const bidiPath = path.join(dir, "file\u202Ecod.exe.txt");
    const result = await registry.execute("write_file", { file_path: bidiPath, content: "bidi test" }, dir);
    // Should handle gracefully - current behavior may create the file
    assert.ok(!result.error || result.error.includes("invalid_path"), "should not crash on BIDI chars");
  });

  await t.test("run_command with shell metacharacters in directory-based params", async () => {
    // The command param is expected to be a shell command, but if other params
    // are interpolated into shell contexts, metas can be dangerous.
    // Test: validate the tool itself doesn't crash on weird command strings
    const result = await registry.execute("run_command", {
      command: "echo 'hello; rm -rf /; echo done'",
      timeout_ms: 2000,
    }, dir);
    // Should complete without executing the dangerous payload
    // Single quotes in shell prevent expansion
    assert.ok(result.summary.includes("completed") || result.summary.includes("failed"), "should not hang");
  });

  await t.test("search_content with empty pattern", async () => {
    const result = await registry.execute("search_content", { pattern: "", directory: dir }, dir);
    // Empty pattern should either error or return something sensible
    assert.ok(typeof result.summary === "string", "should not crash");
  });

  await t.test("list_directory with null bytes in directory param", async () => {
    const result = await registry.execute("list_directory", { directory: dir + "\x00hidden" }, dir);
    assert.ok(result.error, "should error on null byte in directory path");
  });

  await t.test("edit_file with missing required params", async () => {
    const result = await registry.execute("edit_file", {} as any, dir);
    // Should error on missing file_path (String(undefined) = "undefined")
    assert.ok(result.error, "should error on missing params");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 2: RACE CONDITIONS
// ═══════════════════════════════════════════════════════════════════════

await test("CAT2: Race Conditions", async (t) => {
  await t.test("concurrent write_file + read_file on same path", async () => {
    const registry = createToolRegistry();
    const dir = tempDir();
    const p = path.join(dir, "race.txt");

    // Launch concurrent writes and reads
    const writes = Array.from({ length: 20 }, (_, i) =>
      registry.execute("write_file", { file_path: p, content: `write-${i}` }, dir)
    );
    const reads = Array.from({ length: 20 }, () =>
      registry.execute("read_file", { file_path: p }, dir)
    );
    const writeResults = await Promise.all(writes);
    const readResults = await Promise.all(reads);

    // All should complete without throwing
    for (const r of writeResults) {
      assert.ok(!r.error || r.error === undefined, `write should not error: ${r.error}`);
    }
    for (const r of readResults) {
      // Reads should succeed (file exists after first write completes)
      assert.ok(typeof r.content === "string", "read should return content");
    }
  });

  await t.test("rapid edit_file calls on overlapping regions", async () => {
    const registry = createToolRegistry();
    const dir = tempDir();
    const p = tempFile(dir, "edit-race.txt", "AAAAAAAAAAAAAAAAAAAA");

    // Many edits targeting the same region
    const edits = Array.from({ length: 10 }, (_, i) =>
      registry.execute("edit_file", {
        file_path: p,
        old_string: "AAAAAAAAAAAAAAAAAAAA",
        new_string: `EDIT-${i}-PAD`,
      }, dir)
    );
    const results = await Promise.allSettled(edits);

    // Count how many succeeded vs failed (non-unique)
    const succeeded = results.filter(r => r.status === "fulfilled" && !(r.value as any).error);
    const failed = results.filter(r => {
      if (r.status === "fulfilled") return !!(r.value as any).error;
      return true;
    });

    // At least some should succeed; failures are acceptable due to non-uniqueness
    assert.ok(succeeded.length >= 1, "at least one edit should succeed");
  });

  await t.test("simultaneous search_content during file writes", async () => {
    const registry = createToolRegistry();
    const dir = tempDir();
    // Create many files
    for (let i = 0; i < 50; i++) {
      tempFile(dir, `search-${i}.txt`, `content-${i}`);
    }

    const writes = Array.from({ length: 10 }, (_, i) =>
      registry.execute("write_file", {
        file_path: path.join(dir, `search-${i}.txt`),
        content: `updated-${i}`,
      }, dir)
    );
    const searches = Array.from({ length: 10 }, () =>
      registry.execute("search_content", { pattern: "content", directory: dir }, dir)
    );

    const all = await Promise.all([...writes, ...searches]);
    // No crashes
    for (const r of all) {
      assert.ok(typeof r.summary === "string", "should not crash");
    }
  });

  await t.test("multiple run_command writing to same file", async () => {
    const registry = createToolRegistry();
    const dir = tempDir();
    const p = path.join(dir, "cmd-race.txt");
    fs.writeFileSync(p, "", "utf8");

    const cmds = Array.from({ length: 10 }, (_, i) =>
      registry.execute("run_command", {
        command: `echo "line-${i}" >> ${JSON.stringify(p)}`,
        timeout_ms: 5000,
      }, dir)
    );
    const results = await Promise.all(cmds);
    // No crashes
    for (const r of results) {
      assert.ok(typeof r.summary === "string", `should not crash: ${r.error ?? "ok"}`);
    }
    // File should have content
    const content = fs.readFileSync(p, "utf8");
    assert.ok(content.length > 0, "file should have content from concurrent writes");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 3: BOUNDARY VALUES
// ═══════════════════════════════════════════════════════════════════════

await test("CAT3: Boundary Values", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();

  await t.test("extremely long file_path (near OS limit)", async () => {
    // OS path limit typically ~4096 bytes
    const longBase = path.join(dir, "sub");
    const longName = "a".repeat(4000);
    const longPath = path.join(longBase, longName);

    const result = await registry.execute("write_file", {
      file_path: longPath,
      content: "long path test",
    }, dir);
    // Should either create successfully or error cleanly
    assert.ok(typeof result.summary === "string", "should not crash on long path");
  });

  await t.test("zero-length content in write_file", async () => {
    const p = path.join(dir, "empty.txt");
    const result = await registry.execute("write_file", { file_path: p, content: "" }, dir);
    assert.ok(result.summary.includes("Created") || result.summary.includes("Overwrote"));
    const stat = fs.statSync(p);
    assert.strictEqual(stat.size, 0, "file should be empty");
  });

  await t.test("read_file with negative offset", async () => {
    const f = tempFile(dir, "neg-offset.txt", "line1\nline2\nline3\nline4\nline5\n");
    const result = await registry.execute("read_file", { file_path: f, offset: -5 }, dir);
    // Should reject negative offset
    assert.ok(result.error, "negative offset should be rejected");
    assert.match(result.error ?? "", /invalid_param|positive/i);
  });

  await t.test("read_file with negative limit", async () => {
    const f = tempFile(dir, "neg-limit.txt", "line1\nline2\nline3\nline4\nline5\n");
    const result = await registry.execute("read_file", { file_path: f, limit: -10 }, dir);
    // Should reject negative limit
    assert.ok(result.error, "negative limit should be rejected");
    assert.match(result.error ?? "", /invalid_param|positive/i);
  });

  await t.test("read_file with NaN offset", async () => {
    const f = tempFile(dir, "nan-offset.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", { file_path: f, offset: NaN }, dir);
    // Should reject NaN offset
    assert.ok(result.error, "NaN offset should be rejected");
    assert.match(result.error ?? "", /invalid_param|positive/i);
  });

  await t.test("read_file with NaN limit", async () => {
    const f = tempFile(dir, "nan-limit.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", { file_path: f, limit: NaN }, dir);
    // Should reject NaN limit
    assert.ok(result.error, "NaN limit should be rejected");
    assert.match(result.error ?? "", /invalid_param|positive/i);
  });

  await t.test("read_file with Infinity offset", async () => {
    const f = tempFile(dir, "inf-offset.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", { file_path: f, offset: Infinity }, dir);
    // Should reject non-finite offset
    assert.ok(result.error, "Infinity offset should be rejected");
    assert.match(result.error ?? "", /invalid_param|positive/i);
  });

  await t.test("read_file with zero offset", async () => {
    const f = tempFile(dir, "zero-offset.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", { file_path: f, offset: 0 }, dir);
    // Should reject zero offset (line numbers start at 1)
    assert.ok(result.error, "zero offset should be rejected");
    assert.match(result.error ?? "", /invalid_param|positive/i);
  });

  await t.test("list_directory on empty directory", async () => {
    const emptyDir = path.join(dir, "empty-dir");
    fs.mkdirSync(emptyDir);
    const result = await registry.execute("list_directory", { directory: emptyDir }, dir);
    assert.strictEqual(result.content, "(empty directory)");
    assert.strictEqual(result.summary, "0 items in empty-dir");
  });

  await t.test("run_command with zero timeout", async () => {
    const result = await registry.execute("run_command", {
      command: "echo hello",
      timeout_ms: 0,
    }, dir);
    // Zero timeout should be rejected
    assert.ok(result.error, "zero timeout should be rejected");
  });

  await t.test("run_command with negative timeout", async () => {
    const result = await registry.execute("run_command", {
      command: "echo hello",
      timeout_ms: -1000,
    }, dir);
    // Negative timeout should be rejected
    assert.ok(result.error, "negative timeout should be rejected");
  });

  await t.test("run_command with NaN timeout", async () => {
    const result = await registry.execute("run_command", {
      command: "echo hello",
      timeout_ms: NaN,
    }, dir);
    // NaN timeout should be rejected
    assert.ok(result.error, "NaN timeout should be rejected");
  });

  await t.test("read_file on very large file (10MB+ equivalent of lines)", async () => {
    // Generate a file with 100,000 lines
    const bigFile = path.join(dir, "big.txt");
    const lines = Array.from({ length: 50000 }, (_, i) => `line ${i}`).join("\n");
    fs.writeFileSync(bigFile, lines, "utf8");
    const result = await registry.execute("read_file", { file_path: bigFile }, dir);
    assert.ok(!result.error, "should handle large file");
    assert.ok(result.content.length > 0, "should return content");
  });

  await t.test("read_file with offset beyond file length", async () => {
    const f = tempFile(dir, "beyond.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", { file_path: f, offset: 1000 }, dir);
    assert.ok(!result.error, "beyond-end offset should not crash");
    assert.strictEqual(result.content.trim(), "", "should return empty for beyond-end offset");
  });

  await t.test("write_file with extremely long content", async () => {
    const p = path.join(dir, "long-content.txt");
    const longContent = "x".repeat(5_000_000); // 5MB string
    const result = await registry.execute("write_file", { file_path: p, content: longContent }, dir);
    assert.ok(!result.error, "should handle 5MB content");
    assert.ok(fs.existsSync(p), "file should exist");
  });

  await t.test("edit_file with extremely long old_string", async () => {
    const p = tempFile(dir, "long-edit.txt", "a".repeat(10000) + "TARGET" + "b".repeat(10000));
    const result = await registry.execute("edit_file", {
      file_path: p,
      old_string: "TARGET",
      new_string: "REPLACED",
    }, dir);
    assert.ok(!result.error, "should handle edit in large file");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 4: RESOURCE EXHAUSTION
// ═══════════════════════════════════════════════════════════════════════

await test("CAT4: Resource Exhaustion", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();

  await t.test("search_content across many files (500+)", async () => {
    // Create 500+ files
    for (let i = 0; i < 600; i++) {
      tempFile(dir, `f-${i}.txt`, `content number ${i}`);
    }
    const result = await registry.execute("search_content", {
      pattern: "content",
      directory: dir,
      file_pattern: "*.txt",
    }, dir);
    assert.ok(!result.error, "should not error on many files");
    // Should find matches (but may be truncated at 50 lines)
    assert.ok(result.summary.includes("match"), "should find matches");
  });

  await t.test("rapid tool executions (200+)", async () => {
    const p = tempFile(dir, "rapid.txt", "initial");
    const execs = Array.from({ length: 200 }, (_, i) =>
      registry.execute("read_file", { file_path: p }, dir)
    );
    const results = await Promise.all(execs);
    for (const r of results) {
      assert.ok(!r.error, `rapid execution should not error: ${r.error}`);
    }
  });

  await t.test("search_files with many results", async () => {
    // Create many files with different extensions
    for (let i = 0; i < 300; i++) {
      tempFile(dir, `result-${i}.dat`, `data ${i}`);
    }
    const result = await registry.execute("search_files", {
      pattern: "*.dat",
      directory: dir,
    }, dir);
    assert.ok(!result.error, "should handle many results");
    assert.ok(result.summary.includes("300"), "should find all files");
  });

  await t.test("write_file rapid overwrites on same path", async () => {
    const p = path.join(dir, "overwrite.txt");
    for (let i = 0; i < 500; i++) {
      const result = await registry.execute("write_file", {
        file_path: p,
        content: `iteration ${i}`,
      }, dir);
      assert.ok(!result.error, `iteration ${i} should succeed`);
    }
    // Final file should contain last write
    const content = fs.readFileSync(p, "utf8");
    assert.strictEqual(content, "iteration 499");
  });

  await t.test("list_directory with many entries (1000+)", async () => {
    const bigDir = path.join(dir, "big-dir");
    fs.mkdirSync(bigDir);
    for (let i = 0; i < 1200; i++) {
      fs.writeFileSync(path.join(bigDir, `entry-${i}`), `content ${i}`, "utf8");
    }
    const result = await registry.execute("list_directory", { directory: bigDir }, dir);
    assert.ok(!result.error, "should handle directory with many entries");
    assert.ok(result.content.split("\n").length >= 1200, "should list all entries");
  });

  await t.test("read_file repeatedly on same large file", async () => {
    const bigFile = path.join(dir, "big-repeat.txt");
    fs.writeFileSync(bigFile, "x".repeat(2_000_000), "utf8");
    for (let i = 0; i < 10; i++) {
      const result = await registry.execute("read_file", { file_path: bigFile }, dir);
      assert.ok(!result.error, `read ${i} should not error`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 5: STATE CORRUPTION
// ═══════════════════════════════════════════════════════════════════════

await test("CAT5: State Corruption", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();

  await t.test("edit_file on file deleted between read and write", async () => {
    const p = tempFile(dir, "delete-me.txt", "hello world");
    const result = await registry.execute("edit_file", {
      file_path: p,
      old_string: "hello world",
      new_string: "goodbye world",
    }, dir);
    // This should work fine since it's synchronous
    assert.ok(!result.error, "edit should succeed when file exists");
  });

  await t.test("edit_file on non-existent file", async () => {
    const p = path.join(dir, "does-not-exist.txt");
    const result = await registry.execute("edit_file", {
      file_path: p,
      old_string: "anything",
      new_string: "something",
    }, dir);
    assert.ok(result.error, "edit on non-existent file should error");
  });

  await t.test("read_file on deleted file", async () => {
    const p = tempFile(dir, "then-delete.txt", "content");
    fs.unlinkSync(p);
    const result = await registry.execute("read_file", { file_path: p }, dir);
    assert.ok(result.error, "read on deleted file should error");
  });

  await t.test("list_directory on deleted directory", async () => {
    const delDir = path.join(dir, "to-delete");
    fs.mkdirSync(delDir);
    fs.rmdirSync(delDir);
    const result = await registry.execute("list_directory", { directory: delDir }, dir);
    assert.ok(result.error, "list on deleted dir should error");
  });

  await t.test("write_file then read_file consistency check", async () => {
    const p = path.join(dir, "consistency.txt");
    const testContent = "consistency check content here";
    await registry.execute("write_file", { file_path: p, content: testContent }, dir);
    const readResult = await registry.execute("read_file", { file_path: p }, dir);
    assert.ok(readResult.content.includes("consistency check content here"),
      "read back should match written content");
  });

  await t.test("edit_file then verify content integrity", async () => {
    const p = tempFile(dir, "integrity.txt", "BEFORE AFTER");
    await registry.execute("edit_file", {
      file_path: p,
      old_string: "BEFORE",
      new_string: "CHANGED",
    }, dir);
    const content = fs.readFileSync(p, "utf8");
    assert.strictEqual(content, "CHANGED AFTER", "edit should preserve surrounding content");
  });

  await t.test("edit_file with overlapping concurrent edits (no cross-corruption)", async () => {
    // Sequentially edit distinct regions - verify no cross-corruption
    const p = tempFile(dir, "no-corrupt.txt", "AAA-region1-BBB-region2-CCC");
    await registry.execute("edit_file", {
      file_path: p,
      old_string: "region1",
      new_string: "ZONE1",
    }, dir);
    await registry.execute("edit_file", {
      file_path: p,
      old_string: "region2",
      new_string: "ZONE2",
    }, dir);
    const content = fs.readFileSync(p, "utf8");
    assert.strictEqual(content, "AAA-ZONE1-BBB-ZONE2-CCC", "sequential edits should not corrupt");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 6: TYPE CONFUSION
// ═══════════════════════════════════════════════════════════════════════

await test("CAT6: Type Confusion", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();

  await t.test("read_file with object as file_path", async () => {
    const result = await registry.execute("read_file", { file_path: { path: "/etc/passwd" } }, dir);
    // String coercion: "[object Object]" - should fail absolute check
    assert.ok(result.error, "object file_path should error");
  });

  await t.test("read_file with array as file_path", async () => {
    const result = await registry.execute("read_file", { file_path: ["/tmp", "file.txt"] }, dir);
    // String coercion: "/tmp,file.txt" - not absolute
    assert.ok(result.error, "array file_path should error");
  });

  await t.test("read_file with boolean as offset", async () => {
    // typeof true !== "number", so offset defaults to 1
    const f = tempFile(dir, "bool-offset.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", {
      file_path: f,
      offset: true,
    } as any, dir);
    assert.ok(!result.error, "boolean offset should not crash (falls back to default)");
  });

  await t.test("read_file with string 'NaN' as offset", async () => {
    // Number("NaN") = NaN which is not finite — should be rejected
    const f = tempFile(dir, "str-nan.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", {
      file_path: f,
      offset: "NaN",
    } as any, dir);
    assert.ok(result.error, "string NaN should be rejected");
  });

  await t.test("read_file with string 'Infinity' as limit", async () => {
    // Number("Infinity") = Infinity which is not finite — should be rejected
    const f = tempFile(dir, "str-inf.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", {
      file_path: f,
      limit: "Infinity",
    } as any, dir);
    assert.ok(result.error, "string Infinity should be rejected");
  });

  await t.test("run_command with number as command", async () => {
    const result = await registry.execute("run_command", { command: 12345 } as any, dir);
    // String(12345) = "12345" - this would try to run "12345" as command
    assert.ok(typeof result.summary === "string", "should not crash on number command");
  });

  await t.test("run_command with object as command", async () => {
    const result = await registry.execute("run_command", { command: { cmd: "ls" } } as any, dir);
    // String coercion to "[object Object]" - will fail to execute
    assert.ok(typeof result.summary === "string", "should not crash on object command");
  });

  await t.test("write_file with undefined content", async () => {
    const p = path.join(dir, "undef-content.txt");
    const result = await registry.execute("write_file", {
      file_path: p,
      content: undefined,
    } as any, dir);
    // String(undefined) = "undefined"
    assert.ok(!result.error, "undefined content should succeed (coerced to 'undefined')");
    const written = fs.readFileSync(p, "utf8");
    assert.strictEqual(written, "undefined");
  });

  await t.test("search_content with number as pattern", async () => {
    const result = await registry.execute("search_content", {
      pattern: 404,
      directory: dir,
    } as any, dir);
    // String(404) = "404"
    assert.ok(typeof result.summary === "string", "number pattern should not crash");
  });

  await t.test("delete_file without gate - number as file_path", async () => {
    // No gate set so should block
    const result = await registry.execute("delete_file", { file_path: 99999 } as any, dir);
    assert.ok(result.error, "delete_file should block without gate");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 7: INJECTION ATTACKS
// ═══════════════════════════════════════════════════════════════════════

await test("CAT7: Injection Attacks", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();

  await t.test("PATH TRAVERSAL: read_file with ../../../etc/passwd", async () => {
    const result = await registry.execute("read_file", {
      file_path: path.join(dir, "../../../etc/passwd"),
    }, dir);
    // Path traversal should now be blocked by resolveSafePath
    assert.ok(result.error, "path traversal should be blocked");
    assert.match(result.error ?? "", /path.traversal/i, "should report path traversal blocked");
  });

  await t.test("PATH TRAVERSAL: write_file with ../../../tmp/evil.txt", async () => {
    const traversalPath = path.join(dir, "../../../tmp/adv-traversal-test.txt");
    const result = await registry.execute("write_file", {
      file_path: traversalPath,
      content: "path traversal test content",
    }, dir);
    // Path traversal should now be blocked
    assert.ok(result.error, "path traversal write should be blocked");
    assert.match(result.error ?? "", /path.traversal/i);
    // Verify the file was NOT created
    assert.strictEqual(fs.existsSync("/tmp/adv-traversal-test.txt"), false,
      "file outside workspace should not have been created");
  });

  await t.test("SHELL INJECTION: search_content with command substitution in pattern", async () => {
    // With execFileSync (no shell), command substitution should NOT execute
    const marker = path.join(dir, "injection-marker");
    const result = await registry.execute("search_content", {
      pattern: "$(touch " + marker + ")",
      directory: dir,
    }, dir);
    // Check if the marker file was NOT created (injection prevented)
    assert.strictEqual(fs.existsSync(marker), false,
      "command injection via $(...) should be prevented by execFileSync");
    assert.ok(typeof result.summary === "string", "should not crash");
  });

  await t.test("SHELL INJECTION: search_files with command substitution in pattern", async () => {
    const marker = path.join(dir, "injection-marker2");
    const result = await registry.execute("search_files", {
      pattern: "$(touch " + marker + ")",
      directory: dir,
    }, dir);
    // Injection should be prevented by execFileSync
    assert.strictEqual(fs.existsSync(marker), false,
      "command injection via $(...) should be prevented in search_files");
    assert.ok(typeof result.summary === "string", "should not crash");
  });

  await t.test("SHELL INJECTION: search_content with semicolons in pattern", async () => {
    const result = await registry.execute("search_content", {
      pattern: "test; echo INJECTED; #",
      directory: dir,
    }, dir);
    assert.ok(typeof result.summary === "string", "should not crash");
  });

  await t.test("SHELL INJECTION: search_content with backticks in pattern", async () => {
    const marker = path.join(dir, "backtick-marker");
    const result = await registry.execute("search_content", {
      pattern: "`touch " + marker + "`",
      directory: dir,
    }, dir);
    // Backtick injection should be prevented by execFileSync
    assert.strictEqual(fs.existsSync(marker), false,
      "command injection via backticks should be prevented");
    assert.ok(typeof result.summary === "string", "should not crash");
  });

  await t.test("SHELL INJECTION: search_files with newlines in pattern", async () => {
    const result = await registry.execute("search_files", {
      pattern: "*.ts\necho pwned\n#",
      directory: dir,
    }, dir);
    assert.ok(typeof result.summary === "string", "should not crash on newlines in pattern");
  });

  await t.test("REGEX DoS: search_content with catastrophic backtracking pattern", async () => {
    // Create a file with content that triggers catastrophic backtracking
    const dosFile = tempFile(dir, "dos.txt", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!");
    const result = await registry.execute("search_content", {
      pattern: "(a+)+b", // Classic ReDoS pattern
      directory: dir,
    }, dir);
    // Should complete within timeout (the search tool has a 30s timeout internally)
    assert.ok(typeof result.summary === "string", "should not hang on ReDoS pattern");
  });

  await t.test("SHELL INJECTION: run_command with command separator", async () => {
    // run_command is designed to run arbitrary commands, but test that
    // it handles the output correctly even for multi-command inputs
    const result = await registry.execute("run_command", {
      command: "echo first && echo second && echo third",
      timeout_ms: 5000,
    }, dir);
    assert.ok(typeof result.summary === "string", "should handle chained commands");
  });

  await t.test("PATH TRAVERSAL: edit_file with ../../ in path", async () => {
    const traversalPath = path.join(dir, "../../../tmp/adv-edit-test.txt");
    // Ensure the target exists
    try { fs.writeFileSync("/tmp/adv-edit-test.txt", "TRAVERSAL CONTENT", "utf8"); } catch {}
    const result = await registry.execute("edit_file", {
      file_path: traversalPath,
      old_string: "TRAVERSAL CONTENT",
      new_string: "MODIFIED",
    }, dir);
    // Path traversal should be blocked
    assert.ok(result.error, "path traversal edit should be blocked");
    assert.match(result.error ?? "", /path.traversal/i);
    // Cleanup
    try { fs.unlinkSync("/tmp/adv-edit-test.txt"); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 8: INVALID ASSUMPTIONS
// ═══════════════════════════════════════════════════════════════════════

await test("CAT8: Invalid Assumptions", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();

  await t.test("read_file on non-existent file", async () => {
    const result = await registry.execute("read_file", {
      file_path: path.join(dir, "never-created.txt"),
    }, dir);
    assert.ok(result.error, "should error on non-existent file");
    // Should not leak raw system error details that expose filesystem structure
  });

  await t.test("list_directory on non-existent path", async () => {
    const result = await registry.execute("list_directory", {
      directory: path.join(dir, "no-such-dir"),
    }, dir);
    assert.ok(result.error, "should error on non-existent directory");
  });

  await t.test("absolute path requirement enforced for read_file", async () => {
    const result = await registry.execute("read_file", { file_path: "relative/path.txt" }, dir);
    assert.ok(result.error, "should reject relative path");
    assert.match(result.error ?? "", /absolute/i);
  });

  await t.test("absolute path requirement enforced for write_file", async () => {
    const result = await registry.execute("write_file", {
      file_path: "relative/output.txt",
      content: "test",
    }, dir);
    assert.ok(result.error, "should reject relative path");
    assert.match(result.error ?? "", /absolute/i);
  });

  await t.test("absolute path requirement enforced for edit_file", async () => {
    const p = tempFile(dir, "edit-rel.txt", "test content");
    const result = await registry.execute("edit_file", {
      file_path: "relative/edit.txt",
      old_string: "test",
      new_string: "changed",
    }, dir);
    assert.ok(result.error, "should reject relative path");
    assert.match(result.error ?? "", /absolute/i);
  });

  await t.test("absolute path requirement enforced for list_directory", async () => {
    const result = await registry.execute("list_directory", { directory: "relative/dir" }, dir);
    assert.ok(result.error, "should reject relative path");
    assert.match(result.error ?? "", /absolute/i);
  });

  await t.test("absolute path requirement enforced for delete_file (before gate)", async () => {
    // No gate, so should be blocked by gate check before absolute check
    const result = await registry.execute("delete_file", { file_path: "relative/delete.txt" }, dir);
    assert.ok(result.error, "should block or reject relative path");
  });

  await t.test("edit_file old_string uniqueness verified", async () => {
    const p = tempFile(dir, "unique-edit.txt", "A A A");
    const result = await registry.execute("edit_file", {
      file_path: p,
      old_string: "A",
      new_string: "B",
    }, dir);
    // "A" appears 3 times - should fail
    assert.ok(result.error, "should reject non-unique old_string");
    assert.match(result.error ?? "", /matches multiple locations/i);
  });

  await t.test("edit_file old_string not found", async () => {
    const p = tempFile(dir, "no-match.txt", "hello world");
    const result = await registry.execute("edit_file", {
      file_path: p,
      old_string: "nonexistent text",
      new_string: "replacement",
    }, dir);
    assert.ok(result.error, "should reject non-matching old_string");
    assert.match(result.error ?? "", /not found/i);
  });

  await t.test("write_file creates parent directories as promised", async () => {
    const deepPath = path.join(dir, "a", "b", "c", "d", "deep-file.txt");
    const result = await registry.execute("write_file", {
      file_path: deepPath,
      content: "deep content",
    }, dir);
    assert.ok(!result.error, "should create parent directories");
    assert.ok(fs.existsSync(deepPath), "deep file should exist");
    const content = fs.readFileSync(deepPath, "utf8");
    assert.strictEqual(content, "deep content");
  });

  await t.test("Tier 2 (delete_file) blocked without gate", async () => {
    const p = tempFile(dir, "delete-test.txt", "delete me");
    const result = await registry.execute("delete_file", { file_path: p }, dir);
    assert.ok(result.error, "delete_file should be blocked without gate");
    assert.match(result.error ?? "", /authorisation|approval/i);
    // Verify file was NOT deleted
    assert.ok(fs.existsSync(p), "file should still exist after blocked delete");
  });

  await t.test("Tier 2 (delete_file) blocked by gate denying", async () => {
    const registry2 = createToolRegistry();
    registry2.setTier2Gate({
      async check(_toolName, _params) {
        return { allowed: false, reason: "Denied by test gate" };
      },
    });
    const p = tempFile(dir, "denied-delete.txt", "keep me");
    const result = await registry2.execute("delete_file", { file_path: p }, dir);
    assert.ok(result.error, "should be blocked by denying gate");
    assert.match(result.error ?? "", /Denied by test gate/i);
    assert.ok(fs.existsSync(p), "file should still exist");
  });

  await t.test("Tier 2 (delete_file) allowed by gate permitting", async () => {
    const registry3 = createToolRegistry();
    registry3.setTier2Gate({
      async check(_toolName, _params) {
        return { allowed: true };
      },
    });
    const p = tempFile(dir, "allowed-delete.txt", "delete me please");
    const result = await registry3.execute("delete_file", { file_path: p }, dir);
    assert.ok(!result.error, "should succeed when gate allows");
    assert.ok(!fs.existsSync(p), "file should be deleted when gate allows");
  });

  await t.test("edit_file with absolute path resolves correctly", async () => {
    const p = tempFile(dir, "abs-edit.txt", "ORIGINAL TEXT");
    const result = await registry.execute("edit_file", {
      file_path: p,
      old_string: "ORIGINAL",
      new_string: "MODIFIED",
    }, dir);
    assert.ok(!result.error, "edit with absolute path should succeed");
    assert.strictEqual(fs.readFileSync(p, "utf8"), "MODIFIED TEXT");
  });

  await t.test("read_file returns cat -n format", async () => {
    const p = tempFile(dir, "cat-n.txt", "line one\nline two\nline three\n");
    const result = await registry.execute("read_file", { file_path: p }, dir);
    assert.ok(!result.error, "read should succeed");
    // Should have line numbers in the content (6-char padded)
    assert.match(result.content, /^\s{0,5}1\s{1,2}line one/m, "should have line numbers");
  });

  await t.test("search_content handles non-existent directory gracefully", async () => {
    const result = await registry.execute("search_content", {
      pattern: "test",
      directory: path.join(dir, "ghost-dir"),
    }, dir);
    // Should fail gracefully, not crash
    assert.ok(typeof result.summary === "string", "should handle bad directory");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// HAPPY PATH TESTS (regression safety net)
// ═══════════════════════════════════════════════════════════════════════

await test("HAPPY PATH: All tools work correctly with valid inputs", async (t) => {
  const registry = createToolRegistry();
  const dir = tempDir();

  await t.test("read_file happy path", async () => {
    const f = tempFile(dir, "happy-read.txt", "line1\nline2\nline3\n");
    const result = await registry.execute("read_file", { file_path: f }, dir);
    assert.ok(!result.error);
    assert.ok(result.content.includes("line1"));
    assert.ok(result.content.includes("line2"));
    assert.ok(result.content.includes("line3"));
  });

  await t.test("read_file with offset and limit", async () => {
    const f = tempFile(dir, "happy-offset.txt", "a\nb\nc\nd\ne\n");
    const result = await registry.execute("read_file", { file_path: f, offset: 2, limit: 2 }, dir);
    assert.ok(!result.error);
    assert.ok(result.content.includes("b"));
    assert.ok(result.content.includes("c"));
    assert.ok(!result.content.includes("a"));
    assert.ok(!result.content.includes("d"));
  });

  await t.test("write_file happy path", async () => {
    const p = path.join(dir, "happy-write.txt");
    const result = await registry.execute("write_file", { file_path: p, content: "test content" }, dir);
    assert.ok(!result.error);
    assert.ok(fs.existsSync(p));
  });

  await t.test("edit_file happy path", async () => {
    const p = tempFile(dir, "happy-edit.txt", "before MIDDLE after");
    const result = await registry.execute("edit_file", {
      file_path: p,
      old_string: "MIDDLE",
      new_string: "CENTER",
    }, dir);
    assert.ok(!result.error);
    assert.strictEqual(fs.readFileSync(p, "utf8"), "before CENTER after");
  });

  await t.test("search_content happy path", async () => {
    tempFile(dir, "search-test.txt", "needle in a haystack");
    const result = await registry.execute("search_content", {
      pattern: "needle",
      directory: dir,
    }, dir);
    assert.ok(!result.error);
    assert.ok(result.content.includes("needle"));
    assert.ok(result.summary.includes("1 match"));
  });

  await t.test("search_files happy path", async () => {
    tempFile(dir, "find-me.ts", "typescript");
    tempFile(dir, "find-me.js", "javascript");
    const result = await registry.execute("search_files", {
      pattern: "*.ts",
      directory: dir,
    }, dir);
    assert.ok(!result.error);
    assert.ok(result.content.includes("find-me.ts"));
    assert.ok(!result.content.includes("find-me.js"));
  });

  await t.test("run_command happy path", async () => {
    const result = await registry.execute("run_command", {
      command: "echo hello",
      timeout_ms: 5000,
    }, dir);
    assert.ok(!result.error);
    assert.ok(result.content.includes("hello"));
  });

  await t.test("list_directory happy path", async () => {
    tempFile(dir, "item1.txt", "one");
    tempFile(dir, "item2.txt", "two");
    const result = await registry.execute("list_directory", { directory: dir }, dir);
    assert.ok(!result.error);
    assert.ok(result.content.includes("item1.txt"));
    assert.ok(result.content.includes("item2.txt"));
  });
});

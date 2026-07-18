import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildJsonlCorpusManifest, buildTextCorpusManifest } from "../src/corpus_ingest.js";
import { HarnessError } from "../src/errors.js";

process.env.DEEPSEEK_HARNESS_INPUT_ROOT = os.tmpdir();

const MAX_JSONL_RECORD_BYTES = 16 * 1024 * 1024;

test("builds deterministic overlapping inline-text corpus shards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "source.txt");
  fs.writeFileSync(sourcePath, "abcdefghijklmnopqrstuvwxyz");

  const manifest = buildTextCorpusManifest({
    project: "unit-corpus-ingest",
    sourcePath,
    workloadType: "book_reading",
    privacyLane: "local_only",
    chunkChars: 10,
    overlapChars: 2
  });
  const rebuilt = buildTextCorpusManifest({
    project: "unit-corpus-ingest",
    sourcePath,
    workloadType: "book_reading",
    privacyLane: "local_only",
    chunkChars: 10,
    overlapChars: 2
  });

  assert.deepEqual(rebuilt, manifest);
  assert.equal(manifest.schema_version, "deepseek-harness.corpus.v1");
  assert.equal(manifest.sources.length, 1);
  assert.equal(manifest.sources[0]?.path, sourcePath);
  assert.match(manifest.sources[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(
    manifest.shards.map((shard) => shard.inline_text),
    ["abcdefghij", "ijklmnopqr", "qrstuvwxyz"]
  );
  assert.deepEqual(
    manifest.shards.map((shard) => [shard.bounds.start_char, shard.bounds.end_char]),
    [
      [0, 10],
      [8, 18],
      [16, 26]
    ]
  );
  assert.equal(manifest.shards[1]?.bounds.overlap_chars, 2);
  assert.match(manifest.shards[0]?.bounds.shard_sha256 ?? "", /^[a-f0-9]{64}$/);
});

test("emits a manifest object matching corpus v1 inline shard constraints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "source.txt");
  const artifactDir = path.join(root, "artifacts", "corpus", "ingest-unit");
  fs.writeFileSync(sourcePath, "0123456789ABCDEFGHIJ");

  const manifest = buildTextCorpusManifest({
    project: "unit-corpus-ingest",
    sourcePath,
    workloadType: "dataset_transform",
    privacyLane: "local_only",
    chunkChars: 8,
    overlapChars: 3,
    artifactDir
  });

  assert.equal(manifest.artifact_dir, artifactDir);
  assert.equal(manifest.processor.type, "copy_text");
  assert.equal(manifest.shards.length, 4);
  for (const source of manifest.sources) {
    assert.match(source.id, /^[A-Za-z0-9_.:-]+$/);
  }
  for (const shard of manifest.shards) {
    assert.match(shard.id, /^[A-Za-z0-9_.:-]+$/);
    assert.equal(shard.source_id, manifest.sources[0]?.id);
    assert.equal(typeof shard.inline_text, "string");
    assert.notEqual(shard.inline_text, "");
    for (const value of Object.values(shard.bounds)) {
      assert.notEqual(typeof value, "object");
    }
  }
});

test("rejects invalid overlap values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "source.txt");
  fs.writeFileSync(sourcePath, "abcdef");

  assert.throws(
    () =>
      buildTextCorpusManifest({
        project: "unit-corpus-ingest",
        sourcePath,
        workloadType: "book_reading",
        privacyLane: "local_only",
        chunkChars: 4,
        overlapChars: 4
      }),
    /overlapChars must be smaller than chunkChars/
  );
});

test("blocks protected text and JSONL sources before reading their contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const protectedDir = path.join(root, ".ssh");
  fs.mkdirSync(protectedDir);
  const protectedText = path.join(protectedDir, "notes.txt");
  const protectedJsonl = path.join(protectedDir, "records.jsonl");
  const alias = path.join(root, "innocent-looking.txt");
  fs.writeFileSync(protectedText, "private notes");
  fs.writeFileSync(protectedJsonl, '{"private":true}\n');
  fs.symlinkSync(protectedText, alias);

  assertHarnessError(
    () => buildTextCorpusManifest({
      project: "unit-corpus-ingest",
      sourcePath: alias,
      workloadType: "book_reading",
      privacyLane: "local_only",
      chunkChars: 10,
      overlapChars: 0
    }),
    "corpus_path_forbidden",
    /forbidden/
  );
  assertHarnessError(
    () => buildJsonlCorpusManifest({
      project: "unit-jsonl-ingest",
      sourcePath: protectedJsonl,
      privacyLane: "local_only",
      recordsPerShard: 1
    }),
    "corpus_path_forbidden",
    /forbidden/
  );
});

test("rejects text inputs that would manufacture more than 10,000 inline shards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "source.txt");
  fs.writeFileSync(sourcePath, "x".repeat(20_001));

  assertHarnessError(
    () => buildTextCorpusManifest({
      project: "unit-corpus-ingest",
      sourcePath,
      workloadType: "book_reading",
      privacyLane: "local_only",
      chunkChars: 1,
      overlapChars: 0
    }),
    "text_corpus_too_many_shards",
    /more than 10000 shards/
  );
});

test("rejects overlap plans that would duplicate more than 128 MiB into a manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "source.txt");
  fs.writeFileSync(sourcePath, "x".repeat(250_000));

  assertHarnessError(
    () => buildTextCorpusManifest({
      project: "unit-corpus-ingest",
      sourcePath,
      workloadType: "book_reading",
      privacyLane: "local_only",
      chunkChars: 100_000,
      overlapChars: 99_900
    }),
    "text_corpus_manifest_too_large",
    /more than 134217728 manifest characters/
  );
});

test("builds deterministic file-backed JSONL shards with exact raw-byte and row bounds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "records.jsonl");
  const records = [
    '{"id":1,"text":"café"}',
    '{"id":2,"text":"雪"}',
    '{"id":3,"text":"🙂"}'
  ];
  const firstShardText = `${records[0]}\r\n${records[1]}\r\n`;
  const sourceBytes = Buffer.from(`${firstShardText}${records[2]}`, "utf8");
  fs.writeFileSync(sourcePath, sourceBytes);

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (() => {
    throw new Error("JSONL ingest must not call fs.readFileSync");
  }) as typeof fs.readFileSync;

  let manifest: ReturnType<typeof buildJsonlCorpusManifest>;
  let rebuilt: ReturnType<typeof buildJsonlCorpusManifest>;
  try {
    manifest = buildJsonlCorpusManifest({
      project: "unit-jsonl-ingest",
      sourcePath,
      privacyLane: "local_only",
      recordsPerShard: 2
    });
    rebuilt = buildJsonlCorpusManifest({
      project: "unit-jsonl-ingest",
      sourcePath,
      privacyLane: "local_only",
      recordsPerShard: 2
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.deepEqual(rebuilt, manifest);

  assert.equal(manifest.workload_type, "dataset_transform");
  assert.equal(manifest.sources[0]?.type, "dataset");
  assert.equal(manifest.sources[0]?.sha256, createHash("sha256").update(sourceBytes).digest("hex"));
  assert.deepEqual(
    manifest.shards.map((shard) => [shard.bounds.row_start, shard.bounds.row_end, shard.bounds.row_count]),
    [
      [1, 2, 2],
      [3, 3, 1]
    ]
  );

  const expectedByteBounds = [
    [0, Buffer.byteLength(firstShardText, "utf8")],
    [Buffer.byteLength(firstShardText, "utf8"), sourceBytes.length]
  ];
  const fd = fs.openSync(sourcePath, "r");
  try {
    for (const [index, shard] of manifest.shards.entries()) {
      assert.equal(shard.input_path, sourcePath);
      assert.equal("inline_text" in shard, false);
      assert.deepEqual(
        [shard.bounds.byte_start, shard.bounds.byte_end],
        expectedByteBounds[index]
      );

      const byteStart = shard.bounds.byte_start ?? -1;
      const byteEnd = shard.bounds.byte_end ?? -1;
      const readback = Buffer.alloc(byteEnd - byteStart);
      assert.equal(fs.readSync(fd, readback, 0, readback.length, byteStart), readback.length);
      assert.deepEqual(readback, sourceBytes.subarray(byteStart, byteEnd));
      assert.equal(shard.bounds.shard_sha256, createHash("sha256").update(readback).digest("hex"));
    }
  } finally {
    fs.closeSync(fd);
  }

  const finalShard = manifest.shards[1];
  assert.ok(finalShard?.bounds.byte_start !== undefined);
  assert.ok(finalShard.bounds.byte_end !== undefined);
  assert.equal(sourceBytes.subarray(finalShard.bounds.byte_start, finalShard.bounds.byte_end).includes(0x0a), false);
});

test("rejects malformed JSONL records before manifest creation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "records.jsonl");
  fs.writeFileSync(sourcePath, '{"id":1}\nnot-json\n');

  assertHarnessError(
    () =>
      buildJsonlCorpusManifest({
        project: "unit-jsonl-ingest",
        sourcePath,
        privacyLane: "local_only",
        recordsPerShard: 1
      }),
    "invalid_jsonl_corpus_source",
    /JSONL record 2 is not valid JSON/
  );
});

test("rejects malformed UTF-8 and blank JSONL records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const malformedPath = path.join(root, "malformed-utf8.jsonl");
  fs.writeFileSync(malformedPath, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]));

  assertHarnessError(
    () =>
      buildJsonlCorpusManifest({
        project: "unit-jsonl-ingest",
        sourcePath: malformedPath,
        privacyLane: "local_only",
        recordsPerShard: 1
      }),
    "invalid_jsonl_corpus_source",
    /JSONL record 1 is not valid UTF-8/
  );

  const blankPath = path.join(root, "blank-record.jsonl");
  fs.writeFileSync(blankPath, '{}\r\n \t\r\n{}\r\n');
  assertHarnessError(
    () =>
      buildJsonlCorpusManifest({
        project: "unit-jsonl-ingest",
        sourcePath: blankPath,
        privacyLane: "local_only",
        recordsPerShard: 1
      }),
    "invalid_jsonl_corpus_source",
    /JSONL record 2 is empty/
  );
});

test("rejects JSONL inputs requiring more than 10,000 shards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const allowedPath = path.join(root, "maximum-shards.jsonl");
  const sourcePath = path.join(root, "too-many-shards.jsonl");
  const maximumRecords = Array.from({ length: 10_000 }, () => "{}").join("\n");
  fs.writeFileSync(allowedPath, maximumRecords);
  fs.writeFileSync(sourcePath, `${maximumRecords}\n{}`);

  const maximumManifest = buildJsonlCorpusManifest({
    project: "unit-jsonl-ingest",
    sourcePath: allowedPath,
    privacyLane: "local_only",
    recordsPerShard: 1
  });
  assert.equal(maximumManifest.shards.length, 10_000);
  assert.deepEqual(
    [maximumManifest.shards.at(-1)?.bounds.row_start, maximumManifest.shards.at(-1)?.bounds.row_end],
    [10_000, 10_000]
  );

  assertHarnessError(
    () =>
      buildJsonlCorpusManifest({
        project: "unit-jsonl-ingest",
        sourcePath,
        privacyLane: "local_only",
        recordsPerShard: 1
      }),
    "jsonl_corpus_too_many_shards",
    /more than 10000 shards/
  );
});

test("rejects a single JSONL record larger than the explicit 16 MiB cap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ingest-"));
  const sourcePath = path.join(root, "overlarge-record.jsonl");
  fs.writeFileSync(sourcePath, Buffer.alloc(MAX_JSONL_RECORD_BYTES + 1, 0x20));

  assertHarnessError(
    () =>
      buildJsonlCorpusManifest({
        project: "unit-jsonl-ingest",
        sourcePath,
        privacyLane: "local_only",
        recordsPerShard: 1
      }),
    "jsonl_corpus_record_too_large",
    /JSONL record 1 exceeds the 16777216-byte limit/
  );
});

function assertHarnessError(action: () => unknown, code: string, message: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof HarnessError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

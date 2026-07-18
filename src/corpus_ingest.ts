import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { HarnessError } from "./errors.js";
import { assertSafeCorpusSourcePath } from "./paths.js";

const JSONL_READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_SHARDS = 10_000;
const MAX_TEXT_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_CHUNK_CHARS = 1_000_000;
const MAX_TEXT_SHARDS = 10_000;
const MAX_TEXT_MANIFEST_CHARS = 128 * 1024 * 1024;

export type CorpusWorkloadType =
  | "book_reading"
  | "ocr"
  | "translation"
  | "dataset_transform"
  | "longform_generation"
  | "media_catalogue"
  | "mixed";

export type CorpusPrivacyLane = "local_only" | "external_inference_allowed" | "redacted_external_allowed";

export interface BuildTextCorpusManifestInput {
  project: string;
  sourcePath: string;
  workloadType: CorpusWorkloadType;
  privacyLane: CorpusPrivacyLane;
  chunkChars: number;
  overlapChars: number;
  artifactDir?: string;
}

export interface BuildJsonlCorpusManifestInput {
  project: string;
  sourcePath: string;
  privacyLane: CorpusPrivacyLane;
  recordsPerShard: number;
  artifactDir?: string;
}

export interface TextCorpusSource {
  id: string;
  path: string;
  sha256: string;
  type: "text" | "dataset";
}

export interface TextCorpusShard {
  id: string;
  source_id: string;
  input_path?: string;
  inline_text?: string;
  bounds: {
    chunk_index: number;
    start_char?: number;
    end_char?: number;
    chunk_chars?: number;
    overlap_chars?: number;
    byte_start?: number;
    byte_end?: number;
    row_start?: number;
    row_end?: number;
    row_count?: number;
    source_sha256: string;
    shard_sha256: string;
  };
}

export interface TextCorpusManifest {
  schema_version: "deepseek-harness.corpus.v1";
  project: string;
  workload_type: CorpusWorkloadType;
  privacy_lane: CorpusPrivacyLane;
  artifact_dir?: string;
  processor: { type: "copy_text" };
  sources: TextCorpusSource[];
  shards: TextCorpusShard[];
}

export function buildTextCorpusManifest(input: BuildTextCorpusManifestInput): TextCorpusManifest {
  validateChunkOptions(input.chunkChars, input.overlapChars);
  const sourcePath = assertSafeCorpusSourcePath(input.sourcePath);
  const sourceStat = fs.statSync(sourcePath);
  if (!sourceStat.isFile()) {
    throw new HarnessError("invalid_corpus_source", "Text corpus source must be a regular file");
  }
  if (sourceStat.size > MAX_TEXT_SOURCE_BYTES) {
    throw new HarnessError(
      "text_corpus_source_too_large",
      `Text corpus source exceeds the ${MAX_TEXT_SOURCE_BYTES}-byte ingest cap`
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(sourcePath));
  } catch {
    throw new HarnessError("invalid_corpus_utf8", "Text corpus source is not valid UTF-8");
  }
  if (text.length === 0) {
    throw new HarnessError("empty_corpus_source", "Text corpus source must not be empty");
  }
  assertTextShardPlanBounded(text.length, input.chunkChars, input.overlapChars);

  const sourceSha256 = sha256Text(text);
  const sourceId = `source:${sha256Text(`${sourcePath}\0${sourceSha256}`).slice(0, 16)}`;
  const manifest: TextCorpusManifest = {
    schema_version: "deepseek-harness.corpus.v1",
    project: input.project,
    workload_type: input.workloadType,
    privacy_lane: input.privacyLane,
    ...(input.artifactDir ? { artifact_dir: input.artifactDir } : {}),
    processor: { type: "copy_text" },
    sources: [{ id: sourceId, path: sourcePath, sha256: sourceSha256, type: "text" }],
    shards: chunkText(text, {
      chunkChars: input.chunkChars,
      overlapChars: input.overlapChars,
      sourceId,
      sourceSha256
    })
  };

  return manifest;
}

export function buildJsonlCorpusManifest(input: BuildJsonlCorpusManifestInput): TextCorpusManifest {
  if (!Number.isInteger(input.recordsPerShard) || input.recordsPerShard <= 0) {
    throw new HarnessError("invalid_corpus_records_per_shard", "recordsPerShard must be a positive integer");
  }

  const sourcePath = assertSafeCorpusSourcePath(input.sourcePath);
  const scan = scanJsonlFile(sourcePath, input.recordsPerShard);
  const sourceSha256 = scan.sourceSha256;
  const sourceId = `source:${sha256Text(`${sourcePath}\0${sourceSha256}`).slice(0, 16)}`;
  return {
    schema_version: "deepseek-harness.corpus.v1",
    project: input.project,
    workload_type: "dataset_transform",
    privacy_lane: input.privacyLane,
    ...(input.artifactDir ? { artifact_dir: input.artifactDir } : {}),
    processor: { type: "copy_text" },
    sources: [{ id: sourceId, path: sourcePath, sha256: sourceSha256, type: "dataset" }],
    shards: scan.shards.map((shard, chunkIndex) => ({
      id: `${sourceId}:rows:${String(shard.rowStart).padStart(8, "0")}-${String(shard.rowEnd).padStart(8, "0")}`,
      source_id: sourceId,
      input_path: sourcePath,
      bounds: {
        chunk_index: chunkIndex,
        byte_start: shard.byteStart,
        byte_end: shard.byteEnd,
        row_start: shard.rowStart,
        row_end: shard.rowEnd,
        row_count: shard.rowCount,
        source_sha256: sourceSha256,
        shard_sha256: shard.shardSha256
      }
    }))
  };
}

function validateChunkOptions(chunkChars: number, overlapChars: number): void {
  if (!Number.isInteger(chunkChars) || chunkChars <= 0 || chunkChars > MAX_TEXT_CHUNK_CHARS) {
    throw new HarnessError(
      "invalid_corpus_chunk_chars",
      `chunkChars must be an integer between 1 and ${MAX_TEXT_CHUNK_CHARS}`
    );
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0) {
    throw new HarnessError("invalid_corpus_overlap_chars", "overlapChars must be a non-negative integer");
  }
  if (overlapChars >= chunkChars) {
    throw new HarnessError("invalid_corpus_overlap_chars", "overlapChars must be smaller than chunkChars");
  }
}

function assertTextShardPlanBounded(textChars: number, chunkChars: number, overlapChars: number): void {
  const stepChars = chunkChars - overlapChars;
  const shardCount = textChars <= chunkChars ? 1 : 1 + Math.ceil((textChars - chunkChars) / stepChars);
  if (shardCount > MAX_TEXT_SHARDS) {
    throw new HarnessError(
      "text_corpus_too_many_shards",
      `Text corpus would create more than ${MAX_TEXT_SHARDS} shards`
    );
  }
  const finalShardChars = textChars <= chunkChars
    ? textChars
    : textChars - (shardCount - 1) * stepChars;
  const materialisedChars = (shardCount - 1) * chunkChars + finalShardChars;
  if (materialisedChars > MAX_TEXT_MANIFEST_CHARS) {
    throw new HarnessError(
      "text_corpus_manifest_too_large",
      `Text corpus overlap would materialise more than ${MAX_TEXT_MANIFEST_CHARS} manifest characters`
    );
  }
}

function chunkText(
  text: string,
  options: { chunkChars: number; overlapChars: number; sourceId: string; sourceSha256: string }
): TextCorpusShard[] {
  const shards: TextCorpusShard[] = [];
  const stepChars = options.chunkChars - options.overlapChars;

  for (let startChar = 0; startChar < text.length; startChar += stepChars) {
    const endChar = Math.min(startChar + options.chunkChars, text.length);
    const inlineText = text.slice(startChar, endChar);
    const chunkIndex = shards.length;
    const shardSha256 = sha256Text(inlineText);
    shards.push({
      id: `${options.sourceId}:chunk:${String(chunkIndex + 1).padStart(6, "0")}`,
      source_id: options.sourceId,
      inline_text: inlineText,
      bounds: {
        chunk_index: chunkIndex,
        start_char: startChar,
        end_char: endChar,
        chunk_chars: options.chunkChars,
        overlap_chars: options.overlapChars,
        source_sha256: options.sourceSha256,
        shard_sha256: shardSha256
      }
    });

    if (endChar === text.length) {
      break;
    }
  }

  return shards;
}

interface JsonlShardScan {
  byteStart: number;
  byteEnd: number;
  rowStart: number;
  rowEnd: number;
  rowCount: number;
  shardSha256: string;
}

function scanJsonlFile(
  sourcePath: string,
  recordsPerShard: number
): { sourceSha256: string; shards: JsonlShardScan[] } {
  const sourceHash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const readBuffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
  const shards: JsonlShardScan[] = [];
  let recordParts: Buffer[] = [];
  let recordByteCount = 0;
  let totalByteCount = 0;
  let totalRowCount = 0;
  let shardByteStart = 0;
  let shardRowStart = 1;
  let shardRowCount = 0;
  let shardHash = createHash("sha256");

  const appendRecordBytes = (bytes: Buffer): void => {
    if (recordByteCount + bytes.length > MAX_JSONL_RECORD_BYTES) {
      throw new HarnessError(
        "jsonl_corpus_record_too_large",
        `JSONL record ${totalRowCount + 1} exceeds the ${MAX_JSONL_RECORD_BYTES}-byte limit`
      );
    }
    if (bytes.length > 0) {
      recordParts.push(Buffer.from(bytes));
      recordByteCount += bytes.length;
    }
  };

  const validateRecord = (): void => {
    const recordNumber = totalRowCount + 1;
    const recordBytes = recordParts.length === 0
      ? Buffer.alloc(0)
      : recordParts.length === 1
        ? recordParts[0]!
        : Buffer.concat(recordParts, recordByteCount);
    let record: string;
    try {
      record = decoder.decode(recordBytes);
    } catch {
      throw new HarnessError(
        "invalid_jsonl_corpus_source",
        `JSONL record ${recordNumber} is not valid UTF-8`
      );
    }
    if (record.trim().length === 0) {
      throw new HarnessError("invalid_jsonl_corpus_source", `JSONL record ${recordNumber} is empty`);
    }
    try {
      JSON.parse(record);
    } catch {
      throw new HarnessError("invalid_jsonl_corpus_source", `JSONL record ${recordNumber} is not valid JSON`);
    }
    recordParts = [];
    recordByteCount = 0;
    totalRowCount += 1;
    shardRowCount += 1;
  };

  const finishShard = (byteEnd: number): void => {
    if (shards.length >= MAX_JSONL_SHARDS) {
      throw new HarnessError(
        "jsonl_corpus_too_many_shards",
        `JSONL corpus would create more than ${MAX_JSONL_SHARDS} shards`
      );
    }
    shards.push({
      byteStart: shardByteStart,
      byteEnd,
      rowStart: shardRowStart,
      rowEnd: totalRowCount,
      rowCount: shardRowCount,
      shardSha256: shardHash.digest("hex")
    });
    shardByteStart = byteEnd;
    shardRowStart = totalRowCount + 1;
    shardRowCount = 0;
    shardHash = createHash("sha256");
  };

  const fd = fs.openSync(sourcePath, "r");
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, readBuffer, 0, readBuffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = readBuffer.subarray(0, bytesRead);
      const chunkByteStart = totalByteCount;
      sourceHash.update(chunk);
      totalByteCount += bytesRead;

      let segmentStart = 0;
      while (segmentStart < chunk.length) {
        const lineFeedIndex = chunk.indexOf(0x0a, segmentStart);
        const recordSegmentEnd = lineFeedIndex === -1 ? chunk.length : lineFeedIndex;
        appendRecordBytes(chunk.subarray(segmentStart, recordSegmentEnd));

        const shardSegmentEnd = lineFeedIndex === -1 ? chunk.length : lineFeedIndex + 1;
        shardHash.update(chunk.subarray(segmentStart, shardSegmentEnd));
        if (lineFeedIndex === -1) {
          break;
        }

        validateRecord();
        const recordByteEnd = chunkByteStart + lineFeedIndex + 1;
        if (shardRowCount === recordsPerShard) {
          finishShard(recordByteEnd);
        }
        segmentStart = lineFeedIndex + 1;
      }
    }

    if (recordByteCount > 0) {
      validateRecord();
      if (shardRowCount === recordsPerShard) {
        finishShard(totalByteCount);
      }
    }
    if (totalRowCount === 0) {
      throw new HarnessError("empty_corpus_source", "JSONL corpus source must not be empty");
    }
    if (shardRowCount > 0) {
      finishShard(totalByteCount);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { sourceSha256: sourceHash.digest("hex"), shards };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { corpusApprovalPacket } from "../src/corpus.js";

test("builds a corpus-bound DeepSeek approval packet without granting authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-approval-"));
  const artifactDir = path.join(root, "corpus", "approval-job");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = root;

  const result = corpusApprovalPacket({
    schema_version: "deepseek-harness.corpus.v1",
    job_id: "approval-job",
    project: "corpus-approval",
    workload_type: "translation",
    privacy_lane: "external_inference_allowed",
    artifact_dir: artifactDir,
    processor: {
      type: "deepseek_batch",
      transport: "deepseek",
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      response_format: "text",
      prompt_template: "Translate: {{text}}",
      concurrency: 2,
      cost_cap_usd: 0.2,
      max_tokens: 200
    },
    sources: [{ id: "source:one", type: "text" }],
    shards: [
      {
        id: "source:one:chunk:1",
        source_id: "source:one",
        inline_text: "Hello",
        bounds: { source_lang: "en", target_lang: "fr", chunk_index: 0 }
      }
    ]
  }) as { ok: boolean; packet: { schema_version: string; approval_status: string; data_egress: { item_count: number } } };

  assert.equal(result.ok, true);
  assert.equal(result.packet.schema_version, "deepseek-harness.approval-packet.v1");
  assert.equal(result.packet.approval_status, "owner_signed_receipt_required");
  assert.equal(result.packet.data_egress.item_count, 1);
});

test("refuses an approval-packet output symlink outside the artefact root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-approval-"));
  const artifactDir = path.join(root, "corpus", "approval-job");
  const outputPath = path.join(artifactDir, "packet.json");
  const outsidePath = path.join(root, "outside.json");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = root;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.symlinkSync(outsidePath, outputPath);

  assert.throws(
    () => corpusApprovalPacket(approvalManifest(artifactDir), { output: outputPath }),
    /Harness output path contains a dangling symlink/
  );
  assert.equal(fs.existsSync(outsidePath), false);
});

test("rejects approval packets for local processors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-approval-"));
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = root;

  assert.throws(
    () =>
      corpusApprovalPacket({
        schema_version: "deepseek-harness.corpus.v1",
        project: "local-only",
        workload_type: "dataset_transform",
        privacy_lane: "local_only",
        processor: { type: "copy_text" },
        sources: [{ id: "source:one", type: "dataset" }],
        shards: [{ id: "source:one:rows:1-1", source_id: "source:one", inline_text: "{}\n", bounds: { row_start: 1, row_end: 1, row_count: 1 } }]
      }),
    /only required for deepseek_batch/
  );
});

test("approval packets cap aggregate materialised shard bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-approval-"));
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = root;

  const result = corpusApprovalPacket({
    schema_version: "deepseek-harness.corpus.v1",
    job_id: "approval-byte-cap",
    project: "corpus-approval",
    workload_type: "dataset_transform",
    privacy_lane: "external_inference_allowed",
    max_shards_per_batch: 10,
    max_batch_input_bytes: 10,
    processor: {
      type: "deepseek_batch",
      transport: "dry-run",
      model: "deepseek-v4-flash",
      prompt_template: "{{text}}",
      concurrency: 1,
      cost_cap_usd: 0.1,
      max_tokens: 20
    },
    sources: [{ id: "source", type: "dataset" }],
    shards: ["aaaaa", "bbbbb", "ccccc"].map((inlineText, index) => ({
      id: `row-${index + 1}`,
      source_id: "source",
      inline_text: inlineText,
      bounds: { row_start: index + 1, row_end: index + 1, row_count: 1 }
    }))
  }) as { packet: { data_egress: { item_count: number } } };

  assert.equal(result.packet.data_egress.item_count, 2);
});

test("rejects prompt templates that duplicate shard text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-approval-"));
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = root;

  assert.throws(
    () => corpusApprovalPacket({
      schema_version: "deepseek-harness.corpus.v1",
      project: "corpus-approval",
      workload_type: "dataset_transform",
      privacy_lane: "external_inference_allowed",
      processor: {
        type: "deepseek_batch",
        transport: "deepseek",
        prompt_template: "{{text}} {{text}}",
        concurrency: 1,
        cost_cap_usd: 0.1,
        max_tokens: 20
      },
      sources: [{ id: "source", type: "dataset" }],
      shards: [{ id: "row-1", source_id: "source", inline_text: "row" }]
    }),
    /Corpus manifest failed validation/
  );
});

function approvalManifest(artifactDir: string): Record<string, unknown> {
  return {
    schema_version: "deepseek-harness.corpus.v1",
    job_id: "approval-job",
    project: "corpus-approval",
    workload_type: "translation",
    privacy_lane: "external_inference_allowed",
    artifact_dir: artifactDir,
    processor: {
      type: "deepseek_batch",
      transport: "deepseek",
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      response_format: "text",
      prompt_template: "Translate: {{text}}",
      concurrency: 2,
      cost_cap_usd: 0.2,
      max_tokens: 200
    },
    sources: [{ id: "source:one", type: "text" }],
    shards: [{
      id: "source:one:chunk:1",
      source_id: "source:one",
      inline_text: "Hello",
      bounds: { source_lang: "en", target_lang: "fr", chunk_index: 0 }
    }]
  };
}

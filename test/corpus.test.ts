import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  corpusCancel,
  corpusPlan,
  corpusReconcile,
  corpusResume,
  corpusResumeAsync,
  corpusStart,
  corpusStartAsync,
  corpusStatus,
  corpusValidate,
  corpusWorkAsync
} from "../src/corpus.js";

process.env.DEEPSEEK_HARNESS_INPUT_ROOT = os.tmpdir();

function makeCorpusLedgerStale(artifactDir: string): void {
  const ledgerPath = path.join(artifactDir, "ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
    status: string;
    shards: Array<Record<string, unknown>>;
  };
  ledger.status = "running";
  Object.assign(ledger.shards[0] ?? {}, {
    status: "pending",
    attempts: 0,
    input_sha256: null,
    output_path: null,
    output_sha256: null,
    proof_path: null,
    processor_version: "pending",
    processor_run_id: null,
    error: null,
    last_error_type: null,
    next_retry_at: null,
    lease_owner: null,
    lease_expires_at: null,
    started_at: null,
    finished_at: null,
    committed_at: null
  });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

test("runs corpus shards, validates coverage, and reconciles output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-unit");
  const manifest = {
    schema_version: "deepseek-harness.corpus.v1",
    job_id: "corpus-unit",
    project: "unit-corpus",
    workload_type: "book_reading",
    privacy_lane: "local_only",
    sources: [{ id: "book", type: "text" }],
    shards: [
      { id: "chapter-1", source_id: "book", inline_text: "Chapter one", bounds: { chapter: 1 } },
      { id: "chapter-2", source_id: "book", inline_text: "Chapter two", bounds: { chapter: 2 } }
    ]
  };

  try {
    const started = corpusStart(manifest) as { ok: boolean; summary: { status: string; shard_count: number } };
    assert.equal(started.ok, true);
    assert.equal(started.summary.status, "completed");
    assert.equal(started.summary.shard_count, 2);

    const status = corpusStatus("corpus-unit", { artifactDir }) as { summary: { status: string } };
    assert.equal(status.summary.status, "completed");

    const validation = corpusValidate("corpus-unit", { artifactDir }) as { ok: boolean; blockers: string[] };
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.blockers, []);

    const reconciled = corpusReconcile("corpus-unit", { artifactDir }) as { ok: boolean; output_path: string; output_sha256: string };
    assert.equal(reconciled.ok, true);
    assert.equal(fs.readFileSync(reconciled.output_path, "utf8"), "Chapter one\n\nChapter two");
    assert.equal(
      reconciled.output_sha256,
      createHash("sha256").update("Chapter one\n\nChapter two").digest("hex")
    );
    const repeated = corpusReconcile("corpus-unit", { artifactDir }) as { output_sha256: string };
    assert.equal(repeated.output_sha256, reconciled.output_sha256);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("bounds local work per resume batch and lets the worker churn across batches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-bounded-batches");

  try {
    const started = corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-bounded-batches",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      max_shards_per_batch: 1,
      sources: [{ id: "dataset", type: "dataset" }],
      shards: ["one", "two", "three"].map((inlineText, index) => ({
        id: `row-batch-${index + 1}`,
        source_id: "dataset",
        inline_text: inlineText,
        bounds: { row_start: index + 1, row_end: index + 1, row_count: 1 }
      }))
    }) as { summary: { status: string; counts: { succeeded: number; pending: number } } };
    assert.equal(started.summary.status, "running");
    assert.equal(started.summary.counts.succeeded, 1);
    assert.equal(started.summary.counts.pending, 2);

    const worked = await corpusWorkAsync("corpus-bounded-batches", {
      artifactDir,
      maxIterations: 2
    }) as { summary: { status: string; counts: { succeeded: number } }; worker: { iterations: number; terminal: boolean } };
    assert.equal(worked.summary.status, "completed");
    assert.equal(worked.summary.counts.succeeded, 3);
    assert.equal(worked.worker.iterations, 2);
    assert.equal(worked.worker.terminal, true);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("cancels a corpus job ledger", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-cancel");

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-cancel",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset" }],
      shards: [{ id: "row-batch-1", source_id: "dataset", inline_text: "row" }]
    });

    const cancelled = corpusCancel("corpus-cancel", { artifactDir }) as { summary: { status: string } };
    assert.equal(cancelled.summary.status, "cancelled");
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("refuses to overwrite an existing corpus job", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-no-clobber");
  const manifest = {
    schema_version: "deepseek-harness.corpus.v1",
    job_id: "corpus-no-clobber",
    project: "unit-corpus",
    workload_type: "dataset_transform",
    privacy_lane: "local_only",
    sources: [{ id: "dataset", type: "dataset" }],
    shards: [{ id: "row-batch-1", source_id: "dataset", inline_text: "original" }]
  };

  try {
    corpusStart(manifest);
    const outputPath = path.join(artifactDir, "outputs", "row-batch-1.txt");
    assert.equal(fs.readFileSync(outputPath, "utf8"), "original");

    assert.throws(
      () => corpusStart({ ...manifest, shards: [{ ...manifest.shards[0], inline_text: "replacement" }] }),
      /Corpus job state already exists/
    );
    assert.equal(fs.readFileSync(outputPath, "utf8"), "original");
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("redacts signed approval authority from queued corpus artefacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-receipt-redaction");
  const signature = "fixture-signature-must-not-persist-0123456789";

  try {
    await corpusStartAsync({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-receipt-redaction",
      project: "unit-corpus",
      workload_type: "translation",
      privacy_lane: "external_inference_allowed",
      processor: {
        type: "deepseek_batch",
        transport: "fake",
        model: "deepseek-v4-flash",
        prompt_template: "Translate {{text}}",
        concurrency: 1,
        cost_cap_usd: 0.01,
        max_tokens: 32,
        approval_receipt: {
          schema_version: "deepseek-harness.inference-receipt.v1",
          receipt_id: "receipt-corpus-unit",
          status: "approved",
          issuer: "owner",
          issued_at: "2026-07-18T08:00:00.000Z",
          expires_at: "2026-07-18T12:00:00.000Z",
          nonce: "fixture_nonce_0123456789",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          network_payload_sha256: "0".repeat(64),
          egress_class: "non_sensitive_bulk",
          max_items: 1,
          max_concurrency: 1,
          max_cost_usd: 0.01,
          daily_cost_cap_usd: 0.1,
          rate_snapshot: {
            id: "fixture-rate",
            input_usd_per_million: 1,
            output_usd_per_million: 1
          },
          signature_base64: signature
        }
      },
      sources: [{
        id: "source",
        type: "text",
        sha256: createHash("sha256").update("hello").digest("hex")
      }],
      shards: [{
        id: "chunk-1",
        source_id: "source",
        inline_text: "hello",
        bounds: {
          source_lang: "en",
          target_lang: "fr",
          source_sha256: createHash("sha256").update("hello").digest("hex"),
          shard_sha256: createHash("sha256").update("hello").digest("hex")
        }
      }],
      acceptance: {
        translation: {
          source_lang: "en",
          target_lang: "fr",
          preserve_placeholders: true
        }
      }
    }, { enqueueOnly: true });

    const manifestText = fs.readFileSync(path.join(artifactDir, "manifest.json"), "utf8");
    const ledgerText = fs.readFileSync(path.join(artifactDir, "ledger.json"), "utf8");
    assert.equal(manifestText.includes(signature), false);
    assert.equal(ledgerText.includes(signature), false);
    assert.equal(manifestText.includes("[signed-receipt-redacted]"), true);
    assert.equal(ledgerText.includes("[signed-receipt-redacted]"), true);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("sync corpus API rejects async processors before reserving job state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-sync-async");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    assert.throws(
      () => corpusStart({
        schema_version: "deepseek-harness.corpus.v1",
        job_id: "corpus-sync-async",
        project: "unit-corpus",
        workload_type: "dataset_transform",
        privacy_lane: "local_only",
        processor: {
          type: "deepseek_batch",
          transport: "fake",
          prompt_template: "{{text}}",
          concurrency: 1,
          cost_cap_usd: 0.01
        },
        sources: [{ id: "source", type: "dataset" }],
        shards: [{ id: "row-1", source_id: "source", inline_text: "row" }]
      }),
      /must start through corpusStartAsync/
    );
    assert.equal(fs.existsSync(artifactDir), false);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("blocks corpus artefacts outside the configured artefact root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");

  try {
    assert.throws(
      () =>
        corpusStart({
          schema_version: "deepseek-harness.corpus.v1",
          job_id: "corpus-blocked",
          project: "unit-corpus",
          workload_type: "dataset_transform",
          privacy_lane: "local_only",
          artifact_dir: path.join(root, "outside"),
          sources: [{ id: "dataset", type: "dataset" }],
          shards: [{ id: "row-batch-1", source_id: "dataset", inline_text: "row" }]
        }),
      /Corpus artefacts must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR/
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("blocks an artefact job-directory symlink escape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const corpusRoot = path.join(artifactRoot, "corpus");
  const outsideDir = path.join(root, "outside");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  fs.mkdirSync(corpusRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.symlinkSync(outsideDir, path.join(corpusRoot, "corpus-artifact-symlink"));

  try {
    assert.throws(
      () => corpusStart({
        schema_version: "deepseek-harness.corpus.v1",
        job_id: "corpus-artifact-symlink",
        project: "unit-corpus",
        workload_type: "dataset_transform",
        privacy_lane: "local_only",
        sources: [{ id: "dataset", type: "dataset" }],
        shards: [{ id: "row-batch-1", source_id: "dataset", inline_text: "row" }]
      }),
      /Corpus artefacts must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR/
    );
    assert.equal(fs.existsSync(path.join(outsideDir, "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(outsideDir, "ledger.json")), false);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("blocks shard symlink escapes and sibling substitution for file sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const sourceDir = path.join(root, "source");
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const declaredFile = path.join(sourceDir, "declared.txt");
  const siblingFile = path.join(sourceDir, "sibling.txt");
  const outsideFile = path.join(outsideDir, "outside.txt");
  fs.writeFileSync(declaredFile, "declared");
  fs.writeFileSync(siblingFile, "sibling");
  fs.writeFileSync(outsideFile, "outside");
  const escapedLink = path.join(sourceDir, "escaped.txt");
  fs.symlinkSync(outsideFile, escapedLink);

  const manifest = (sourcePath: string, inputPath: string, jobId: string) => ({
    schema_version: "deepseek-harness.corpus.v1",
    job_id: jobId,
    project: "unit-corpus",
    workload_type: "dataset_transform",
    privacy_lane: "local_only",
    sources: [{
      id: "dataset",
      type: "dataset",
      path: sourcePath,
      ...(fs.statSync(sourcePath).isFile()
        ? { sha256: createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex") }
        : {})
    }],
    shards: [{
      id: "row-batch-1",
      source_id: "dataset",
      input_path: inputPath,
      bounds: { shard_sha256: "0".repeat(64) }
    }]
  });

  try {
    assert.throws(
      () => corpusStart(manifest(sourceDir, escapedLink, "corpus-symlink-escape")),
      /Shard input is outside declared source path/
    );
    assert.throws(
      () => corpusStart(manifest(declaredFile, siblingFile, "corpus-sibling-substitution")),
      /Shard input is outside declared source path/
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("blocks sensitive source origins even when their contents look low entropy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const sourcePath = path.join(root, ".env");
  fs.writeFileSync(sourcePath, "PIN=1234\n");

  try {
    assert.throws(
      () => corpusPlan({
        schema_version: "deepseek-harness.corpus.v1",
        job_id: "corpus-sensitive-source",
        project: "unit-corpus",
        workload_type: "dataset_transform",
        privacy_lane: "external_inference_allowed",
        processor: {
          type: "deepseek_batch",
          transport: "deepseek",
          model: "deepseek-v4-flash",
          prompt_template: "Transform {{text}}",
          concurrency: 1,
          cost_cap_usd: 0.01,
          max_tokens: 32
        },
        sources: [{ id: "source", type: "dataset", path: sourcePath }],
        shards: [{
          id: "chunk-1",
          source_id: "source",
          input_path: sourcePath,
          bounds: { shard_sha256: "0".repeat(64) }
        }]
      }),
      /Corpus source path is sensitive and cannot be ingested/
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("runs corpus shards through fake DeepSeek batch processor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const oldStateDir = process.env.DEEPSEEK_HARNESS_STATE_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  process.env.DEEPSEEK_HARNESS_STATE_DIR = path.join(root, ".state");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-deepseek");

  try {
    const started = await corpusStartAsync({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-deepseek",
      project: "unit-corpus",
      workload_type: "book_reading",
      privacy_lane: "local_only",
      processor: {
        type: "deepseek_batch",
        transport: "fake",
        model: "deepseek-v4-flash",
        response_format: "text",
        prompt_template: "Summarise {{shard_id}}: {{text}}",
        concurrency: 2,
        cost_cap_usd: 0.05
      },
      sources: [{ id: "book", type: "text" }],
      shards: [
        { id: "chapter-1", source_id: "book", inline_text: "Chapter one", bounds: { chapter: 1 } },
        { id: "chapter-2", source_id: "book", inline_text: "Chapter two", bounds: { chapter: 2 } }
      ]
    });
    assert.equal((started.summary as { status: string }).status, "completed");

    const validation = corpusValidate("corpus-deepseek", { artifactDir }) as { ok: boolean; blockers: string[] };
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.blockers, []);

    const resumed = await corpusResumeAsync("corpus-deepseek", { artifactDir });
    assert.equal((resumed.summary as { status: string }).status, "completed");

    const reconciled = corpusReconcile("corpus-deepseek", { artifactDir }) as { output_path: string };
    const output = fs.readFileSync(reconciled.output_path, "utf8");
    assert.match(output, /fake:chapter-1:/);
    assert.match(output, /fake:chapter-2:/);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
    if (oldStateDir === undefined) {
      delete process.env.DEEPSEEK_HARNESS_STATE_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_STATE_DIR = oldStateDir;
    }
  }
});

test("plans corpus workload with explicit live and workload blockers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");

  try {
    const planned = corpusPlan({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-plan-unit",
      project: "unit-corpus",
      workload_type: "book_reading",
      privacy_lane: "local_only",
      processor: {
        type: "deepseek_batch",
        transport: "deepseek",
        model: "deepseek-v4-flash",
        response_format: "text",
        prompt_template: "Summarise {{text}}",
        concurrency: 2,
        cost_cap_usd: 0.05,
        max_tokens: 128
      },
      sources: [{ id: "book", type: "text" }],
      shards: [{ id: "chapter-1", source_id: "book", inline_text: "No bounds for this chapter" }]
    }) as { ok: boolean; blockers: string[]; deepseek_run_plan: { ok: boolean } };

    assert.equal(planned.ok, false);
    assert.equal(planned.deepseek_run_plan.ok, false);
    assert.equal(planned.blockers.includes("book_reading_missing_chapter_or_page_bounds:chapter-1"), true);
    assert.equal(planned.blockers.includes("live_deepseek_blocked_for_local_only_privacy_lane"), true);
    assert.equal(planned.blockers.includes("deepseek_plan:external_deepseek_requires_non_sensitive_bulk_egress"), true);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("fails closed for live redacted-external work until redaction exists", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const manifest = {
    schema_version: "deepseek-harness.corpus.v1",
    job_id: "corpus-redaction-gate",
    project: "unit-corpus",
    workload_type: "translation",
    privacy_lane: "redacted_external_allowed",
    processor: {
      type: "deepseek_batch",
      transport: "deepseek",
      model: "deepseek-v4-flash",
      prompt_template: "Translate {{text}}",
      concurrency: 1,
      cost_cap_usd: 0.01,
      max_tokens: 32
    },
    sources: [{ id: "source", type: "text" }],
    shards: [{
      id: "chunk-1",
      source_id: "source",
      inline_text: "private input",
      bounds: { source_lang: "en", target_lang: "fr" }
    }]
  };

  try {
    const planned = corpusPlan(manifest, { allowLive: true }) as { blockers: string[] };
    assert.equal(
      planned.blockers.includes("live_deepseek_blocked_until_verified_redaction_is_implemented"),
      true
    );
    await assert.rejects(
      () => corpusStartAsync(manifest, { allowLive: true }),
      /until a verified redaction processor is configured/
    );
    const artifactDir = path.join(process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR ?? "", "corpus", "corpus-redaction-gate");
    assert.equal(fs.existsSync(path.join(artifactDir, "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(artifactDir, "ledger.json")), false);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("rejects missing live authority before creating corpus job state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const oldApiKey = process.env.DEEPSEEK_API_KEY;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-live-preflight");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  delete process.env.DEEPSEEK_API_KEY;

  try {
    await assert.rejects(
      () => corpusStartAsync({
        schema_version: "deepseek-harness.corpus.v1",
        job_id: "corpus-live-preflight",
        project: "unit-corpus",
        workload_type: "dataset_transform",
        privacy_lane: "external_inference_allowed",
        processor: {
          type: "deepseek_batch",
          transport: "deepseek",
          model: "deepseek-v4-flash",
          prompt_template: "{{text}}",
          concurrency: 1,
          cost_cap_usd: 0.01,
          max_tokens: 32
        },
        sources: [{ id: "source", type: "dataset" }],
        shards: [{
          id: "row-1",
          source_id: "source",
          inline_text: "one",
          bounds: { row_start: 1, row_end: 1, row_count: 1 }
        }]
      }, { allowLive: true }),
      /Live corpus preflight failed before job state was created/
    );
    assert.equal(fs.existsSync(path.join(artifactDir, "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(artifactDir, "ledger.json")), false);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
    if (oldApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = oldApiKey;
    }
  }
});

test("rejects multi-batch live corpus work before creating job state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-live-multi-batch");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  const manifest = {
    schema_version: "deepseek-harness.corpus.v1",
    job_id: "corpus-live-multi-batch",
    project: "unit-corpus",
    workload_type: "dataset_transform",
    privacy_lane: "external_inference_allowed",
    max_shards_per_batch: 1,
    processor: {
      type: "deepseek_batch",
      transport: "deepseek",
      model: "deepseek-v4-flash",
      prompt_template: "{{text}}",
      concurrency: 1,
      cost_cap_usd: 0.01,
      max_tokens: 32
    },
    sources: [{ id: "source", type: "dataset" }],
    shards: ["one", "two"].map((inlineText, index) => ({
      id: `row-${index + 1}`,
      source_id: "source",
      inline_text: inlineText,
      bounds: { row_start: index + 1, row_end: index + 1, row_count: 1 }
    }))
  };

  try {
    const planned = corpusPlan(manifest, { allowLive: true }) as { blockers: string[] };
    assert.equal(planned.blockers.includes("live_corpus_requires_single_approved_batch"), true);
    await assert.rejects(
      () => corpusStartAsync(manifest, { allowLive: true }),
      /must fit one separately approved count-and-byte-bounded batch/
    );
    assert.equal(fs.existsSync(path.join(artifactDir, "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(artifactDir, "ledger.json")), false);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("worker loop refuses duplicate corpus worker locks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-lock");

  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "worker.lock"), "held");
    await assert.rejects(
      () => corpusWorkAsync("corpus-lock", { artifactDir, maxIterations: 1 }),
      /Corpus worker lock already exists/
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("cancel honours the same per-job worker lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-cancel-lock");

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-cancel-lock",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "source", type: "dataset" }],
      shards: [{ id: "row-1", source_id: "source", inline_text: "row" }]
    });
    fs.writeFileSync(path.join(artifactDir, "worker.lock"), "held");
    assert.throws(
      () => corpusCancel("corpus-cancel-lock", { artifactDir }),
      /Corpus worker lock already exists/
    );
    assert.equal((corpusStatus("corpus-cancel-lock", { artifactDir }) as { summary: { status: string } }).summary.status, "completed");
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("direct sync and async resume paths honour the corpus worker lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-resume-lock");

  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "worker.lock"), "held");
    assert.throws(
      () => corpusResume("corpus-resume-lock", { artifactDir }),
      /Corpus worker lock already exists/
    );
    await assert.rejects(
      () => corpusResumeAsync("corpus-resume-lock", { artifactDir }),
      /Corpus worker lock already exists/
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("recovers a completed shard from durable proof when the ledger is stale after a crash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-crash-recovery-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-crash-recovery");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-crash-recovery",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset" }],
      shards: [{ id: "row-1", source_id: "dataset", inline_text: "durable original" }]
    });

    const ledgerPath = path.join(artifactDir, "ledger.json");
    makeCorpusLedgerStale(artifactDir);

    const resumed = corpusResume("corpus-crash-recovery", { artifactDir }) as {
      summary: { status: string; counts: { succeeded: number } };
    };
    assert.equal(resumed.summary.status, "completed");
    assert.equal(resumed.summary.counts.succeeded, 1);
    assert.equal(fs.readFileSync(path.join(artifactDir, "outputs", "row-1.txt"), "utf8"), "durable original");
    const recoveredLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      shards: Array<{ attempts: number }>;
    };
    assert.equal(recoveredLedger.shards[0]?.attempts, 0);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("recovers when a crash leaves a truncated shard output before proof publication", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-partial-output-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-partial-output");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-partial-output",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset" }],
      shards: [{
        id: "row-1",
        source_id: "dataset",
        inline_text: "complete deterministic output",
        bounds: { row_start: 1, row_end: 1, row_count: 1 }
      }]
    });
    const outputPath = path.join(artifactDir, "outputs", "row-1.txt");
    const proofPath = path.join(artifactDir, "proof", "row-1.json");
    makeCorpusLedgerStale(artifactDir);
    fs.writeFileSync(outputPath, "complete deter");
    fs.unlinkSync(proofPath);

    const resumed = corpusResume("corpus-partial-output", { artifactDir }) as {
      summary: { status: string; counts: { succeeded: number } };
    };
    assert.equal(resumed.summary.status, "completed");
    assert.equal(resumed.summary.counts.succeeded, 1);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "complete deterministic output");
    const validation = corpusValidate("corpus-partial-output", { artifactDir }) as { ok: boolean; blockers: string[] };
    assert.deepEqual(validation.blockers, []);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("recovers when a crash leaves a truncated shard proof before checkpoint publication", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-partial-proof-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-partial-proof");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-partial-proof",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset" }],
      shards: [{
        id: "row-1",
        source_id: "dataset",
        inline_text: "durable output",
        bounds: { row_start: 1, row_end: 1, row_count: 1 }
      }]
    });
    const proofPath = path.join(artifactDir, "proof", "row-1.json");
    const completeProof = fs.readFileSync(proofPath, "utf8");
    makeCorpusLedgerStale(artifactDir);
    fs.writeFileSync(proofPath, completeProof.slice(0, -7));

    const resumed = corpusResume("corpus-partial-proof", { artifactDir }) as {
      summary: { status: string; counts: { succeeded: number } };
    };
    assert.equal(resumed.summary.status, "completed");
    assert.equal(resumed.summary.counts.succeeded, 1);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(proofPath, "utf8")));
    const validation = corpusValidate("corpus-partial-proof", { artifactDir }) as { ok: boolean; blockers: string[] };
    assert.deepEqual(validation.blockers, []);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("does not clobber unrelated shard output while recovering an interrupted publication", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-output-conflict-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-output-conflict");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-output-conflict",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset" }],
      shards: [{ id: "row-1", source_id: "dataset", inline_text: "expected output" }]
    });
    const outputPath = path.join(artifactDir, "outputs", "row-1.txt");
    makeCorpusLedgerStale(artifactDir);
    fs.writeFileSync(outputPath, "unrelated conflicting file");
    fs.unlinkSync(path.join(artifactDir, "proof", "row-1.json"));

    const resumed = corpusResume("corpus-output-conflict", { artifactDir }) as { summary: { status: string } };
    assert.notEqual(resumed.summary.status, "completed");
    assert.equal(fs.readFileSync(outputPath, "utf8"), "unrelated conflicting file");
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("rejects recovered shard proof from a processor or OCR engine not selected by the manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-proof-processor-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-proof-processor");
  const sourcePath = path.join(root, "source.txt");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  fs.writeFileSync(sourcePath, "bound source");

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-proof-processor",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{
        id: "source",
        type: "text",
        path: sourcePath,
        sha256: createHash("sha256").update("bound source").digest("hex")
      }],
      shards: [{
        id: "row-1",
        source_id: "source",
        input_path: sourcePath,
        bounds: { shard_sha256: createHash("sha256").update("bound source").digest("hex") }
      }]
    });
    const manifestPath = path.join(artifactDir, "manifest.json");
    const proofPath = path.join(artifactDir, "proof", "row-1.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.processor = { type: "local_ocr", engine: "tesseract" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as Record<string, unknown>;
    proof.processor_version = "local_ocr.focr.v1";
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
    makeCorpusLedgerStale(artifactDir);

    assert.throws(
      () => corpusResume("corpus-proof-processor", { artifactDir }),
      /proof processor does not match manifest processor/
    );
    assert.equal(
      (JSON.parse(fs.readFileSync(proofPath, "utf8")) as { processor_version: string }).processor_version,
      "local_ocr.focr.v1"
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("validation fails closed when shard proof provenance is tampered", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-proof-tamper-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "corpus-proof-tamper");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "corpus-proof-tamper",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset" }],
      shards: [{ id: "row-1", source_id: "dataset", inline_text: "durable source" }]
    });
    const proofPath = path.join(artifactDir, "proof", "row-1.json");
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as Record<string, unknown>;
    proof.source_id = "substituted-source";
    proof.processor_version = "substituted-processor.v1";
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));

    const validation = corpusValidate("corpus-proof-tamper", { artifactDir }) as { ok: boolean; blockers: string[] };
    assert.equal(validation.ok, false);
    assert.equal(validation.blockers.includes("proof_source_mismatch:row-1"), true);
    assert.equal(validation.blockers.includes("proof_processor_mismatch:row-1"), true);
    assert.throws(
      () => corpusReconcile("corpus-proof-tamper", { artifactDir }),
      /cannot be reconciled until validation passes/
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("rejects unbounded file-backed shards larger than 64 MiB before materialising them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-large-shard-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const artifactRoot = path.join(root, "artifacts");
  const sourcePath = path.join(root, "large.jsonl");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  const writeFd = fs.openSync(sourcePath, "w");
  fs.ftruncateSync(writeFd, 64 * 1024 * 1024 + 1);
  fs.closeSync(writeFd);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const readFd = fs.openSync(sourcePath, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(readFd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(readFd);
  }

  try {
    assert.throws(
      () => corpusPlan({
        schema_version: "deepseek-harness.corpus.v1",
        job_id: "corpus-large-shard",
        project: "unit-corpus",
        workload_type: "dataset_transform",
        privacy_lane: "local_only",
        processor: {
          type: "deepseek_batch",
          transport: "dry-run",
          prompt_template: "{{text}}",
          concurrency: 1,
          cost_cap_usd: 0.01
        },
        sources: [{ id: "dataset", type: "dataset", path: sourcePath, sha256: hash.digest("hex") }],
        shards: [{
          id: "row-1",
          source_id: "dataset",
          input_path: sourcePath,
          bounds: { shard_sha256: "0".repeat(64), row_start: 1, row_end: 1, row_count: 1 }
        }]
      }),
      /exceeds the 64 MiB processing cap/
    );
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("rejects crafted inline shards larger than the core manifest limit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-inline-limit-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");

  try {
    assert.throws(() => corpusPlan({
      schema_version: "deepseek-harness.corpus.v1",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset" }],
      shards: [{ id: "row-1", source_id: "dataset", inline_text: "x".repeat(16 * 1024 * 1024 + 1) }]
    }), /Corpus manifest failed validation/);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("requires SHA-256 provenance for every regular file source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-file-sha-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const sourcePath = path.join(root, "source.txt");
  fs.writeFileSync(sourcePath, "source");

  try {
    assert.throws(() => corpusPlan({
      schema_version: "deepseek-harness.corpus.v1",
      project: "unit-corpus",
      workload_type: "dataset_transform",
      privacy_lane: "local_only",
      sources: [{ id: "dataset", type: "dataset", path: sourcePath }],
      shards: [{
        id: "row-1",
        source_id: "dataset",
        input_path: sourcePath,
        bounds: { shard_sha256: createHash("sha256").update("source").digest("hex") }
      }]
    }), /File-backed corpus source requires sha256/);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

test("worker loop reclaims a well-formed lock owned by a dead process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-"));
  const oldArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = path.join(root, "artifacts");
  const artifactDir = path.join(root, "artifacts", "corpus", "corpus-stale-lock");

  try {
    fs.mkdirSync(path.join(artifactDir, "outputs"), { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, "worker.lock"),
      JSON.stringify({ schema_version: "deepseek-harness.corpus-worker-lock.v1", pid: 2_147_483_647 })
    );
    const manifestPath = path.join(artifactDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema_version: "deepseek-harness.corpus.v1",
        job_id: "corpus-stale-lock",
        project: "stale-lock",
        workload_type: "dataset_transform",
        privacy_lane: "local_only",
        artifact_dir: artifactDir,
        processor: { type: "copy_text" },
        sources: [{ id: "source:one", type: "dataset" }],
        shards: [
          {
            id: "source:one:rows:1-1",
            source_id: "source:one",
            inline_text: "{}\n",
            bounds: { row_start: 1, row_end: 1, row_count: 1 }
          }
        ]
      })
    );
    fs.writeFileSync(
      path.join(artifactDir, "ledger.json"),
      JSON.stringify({
        schema_version: "deepseek-harness.corpus-ledger.v1",
        job_id: "corpus-stale-lock",
        project: "stale-lock",
        workload_type: "dataset_transform",
        privacy_lane: "local_only",
        status: "running",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        manifest_path: manifestPath,
        artifact_dir: artifactDir,
        processor: { type: "copy_text" },
        max_retries: 2,
        shards: []
      })
    );

    const result = await corpusWorkAsync("corpus-stale-lock", { artifactDir, maxIterations: 1 }) as {
      summary: { status: string };
    };
    assert.equal(result.summary.status, "completed");
    assert.equal(fs.existsSync(path.join(artifactDir, "worker.lock")), false);
  } finally {
    if (oldArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = oldArtifactRoot;
    }
  }
});

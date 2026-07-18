import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  corpusCommitTranslationMemory,
  corpusStart,
  corpusStartAsync,
  corpusTranslationReviewPacket,
  corpusValidate
} from "../src/corpus.js";
import { buildTextCorpusManifest } from "../src/corpus_ingest.js";
import { buildOcrCorpusManifest } from "../src/corpus_ocr.js";
import { buildTranslationCorpusManifest } from "../src/corpus_translation.js";

process.env.DEEPSEEK_HARNESS_INPUT_ROOT = os.tmpdir();
import {
  commitReviewedTranslationMemoryBatch,
  openTranslationMemory
} from "../src/corpus_translation_memory.js";
import {
  translationReviewReceiptSigningPayload,
  type TranslationReviewReceipt
} from "../src/corpus_translation_review.js";

test("runs a local OCR processor through the corpus ledger and proof path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-heavy-ocr-"));
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "ocr-ledger");
  const binDir = path.join(root, "bin");
  const imagePath = path.join(root, "page.png");
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const previousPath = process.env.PATH;
  fs.mkdirSync(binDir);
  fs.writeFileSync(imagePath, "fixture bytes");
  const focrPath = path.join(binDir, "focr");
  fs.writeFileSync(focrPath, "#!/bin/sh\nprintf '%s\\n' '{\"text\":\"Ledgered OCR output\",\"page_number\":1}'\n");
  fs.chmodSync(focrPath, 0o755);
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  try {
    const manifest = buildOcrCorpusManifest({
      project: "ocr-ledger",
      sourcePath: imagePath,
      privacyLane: "local_only",
      engine: "focr",
      artifactDir
    });
    const started = corpusStart(manifest) as { summary: { job_id: string; status: string; counts: Record<string, number> } };
    assert.equal(started.summary.status, "completed");
    assert.equal(started.summary.counts.succeeded, 1);

    const validation = corpusValidate(started.summary.job_id, { artifactDir }) as { ok: boolean; blockers: string[] };
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.blockers, []);
    const outputPath = path.join(artifactDir, "outputs", `${manifest.shards[0]?.id}.txt`);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "Ledgered OCR output");
    const proof = JSON.parse(fs.readFileSync(path.join(artifactDir, "proof", `${manifest.shards[0]?.id}.json`), "utf8")) as {
      processor_version: string;
      ocr_engine: string;
    };
    assert.equal(proof.processor_version, "local_ocr.focr.v1");
    assert.equal(proof.ocr_engine, "focr");
  } finally {
    process.env.PATH = previousPath;
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
  }
});

test("refuses OCR proof when the source changes during engine execution", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-heavy-ocr-race-"));
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "ocr-race");
  const binDir = path.join(root, "bin");
  const imagePath = path.join(root, "page.png");
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const previousPath = process.env.PATH;
  fs.mkdirSync(binDir);
  fs.writeFileSync(imagePath, "original image bytes");
  const focrPath = path.join(binDir, "focr");
  fs.writeFileSync(
    focrPath,
    "#!/bin/sh\nprintf '%s' 'changed image bytes' > \"$2\"\nprintf '%s\\n' '{\"text\":\"untrusted OCR output\",\"page_number\":1}'\n"
  );
  fs.chmodSync(focrPath, 0o755);
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;

  try {
    const manifest = buildOcrCorpusManifest({
      project: "ocr-race",
      sourcePath: imagePath,
      privacyLane: "local_only",
      engine: "focr",
      artifactDir
    });
    const result = corpusStart(manifest) as { summary: { status: string; counts: { failed: number } } };
    assert.equal(result.summary.status, "running");
    assert.equal(result.summary.counts.failed, 1);
    assert.equal(fs.readdirSync(path.join(artifactDir, "outputs")).length, 0);
    assert.match(fs.readFileSync(path.join(artifactDir, "events.jsonl"), "utf8"), /Corpus source changed during OCR/);
  } finally {
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test("rejects source drift before creating corpus job artefacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-heavy-drift-"));
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "drift-job");
  const imagePath = path.join(root, "page.png");
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  fs.writeFileSync(imagePath, "original image bytes");

  try {
    const manifest = buildOcrCorpusManifest({
      project: "drift-job",
      sourcePath: imagePath,
      engine: "focr",
      artifactDir
    });
    fs.writeFileSync(imagePath, "changed image bytes");
    assert.throws(() => corpusStart(manifest), /source hash changed after manifest creation/);
    assert.equal(fs.existsSync(artifactDir), false);
  } finally {
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
  }
});

test("rejects substituted inline shard text that retains stale provenance hashes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-heavy-provenance-"));
  const artifactRoot = path.join(root, "artifacts");
  const sourcePath = path.join(root, "source.txt");
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  fs.writeFileSync(sourcePath, "Original source text");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    const manifest = buildTextCorpusManifest({
      project: "inline-provenance",
      sourcePath,
      workloadType: "book_reading",
      privacyLane: "local_only",
      chunkChars: 100,
      overlapChars: 0,
      artifactDir: path.join(artifactRoot, "corpus", "inline-provenance")
    });
    const substituted = {
      ...manifest,
      shards: [{ ...manifest.shards[0], inline_text: "Substituted content" }]
    };
    assert.throws(() => corpusStart(substituted), /does not match declared provenance/);
  } finally {
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
  }
});

test("uses reviewed exact translation-memory hits before batch inference", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-heavy-translation-"));
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "translation-memory-job");
  const sourcePath = path.join(root, "source.txt");
  const memoryPath = "translation-memory/reviewed.sqlite";
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  const previousStateDir = process.env.DEEPSEEK_HARNESS_STATE_DIR;
  const previousReviewPublicKey = process.env.DEEPSEEK_HARNESS_TRANSLATION_REVIEW_PUBLIC_KEY;
  fs.writeFileSync(sourcePath, "Hello {name}");
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  process.env.DEEPSEEK_HARNESS_STATE_DIR = path.join(root, ".state");

  const memory = openTranslationMemory({ dbPath: memoryPath, allowedRoot: artifactRoot });
  commitReviewedTranslationMemoryBatch(memory, {
    provenance: {
      receiptId: "reviewed-fixture-001",
      receiptSha256: "a".repeat(64),
      reviewer: "integration-fixture",
      reviewPayloadSha256: "b".repeat(64)
    },
    entries: [{
      namespace: "translation-memory-job",
      sourceText: "Hello {name}",
      targetText: "Bonjour {name}",
      sourceLang: "en",
      targetLang: "fr",
      glossarySha256: null
    }]
  });
  memory.close();

  try {
    const manifest = buildTranslationCorpusManifest({
      project: "translation-memory-job",
      sourcePath,
      sourceLang: "en",
      targetLang: "fr",
      transport: "fake",
      privacyLane: "local_only",
      chunkChars: 100,
      translationMemoryPath: memoryPath,
      artifactDir
    });
    const started = await corpusStartAsync(manifest) as { summary: { job_id: string; status: string } };
    assert.equal(started.summary.status, "completed");

    const validation = corpusValidate(started.summary.job_id, { artifactDir }) as {
      ok: boolean;
      blockers: string[];
      translation_qa: Array<{ ok: boolean }>;
    };
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.blockers, []);
    assert.equal(validation.translation_qa[0]?.ok, true);
    const outputPath = path.join(artifactDir, "outputs", `${manifest.shards[0]?.id}.txt`);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "Bonjour {name}");

    assert.throws(
      () => corpusCommitTranslationMemory(started.summary.job_id, { artifactDir }),
      /owner-signed review receipt/
    );
    const keys = generateKeyPairSync("ed25519");
    process.env.DEEPSEEK_HARNESS_TRANSLATION_REVIEW_PUBLIC_KEY = keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const reviewPacket = corpusTranslationReviewPacket(started.summary.job_id, { artifactDir }) as {
      packet: { project: string; review_payload_sha256: string };
    };
    const now = Date.now();
    const unsignedReceipt: TranslationReviewReceipt = {
      schema_version: "deepseek-harness.translation-review-receipt.v1",
      receipt_id: "review-receipt-integration-001",
      status: "approved",
      issuer: "owner",
      reviewer: "integration-owner",
      issued_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 10 * 60_000).toISOString(),
      nonce: "translation_review_nonce_001",
      job_id: started.summary.job_id,
      project: reviewPacket.packet.project,
      review_payload_sha256: reviewPacket.packet.review_payload_sha256,
      signature_base64: "pending-signature"
    };
    const reviewReceipt = {
      ...unsignedReceipt,
      signature_base64: sign(
        null,
        Buffer.from(translationReviewReceiptSigningPayload(unsignedReceipt), "utf8"),
        keys.privateKey
      ).toString("base64")
    };
    const workerLockPath = path.join(artifactDir, "worker.lock");
    fs.writeFileSync(
      workerLockPath,
      JSON.stringify({
        schema_version: "deepseek-harness.corpus-worker-lock.v1",
        pid: process.pid,
        acquired_at: new Date().toISOString()
      })
    );
    try {
      assert.throws(
        () => corpusCommitTranslationMemory(started.summary.job_id, { artifactDir, reviewReceipt }),
        /worker lock already exists/
      );
    } finally {
      fs.unlinkSync(workerLockPath);
    }
    const committed = corpusCommitTranslationMemory(started.summary.job_id, {
      artifactDir,
      reviewReceipt
    }) as { ok: boolean; stats: { entry_count: number }; entries: Array<{ inserted: boolean }> };
    assert.equal(committed.ok, true);
    assert.equal(committed.stats.entry_count, 1);
    assert.equal(committed.entries[0]?.inserted, false);
  } finally {
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
    if (previousStateDir === undefined) {
      delete process.env.DEEPSEEK_HARNESS_STATE_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_STATE_DIR = previousStateDir;
    }
    if (previousReviewPublicKey === undefined) {
      delete process.env.DEEPSEEK_HARNESS_TRANSLATION_REVIEW_PUBLIC_KEY;
    } else {
      process.env.DEEPSEEK_HARNESS_TRANSLATION_REVIEW_PUBLIC_KEY = previousReviewPublicKey;
    }
  }
});

test("enforces minimum section length for long-form reconciliation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-heavy-longform-"));
  const artifactRoot = path.join(root, "artifacts");
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;

  try {
    const artifactDir = path.join(artifactRoot, "corpus", "longform-qa");
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "longform-qa",
      project: "longform-qa",
      workload_type: "longform_generation",
      privacy_lane: "local_only",
      artifact_dir: artifactDir,
      processor: { type: "copy_text" },
      sources: [{ id: "outline", type: "text" }],
      shards: [{ id: "section-1", source_id: "outline", inline_text: "One two three four five six", bounds: { section: "Opening" } }],
      acceptance: { minimum_words_per_section: 5 }
    });
    const passing = corpusValidate("longform-qa", { artifactDir }) as {
      ok: boolean;
      longform_qa: Array<{ metrics: { word_count: number } }>;
    };
    assert.equal(passing.ok, true);
    assert.equal(passing.longform_qa[0]?.metrics.word_count, 6);

    const shortArtifactDir = path.join(artifactRoot, "corpus", "longform-short");
    corpusStart({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "longform-short",
      project: "longform-short",
      workload_type: "longform_generation",
      privacy_lane: "local_only",
      artifact_dir: shortArtifactDir,
      processor: { type: "copy_text" },
      sources: [{ id: "outline", type: "text" }],
      shards: [{ id: "section-1", source_id: "outline", inline_text: "Too short", bounds: { section: "Opening" } }],
      acceptance: { minimum_words_per_section: 5 }
    });
    const failing = corpusValidate("longform-short", { artifactDir: shortArtifactDir }) as {
      ok: boolean;
      blockers: string[];
    };
    assert.equal(failing.ok, false);
    assert.match(failing.blockers.join(","), /minimum_words_not_met:2:5/);
  } finally {
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
  }
});

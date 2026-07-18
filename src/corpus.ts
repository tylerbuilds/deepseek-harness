import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { canonicalJson } from "./approval.js";
import { HarnessError } from "./errors.js";
import { assertSafeCorpusSourcePath, defaultArtifactRoot } from "./paths.js";
import { approvalPacket, getResults, planManifest, submitManifest } from "./runner.js";
import { approvalReceiptSchema, modelSchema, thinkingSchema, type RunManifest } from "./schema.js";
import { validateCorpusWorkload } from "./corpus_validation.js";
import { extractOcrShard } from "./corpus_ocr.js";
import { evaluateTranslationQa } from "./corpus_translation.js";
import {
  commitReviewedTranslationMemoryBatch,
  lookupTranslationMemory,
  openTranslationMemory,
  translationMemoryStats,
  type TranslationMemoryUpsertInput
} from "./corpus_translation_memory.js";
import {
  parseTranslationReviewReceipt,
  validateTranslationReviewReceipt
} from "./corpus_translation_review.js";

const MAX_INLINE_TEXT_CHARS = 16 * 1024 * 1024;
const MAX_SHARD_INPUT_BYTES = 64 * 1024 * 1024;

const corpusSourceSchema = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
  path: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  type: z.enum(["text", "pdf", "image", "audio", "video", "dataset", "other"]).default("text")
});

const corpusShardSchema = z
  .object({
    id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
    source_id: z.string().min(1).max(200),
    input_path: z.string().min(1).optional(),
    inline_text: z.string().min(1).max(MAX_INLINE_TEXT_CHARS).optional(),
    bounds: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
  })
  .refine((shard) => Boolean(shard.input_path) || Boolean(shard.inline_text), {
    message: "Each corpus shard must include input_path or inline_text"
  });

const corpusProcessorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copy_text").default("copy_text") }),
  z.object({
    type: z.literal("local_ocr"),
    engine: z.enum(["auto", "macos_vision", "focr", "tesseract"]).default("auto"),
    language: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("deepseek_batch"),
    transport: z.enum(["fake", "dry-run", "deepseek"]).default("fake"),
    model: modelSchema.default("deepseek-v4-flash"),
    thinking: thinkingSchema.default({ type: "enabled" }),
    response_format: z.enum(["text", "json_object"]).default("text"),
    prompt_template: z.string().min(1).max(65_536).refine(
      (template) => (template.match(/\{\{text\}\}/g) ?? []).length === 1,
      "prompt_template must contain {{text}} exactly once"
    ),
    system_prompt: z.string().min(1).max(65_536).optional(),
    concurrency: z.number().int().positive().max(100).default(5),
    cost_cap_usd: z.number().positive().max(100).default(0.1),
    max_tokens: z.number().int().positive().max(384000).optional(),
    approval_receipt: approvalReceiptSchema.optional()
  })
]);

const corpusManifestSchema = z.object({
  schema_version: z.literal("deepseek-harness.corpus.v1"),
  job_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  project: z.string().min(1).max(128).refine((value) => value.trim().length > 0),
  workload_type: z.enum([
    "book_reading",
    "ocr",
    "translation",
    "dataset_transform",
    "longform_generation",
    "media_catalogue",
    "mixed"
  ]),
  privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]),
  artifact_dir: z.string().min(1).optional(),
  processor: corpusProcessorSchema.default({ type: "copy_text" }),
  max_retries: z.number().int().min(0).max(10).default(2),
  max_shards_per_batch: z.number().int().positive().max(1000).default(25),
  max_batch_input_bytes: z.number().int().positive().max(64 * 1024 * 1024).default(16 * 1024 * 1024),
  sources: z.array(corpusSourceSchema).min(1),
  shards: z.array(corpusShardSchema).min(1).max(10000),
  acceptance: z.record(z.unknown()).optional()
});

type CorpusManifest = z.infer<typeof corpusManifestSchema>;
type CorpusShard = z.infer<typeof corpusShardSchema>;
type CorpusShardStatus = "pending" | "leased" | "running" | "succeeded" | "failed" | "quarantined" | "cancelled" | "invalidated";

interface CorpusLedgerShard {
  shard_id: string;
  source_id: string;
  source_locator: string;
  status: CorpusShardStatus;
  attempts: number;
  bounds: CorpusShard["bounds"] | null;
  overlap: CorpusShard["bounds"] | null;
  processor_version: string;
  privacy_lane: CorpusManifest["privacy_lane"];
  redaction_status: "not_required" | "required" | "completed";
  lease_owner: string | null;
  lease_expires_at: string | null;
  input_sha256: string | null;
  output_path: string | null;
  output_sha256: string | null;
  proof_path: string | null;
  processor_run_id: string | null;
  error: string | null;
  last_error_type: string | null;
  next_retry_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  committed_at: string | null;
}

interface CorpusLedger {
  schema_version: "deepseek-harness.corpus-ledger.v1";
  job_id: string;
  project: string;
  workload_type: CorpusManifest["workload_type"];
  privacy_lane: CorpusManifest["privacy_lane"];
  status: "running" | "completed" | "failed" | "cancelled";
  created_at: string;
  updated_at: string;
  manifest_path: string;
  artifact_dir: string;
  processor: CorpusManifest["processor"];
  max_retries: number;
  max_shards_per_batch: number;
  max_batch_input_bytes: number;
  shards: CorpusLedgerShard[];
}

export function corpusStart(input: unknown): Record<string, unknown> {
  const manifest = parseCorpusManifest(input);
  if (manifest.processor.type === "deepseek_batch") {
    throw new HarnessError(
      "corpus_async_processor_required",
      "deepseek_batch corpus jobs must start through corpusStartAsync"
    );
  }
  return corpusStartSync(manifest);
}

export async function corpusStartAsync(
  input: unknown,
  options: { allowLive?: boolean; enqueueOnly?: boolean } = {}
): Promise<Record<string, unknown>> {
  const runtimeManifest = parseCorpusManifest(input);
  if (runtimeManifest.processor.type === "deepseek_batch" && runtimeManifest.processor.transport === "deepseek") {
    assertShardInputsSafe(runtimeManifest);
    ensureShardSources(runtimeManifest);
    const sourceHashes = verifySourceIntegrity(runtimeManifest);
    verifyInlineShardIntegrity(runtimeManifest, sourceHashes);
    if (options.enqueueOnly) {
      throw new HarnessError(
        "corpus_live_enqueue_not_supported",
        "Live corpus receipts are ephemeral and cannot be persisted for unattended execution"
      );
    }
    if (!deepSeekCorpusFitsSingleBatch(runtimeManifest)) {
      throw new HarnessError(
        "corpus_live_requires_single_batch",
        "Live corpus jobs must fit one separately approved count-and-byte-bounded batch"
      );
    }
    if (runtimeManifest.privacy_lane === "local_only") {
      throw new HarnessError("corpus_live_egress_blocked", "local_only corpus jobs cannot use live DeepSeek transport");
    }
    if (runtimeManifest.privacy_lane === "redacted_external_allowed") {
      throw new HarnessError(
        "corpus_redaction_not_implemented",
        "redacted_external_allowed jobs cannot use live DeepSeek until a verified redaction processor is configured"
      );
    }
    const artifactDir = safeArtifactDir(
      runtimeManifest.artifact_dir ??
        path.join(defaultArtifactRoot(), "corpus", runtimeManifest.job_id ?? `${runtimeManifest.project}-live-preflight`)
    );
    const livePlan = planManifest(
      buildDeepSeekRunManifestForPlan(runtimeManifest, artifactDir),
      { allowLive: Boolean(options.allowLive) }
    ) as { ok: boolean; plan?: { blockers?: string[] } };
    if (!livePlan.ok) {
      throw new HarnessError(
        "corpus_live_preflight_failed",
        "Live corpus preflight failed before job state was created",
        { blockers: livePlan.plan?.blockers ?? [] }
      );
    }
  }
  const started = corpusStartSync(input, { autoResume: false });
  if (options.enqueueOnly) {
    return started;
  }
  const summary = started.summary as { job_id?: unknown; artifact_dir?: unknown };
  const jobId = typeof summary.job_id === "string" ? summary.job_id : String((started as { job_id?: unknown }).job_id ?? "");
  const artifactDir = typeof summary.artifact_dir === "string" ? summary.artifact_dir : undefined;
  if (runtimeManifest.processor.type === "deepseek_batch" && artifactDir) {
    const ledger = readLedger(jobId, { artifactDir });
    const runtimeManifestWithJob: CorpusManifest = {
      ...runtimeManifest,
      job_id: jobId,
      artifact_dir: artifactDir
    };
    return withCorpusWorkerLock(artifactDir, () =>
      processDeepSeekCorpusBatch(ledger, runtimeManifestWithJob, { allowLive: Boolean(options.allowLive) })
    );
  }
  return corpusResumeAsync(jobId, { artifactDir, allowLive: options.allowLive });
}

function corpusStartSync(input: unknown, options: { autoResume?: boolean } = {}): Record<string, unknown> {
  const manifest = parseCorpusManifest(input);
  assertCorpusWorkloadContract(manifest);
  if (options.autoResume !== false && manifest.processor.type === "deepseek_batch") {
    throw new HarnessError(
      "corpus_async_processor_required",
      "deepseek_batch corpus jobs must start through corpusStartAsync"
    );
  }
  assertShardInputsSafe(manifest);
  ensureShardSources(manifest);
  const sourceHashes = verifySourceIntegrity(manifest);
  verifyInlineShardIntegrity(manifest, sourceHashes);
  if (
    manifest.processor.type === "deepseek_batch" &&
    manifest.processor.transport === "deepseek" &&
    !deepSeekCorpusFitsSingleBatch(manifest)
  ) {
    throw new HarnessError(
      "corpus_live_requires_single_batch",
      "Live corpus jobs must fit one separately approved count-and-byte-bounded batch"
    );
  }
  const jobId = manifest.job_id ?? randomUUID();
  const artifactDir = safeArtifactDir(manifest.artifact_dir ?? path.join(defaultArtifactRoot(), "corpus", jobId));
  const manifestWithJob: CorpusManifest = { ...manifest, job_id: jobId, artifact_dir: artifactDir };
  const storedManifest = redactCorpusApprovalReceipt(manifestWithJob);
  fs.mkdirSync(artifactDir, { recursive: true });
  const manifestPath = path.join(artifactDir, "manifest.json");
  const reservedStatePaths = [manifestPath, ledgerPath(artifactDir), path.join(artifactDir, "events.jsonl")];
  if (reservedStatePaths.some((statePath) => fs.existsSync(statePath))) {
    throw new HarnessError("corpus_job_already_exists", `Corpus job state already exists: ${artifactDir}`);
  }
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(storedManifest, null, 2), { flag: "wx" });
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new HarnessError("corpus_job_already_exists", `Corpus job state already exists: ${artifactDir}`);
    }
    throw error;
  }
  fs.mkdirSync(path.join(artifactDir, "outputs"), { recursive: true });

  const now = new Date().toISOString();
  const ledger: CorpusLedger = {
    schema_version: "deepseek-harness.corpus-ledger.v1",
    job_id: jobId,
    project: manifest.project,
    workload_type: manifest.workload_type,
    privacy_lane: manifest.privacy_lane,
    status: "running",
    created_at: now,
    updated_at: now,
    manifest_path: manifestPath,
    artifact_dir: artifactDir,
    processor: storedManifest.processor,
    max_retries: manifest.max_retries,
    max_shards_per_batch: manifest.max_shards_per_batch,
    max_batch_input_bytes: manifest.max_batch_input_bytes,
    shards: manifest.shards.map((shard) => ({
      shard_id: shard.id,
      source_id: shard.source_id,
      source_locator: shard.input_path ?? `inline:${shard.id}`,
      status: "pending",
      attempts: 0,
      bounds: shard.bounds ?? null,
      overlap: null,
      processor_version: `${manifest.processor.type}.v1`,
      privacy_lane: manifest.privacy_lane,
      redaction_status: manifest.privacy_lane === "redacted_external_allowed" ? "required" : "not_required",
      lease_owner: null,
      lease_expires_at: null,
      input_sha256: null,
      output_path: null,
      output_sha256: null,
      proof_path: null,
      processor_run_id: null,
      error: null,
      last_error_type: null,
      next_retry_at: null,
      started_at: null,
      finished_at: null,
      committed_at: null
    }))
  };
  writeLedger(ledger);
  appendEvent(artifactDir, "job_started", { job_id: jobId, shard_count: manifest.shards.length });
  return options.autoResume === false
    ? { ok: true, summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) }
    : corpusResume(jobId, { artifactDir });
}

function redactCorpusApprovalReceipt(manifest: CorpusManifest): CorpusManifest {
  if (manifest.processor.type !== "deepseek_batch" || !manifest.processor.approval_receipt) {
    return manifest;
  }
  return {
    ...manifest,
    processor: {
      ...manifest.processor,
      approval_receipt: {
        ...manifest.processor.approval_receipt,
        signature_base64: "[signed-receipt-redacted]"
      }
    }
  };
}

export function corpusStatus(jobId: string, options: { artifactDir?: string } = {}): Record<string, unknown> {
  const ledger = readLedger(jobId, options);
  return { ok: true, summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
}

export function corpusPlan(input: unknown, options: { allowLive?: boolean } = {}): Record<string, unknown> {
  const manifest = parseCorpusManifest(input);
  assertShardInputsSafe(manifest);
  ensureShardSources(manifest);
  const sourceHashes = verifySourceIntegrity(manifest);
  verifyInlineShardIntegrity(manifest, sourceHashes);
  const artifactDir = safeArtifactDir(manifest.artifact_dir ?? path.join(defaultArtifactRoot(), "corpus", manifest.job_id ?? "corpus-plan"));
  const workloadBlockers = validateCorpusManifestWorkload(manifest);
  const preflight = corpusPreflight(manifest, artifactDir);
  const runPlan =
    manifest.processor.type === "deepseek_batch"
      ? planManifest(buildDeepSeekRunManifestForPlan(manifest, artifactDir), { allowLive: Boolean(options.allowLive) })
      : null;
  const runBlockers = runPlan
    ? ((runPlan as { plan?: { blockers?: unknown } }).plan?.blockers as string[] | undefined) ?? []
    : [];
  const blockers = [...workloadBlockers, ...preflight.blockers, ...runBlockers.map((blocker) => `deepseek_plan:${blocker}`)];

  return {
    ok: blockers.length === 0,
    summary: {
      job_id: manifest.job_id ?? null,
      project: manifest.project,
      workload_type: manifest.workload_type,
      privacy_lane: manifest.privacy_lane,
      processor: manifest.processor.type,
      source_count: manifest.sources.length,
      shard_count: manifest.shards.length,
      artifact_dir: artifactDir
    },
    blockers,
    warnings: [
      ...preflight.warnings,
      ...(manifest.shards.length > manifest.max_shards_per_batch
        ? [`corpus_requires_multiple_batches:${manifest.shards.length}:${manifest.max_shards_per_batch}`]
        : [])
    ],
    tool_preflight: preflight.tools,
    storage: preflight.storage,
    deepseek_run_plan: runPlan
  };
}

export function corpusApprovalPacket(
  input: unknown,
  options: { output?: string } = {}
): Record<string, unknown> {
  const manifest = parseCorpusManifest(input);
  if (manifest.processor.type !== "deepseek_batch") {
    throw new HarnessError(
      "corpus_approval_packet_not_required",
      "Corpus approval packets are only required for deepseek_batch processors"
    );
  }
  assertShardInputsSafe(manifest);
  ensureShardSources(manifest);
  const sourceHashes = verifySourceIntegrity(manifest);
  verifyInlineShardIntegrity(manifest, sourceHashes);
  if (manifest.processor.transport === "deepseek" && !deepSeekCorpusFitsSingleBatch(manifest)) {
    throw new HarnessError(
      "corpus_live_requires_single_batch",
      "Live corpus jobs must fit one separately approved count-and-byte-bounded batch"
    );
  }
  const artifactDir = safeArtifactDir(
    manifest.artifact_dir ?? path.join(defaultArtifactRoot(), "corpus", manifest.job_id ?? "corpus-plan")
  );
  const runManifest = buildDeepSeekRunManifestForPlan(manifest, artifactDir);
  const packet = approvalPacket(runManifest);

  if (!options.output) {
    return { ok: true, packet };
  }

  const outputPath = safeArtifactFile(options.output, artifactDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeNoClobber(outputPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ok: true, path: outputPath, packet };
}

export function corpusResume(jobId: string, options: { artifactDir?: string } = {}): Record<string, unknown> {
  const artifactDir = resolveJobArtifactDir(jobId, options);
  return withCorpusWorkerLockSync(artifactDir, () => corpusResumeSync(jobId, options));
}

export async function corpusResumeAsync(
  jobId: string,
  options: { artifactDir?: string; allowLive?: boolean } = {}
): Promise<Record<string, unknown>> {
  const artifactDir = resolveJobArtifactDir(jobId, options);
  return withCorpusWorkerLock(artifactDir, () => corpusResumeUnlockedAsync(jobId, options));
}

async function corpusResumeUnlockedAsync(
  jobId: string,
  options: { artifactDir?: string; allowLive?: boolean } = {}
): Promise<Record<string, unknown>> {
  const ledger = readLedger(jobId, options);
  const manifest = parseCorpusManifest(JSON.parse(fs.readFileSync(ledger.manifest_path, "utf8")));
  if (manifest.processor.type !== "deepseek_batch") {
    return corpusResumeSync(jobId, options);
  }
  return processDeepSeekCorpusBatch(ledger, manifest, { allowLive: Boolean(options.allowLive) });
}

export async function corpusWorkAsync(
  jobId: string,
  options: { artifactDir?: string; allowLive?: boolean; maxIterations?: number; intervalMs?: number } = {}
): Promise<Record<string, unknown>> {
  const maxIterations = options.maxIterations ?? 100;
  const intervalMs = options.intervalMs ?? 0;
  if (!Number.isInteger(maxIterations) || maxIterations <= 0 || maxIterations > 10000) {
    throw new HarnessError("invalid_corpus_worker_iterations", "maxIterations must be an integer between 1 and 10000");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 3_600_000) {
    throw new HarnessError("invalid_corpus_worker_interval", "intervalMs must be an integer between 0 and 3600000");
  }

  let lastResult: Record<string, unknown> = {};
  const artifactDir = resolveJobArtifactDir(jobId, options);
  return withCorpusWorkerLock(artifactDir, async () => {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      lastResult = await corpusResumeUnlockedAsync(jobId, options);
      const summary = lastResult.summary as { status?: unknown } | undefined;
      if (summary?.status !== "running") {
        return { ...lastResult, worker: { iterations: iteration, terminal: true } };
      }
      if (intervalMs > 0 && iteration < maxIterations) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return { ...lastResult, worker: { iterations: maxIterations, terminal: false } };
  });
}

function corpusResumeSync(jobId: string, options: { artifactDir?: string } = {}): Record<string, unknown> {
  const ledger = readLedger(jobId, options);
  if (ledger.status === "cancelled") {
    return { ok: true, summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
  }
  const manifest = parseCorpusManifest(JSON.parse(fs.readFileSync(ledger.manifest_path, "utf8")));
  if (manifest.processor.type === "deepseek_batch") {
    throw new HarnessError("corpus_async_processor_required", "deepseek_batch corpus jobs must run through the async corpus path");
  }
  ensureShardSources(manifest);
  assertShardInputsSafe(manifest);
  const sourceHashes = verifySourceIntegrity(manifest);
  recoverCompletedShardProofs(ledger, manifest, sourceHashes);
  const shardsById = new Map(manifest.shards.map((shard) => [shard.id, shard]));
  const batchCap = ledger.max_shards_per_batch ?? manifest.max_shards_per_batch;
  let processed = 0;

  for (const ledgerShard of ledger.shards) {
    if (processed >= batchCap) {
      break;
    }
    if (ledgerShard.status === "succeeded" || ledgerShard.status === "cancelled" || ledgerShard.status === "invalidated") {
      continue;
    }
    if (ledgerShard.status === "quarantined") {
      continue;
    }
    if (ledgerShard.status === "failed" && !retryDue(ledgerShard)) {
      continue;
    }
    const shard = shardsById.get(ledgerShard.shard_id);
    if (!shard) {
      markShardFailed(ledgerShard, "shard_missing_from_manifest");
      writeShardCheckpoint(ledger, ledgerShard);
      continue;
    }
    if (ledgerShard.status === "failed" && ledgerShard.attempts >= ledger.max_retries) {
      ledgerShard.status = "quarantined";
      ledgerShard.next_retry_at = null;
      appendEvent(ledger.artifact_dir, "shard_quarantined", {
        shard_id: ledgerShard.shard_id,
        attempts: ledgerShard.attempts,
        error: ledgerShard.error
      });
      writeShardCheckpoint(ledger, ledgerShard);
      continue;
    }
    processCorpusShard(ledger, ledgerShard, shard, manifest.processor, sourceHashes.get(shard.source_id));
    processed += 1;
  }

  finaliseLedgerStatus(ledger);
  writeLedger(ledger);
  return { ok: ledger.status === "completed", summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
}

export function corpusValidate(jobId: string, options: { artifactDir?: string } = {}): Record<string, unknown> {
  const ledger = readLedger(jobId, options);
  const manifest = parseCorpusManifest(JSON.parse(fs.readFileSync(ledger.manifest_path, "utf8")));
  ensureShardSources(manifest);
  assertShardInputsSafe(manifest);
  const sourceHashes = verifySourceIntegrity(manifest);
  verifyInlineShardIntegrity(manifest, sourceHashes);
  const manifestShardIds = new Set(manifest.shards.map((shard) => shard.id));
  const ledgerShardIds = new Set(ledger.shards.map((shard) => shard.shard_id));
  const missingFromLedger = [...manifestShardIds].filter((id) => !ledgerShardIds.has(id));
  const extraInLedger = [...ledgerShardIds].filter((id) => !manifestShardIds.has(id));
  const duplicateManifestShards = duplicates(manifest.shards.map((shard) => shard.id));
  const duplicateLedgerShards = duplicates(ledger.shards.map((shard) => shard.shard_id));
  const missingOutputs = ledger.shards
    .filter((shard) => shard.status === "succeeded")
    .filter((shard) => !shard.output_path || !fs.existsSync(shard.output_path))
    .map((shard) => shard.shard_id);
  const missingProofs = ledger.shards
    .filter((shard) => shard.status === "succeeded")
    .filter((shard) => !shard.proof_path || !fs.existsSync(shard.proof_path))
    .map((shard) => shard.shard_id);
  const outputIntegrityBlockers: string[] = [];
  for (const shard of ledger.shards.filter((candidate) => candidate.status === "succeeded" && candidate.output_path)) {
    try {
      const outputPath = safeArtifactFile(shard.output_path as string, ledger.artifact_dir);
      if (!shard.output_sha256 || sha256File(outputPath) !== shard.output_sha256) {
        outputIntegrityBlockers.push(`output_hash_mismatch:${shard.shard_id}`);
      }
    } catch {
      outputIntegrityBlockers.push(`output_path_unsafe:${shard.shard_id}`);
    }
  }
  const proofIntegrityBlockers = validateSucceededShardProofs(manifest, ledger, sourceHashes);
  const failed = ledger.shards.filter((shard) => shard.status === "failed").map((shard) => shard.shard_id);
  const quarantined = ledger.shards.filter((shard) => shard.status === "quarantined").map((shard) => shard.shard_id);
  const pending = ledger.shards
    .filter((shard) => shard.status === "pending" || shard.status === "leased" || shard.status === "running")
    .map((shard) => shard.shard_id);
  const workloadBlockers = validateCorpusManifestWorkload(manifest, ledger);
  const translationQa = buildTranslationQa(manifest, ledger);
  const longformQa = buildLongformQa(manifest, ledger);
  const blockers = [
    ...missingFromLedger.map((id) => `missing_from_ledger:${id}`),
    ...extraInLedger.map((id) => `extra_in_ledger:${id}`),
    ...duplicateManifestShards.map((id) => `duplicate_manifest_shard:${id}`),
    ...duplicateLedgerShards.map((id) => `duplicate_ledger_shard:${id}`),
    ...missingOutputs.map((id) => `missing_output:${id}`),
    ...missingProofs.map((id) => `missing_proof:${id}`),
    ...outputIntegrityBlockers,
    ...proofIntegrityBlockers,
    ...failed.map((id) => `failed_shard:${id}`),
    ...quarantined.map((id) => `quarantined_shard:${id}`),
    ...pending.map((id) => `unfinished_shard:${id}`),
    ...workloadBlockers,
    ...translationQa.blockers,
    ...longformQa.blockers
  ];

  return {
    ok: blockers.length === 0,
    job_id: ledger.job_id,
    summary: summariseLedger(ledger),
    blockers,
    ...(translationQa.results.length > 0 ? { translation_qa: translationQa.results } : {}),
    ...(longformQa.results.length > 0 ? { longform_qa: longformQa.results } : {})
  };
}

function validateSucceededShardProofs(
  manifest: CorpusManifest,
  ledger: CorpusLedger,
  sourceHashes: Map<string, string>
): string[] {
  const blockers: string[] = [];
  const manifestShards = new Map(manifest.shards.map((shard) => [shard.id, shard]));
  for (const ledgerShard of ledger.shards) {
    if (ledgerShard.status !== "succeeded" || !ledgerShard.proof_path || !fs.existsSync(ledgerShard.proof_path)) {
      continue;
    }
    const fail = (reason: string): void => {
      blockers.push(`proof_${reason}:${ledgerShard.shard_id}`);
    };
    try {
      const proofPath = safeArtifactFile(ledgerShard.proof_path, ledger.artifact_dir);
      const proofStat = fs.statSync(proofPath);
      if (!proofStat.isFile() || proofStat.size > 1024 * 1024) {
        fail("invalid_file");
        continue;
      }
      let proof: Record<string, unknown>;
      try {
        proof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as Record<string, unknown>;
      } catch {
        fail("invalid_json");
        continue;
      }
      const manifestShard = manifestShards.get(ledgerShard.shard_id);
      if (!manifestShard) {
        fail("manifest_shard_missing");
        continue;
      }
      const expectedInputSha256 = ledgerShard.processor_version.startsWith("local_ocr.")
        ? sourceHashes.get(ledgerShard.source_id)
        : sha256Text(readShardInput(manifestShard));
      if (proof.schema_version !== "deepseek-harness.corpus-shard-proof.v1") {
        fail("schema_mismatch");
      }
      if (proof.job_id !== ledger.job_id) {
        fail("job_mismatch");
      }
      if (proof.shard_id !== ledgerShard.shard_id) {
        fail("shard_mismatch");
      }
      if (proof.source_id !== ledgerShard.source_id) {
        fail("source_mismatch");
      }
      if (proof.processor_version !== ledgerShard.processor_version) {
        fail("processor_mismatch");
      }
      if (
        typeof proof.processor_version !== "string" ||
        !proofProcessorMatchesManifest(manifest.processor, proof.processor_version, proof)
      ) {
        fail("processor_manifest_mismatch");
      }
      if (
        typeof proof.input_sha256 !== "string" ||
        proof.input_sha256 !== ledgerShard.input_sha256 ||
        proof.input_sha256 !== expectedInputSha256
      ) {
        fail("input_hash_mismatch");
      }
      if (
        typeof proof.output_sha256 !== "string" ||
        proof.output_sha256 !== ledgerShard.output_sha256
      ) {
        fail("output_hash_mismatch");
      }
      if (proof.committed_at !== ledgerShard.committed_at) {
        fail("commit_mismatch");
      }
      if (ledgerShard.processor_run_id && proof.processor_run_id !== ledgerShard.processor_run_id) {
        fail("processor_run_mismatch");
      }
    } catch {
      fail("path_unsafe");
    }
  }
  return blockers;
}

function buildLongformQa(
  manifest: CorpusManifest,
  ledger: CorpusLedger
): { blockers: string[]; results: Array<Record<string, unknown>> } {
  if (manifest.workload_type !== "longform_generation") {
    return { blockers: [], results: [] };
  }
  const acceptance = objectRecord(manifest.acceptance);
  const minimumWords = numberRecordValue(acceptance ?? {}, "minimum_words_per_section");
  if (!minimumWords || minimumWords <= 0) {
    return { blockers: [], results: [] };
  }
  const blockers: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  for (const ledgerShard of ledger.shards) {
    if (ledgerShard.status !== "succeeded" || !ledgerShard.output_path || !fs.existsSync(ledgerShard.output_path)) {
      continue;
    }
    let output: string;
    try {
      output = fs.readFileSync(safeArtifactFile(ledgerShard.output_path, ledger.artifact_dir), "utf8").trim();
    } catch {
      continue;
    }
    const wordCount = output.length === 0 ? 0 : output.split(/\s+/u).length;
    const shardBlockers = wordCount < minimumWords
      ? [`longform_qa:${ledgerShard.shard_id}:minimum_words_not_met:${wordCount}:${minimumWords}`]
      : [];
    blockers.push(...shardBlockers);
    results.push({
      shard_id: ledgerShard.shard_id,
      ok: shardBlockers.length === 0,
      blockers: shardBlockers,
      metrics: { word_count: wordCount, minimum_words: minimumWords }
    });
  }
  return { blockers, results };
}

function buildTranslationQa(
  manifest: CorpusManifest,
  ledger: CorpusLedger
): { blockers: string[]; results: Array<Record<string, unknown>> } {
  if (manifest.workload_type !== "translation") {
    return { blockers: [], results: [] };
  }
  const config = translationAcceptance(manifest);
  const shardsById = new Map(manifest.shards.map((shard) => [shard.id, shard]));
  const blockers: string[] = [];
  const results: Array<Record<string, unknown>> = [];

  for (const ledgerShard of ledger.shards) {
    if (ledgerShard.status !== "succeeded" || !ledgerShard.output_path || !fs.existsSync(ledgerShard.output_path)) {
      continue;
    }
    const shard = shardsById.get(ledgerShard.shard_id);
    if (!shard) {
      continue;
    }
    const bounds = shard.bounds ?? {};
    const sourceLang = stringRecordValue(bounds, "source_lang") ?? config?.sourceLang;
    const targetLang = stringRecordValue(bounds, "target_lang") ?? config?.targetLang;
    if (!sourceLang || !targetLang) {
      continue;
    }
    let outputText: string;
    try {
      outputText = fs.readFileSync(safeArtifactFile(ledgerShard.output_path, ledger.artifact_dir), "utf8");
    } catch {
      continue;
    }
    const qa = evaluateTranslationQa({
      sourceText: readShardInput(shard),
      outputText,
      sourceLang,
      targetLang,
      glossary: config?.glossary,
      minLengthRatio: config?.minLengthRatio,
      maxLengthRatio: config?.maxLengthRatio
    });
    const shardBlockers = qa.blockers.map((blocker) => `translation_qa:${ledgerShard.shard_id}:${blocker}`);
    blockers.push(...shardBlockers);
    results.push({
      shard_id: ledgerShard.shard_id,
      ok: qa.ok,
      blockers: shardBlockers,
      metrics: qa.metrics
    });
  }

  return { blockers, results };
}

export function corpusCommitTranslationMemory(
  jobId: string,
  options: { artifactDir?: string; reviewReceipt?: unknown } = {}
): Record<string, unknown> {
  const ledger = readLedger(jobId, options);
  return withCorpusWorkerLockSync(ledger.artifact_dir, () =>
    corpusCommitTranslationMemoryUnlocked(jobId, {
      ...options,
      artifactDir: ledger.artifact_dir
    })
  );
}

function corpusCommitTranslationMemoryUnlocked(
  jobId: string,
  options: { artifactDir?: string; reviewReceipt?: unknown }
): Record<string, unknown> {
  if (!options.reviewReceipt) {
    throw new HarnessError("translation_memory_review_required", "Translation-memory commits require an owner-signed review receipt");
  }
  const context = buildTranslationReviewContext(jobId, options);
  const reviewValidation = validateTranslationReviewReceipt(options.reviewReceipt, {
    expectedJobId: context.ledger.job_id,
    expectedProject: context.manifest.project,
    expectedReviewPayloadSha256: context.reviewPayloadSha256,
    publicKeyPem: process.env.DEEPSEEK_HARNESS_TRANSLATION_REVIEW_PUBLIC_KEY
  });
  if (!reviewValidation.ok) {
    throw new HarnessError("translation_memory_review_invalid", "Translation review receipt failed validation", {
      blockers: reviewValidation.blockers
    });
  }
  const reviewReceipt = parseTranslationReviewReceipt(options.reviewReceipt);
  if (!reviewValidation.receipt_sha256) {
    throw new HarnessError("translation_memory_review_invalid", "Translation review receipt digest is unavailable");
  }
  const reviewReceiptSha256 = reviewValidation.receipt_sha256;

  const memory = openTranslationMemory({
    dbPath: context.config.translationMemoryPath,
    allowedRoot: defaultArtifactRoot()
  });
  const shardsById = new Map(context.manifest.shards.map((shard) => [shard.id, shard]));
  const reviewedByShardId = new Map(context.reviewEntries.map((entry) => [entry.shard_id, entry]));
  try {
    const pendingEntries: Array<{ shardId: string; input: TranslationMemoryUpsertInput }> = [];
    for (const ledgerShard of context.ledger.shards) {
      if (ledgerShard.status !== "succeeded" || !ledgerShard.output_path) {
        continue;
      }
      const shard = shardsById.get(ledgerShard.shard_id);
      if (!shard) {
        continue;
      }
      const reviewed = reviewedByShardId.get(ledgerShard.shard_id);
      if (!reviewed) {
        throw new HarnessError(
          "translation_memory_review_content_changed",
          `Signed translation review is missing shard content: ${ledgerShard.shard_id}`
        );
      }
      const sourceText = readShardInput(shard);
      const targetText = fs.readFileSync(
        safeArtifactFile(ledgerShard.output_path, context.ledger.artifact_dir),
        "utf8"
      );
      if (sha256Text(sourceText) !== reviewed.source_sha256 || sha256Text(targetText) !== reviewed.target_sha256) {
        throw new HarnessError(
          "translation_memory_review_content_changed",
          `Translation content changed after owner review: ${ledgerShard.shard_id}`
        );
      }
      pendingEntries.push({
        shardId: ledgerShard.shard_id,
        input: {
          namespace: context.manifest.project,
          sourceText,
          targetText,
          sourceLang: reviewed.source_lang,
          targetLang: reviewed.target_lang,
          glossarySha256: reviewed.glossary_sha256
        }
      });
    }
    const committed = commitReviewedTranslationMemoryBatch(memory, {
      provenance: {
        receiptId: reviewReceipt.receipt_id,
        receiptSha256: reviewReceiptSha256,
        reviewer: reviewReceipt.reviewer,
        reviewPayloadSha256: context.reviewPayloadSha256
      },
      entries: pendingEntries.map((entry) => entry.input)
    });
    const entries = committed.map((result, index) => ({
      shard_id: pendingEntries[index]?.shardId,
      ...result
    }));
    const stats = translationMemoryStats(memory);
    appendEvent(context.ledger.artifact_dir, "translation_memory_committed", {
      job_id: context.ledger.job_id,
      entry_count: entries.length,
      memory_path: memory.dbPath,
      review_receipt_id: reviewReceipt.receipt_id,
      review_receipt_sha256: reviewReceiptSha256,
      reviewer: reviewReceipt.reviewer
    });
    return {
      ok: true,
      job_id: context.ledger.job_id,
      memory_path: memory.dbPath,
      namespace: context.manifest.project,
      review: {
        receipt_id: reviewReceipt.receipt_id,
        receipt_sha256: reviewReceiptSha256,
        reviewer: reviewReceipt.reviewer,
        review_payload_sha256: context.reviewPayloadSha256
      },
      entries,
      stats
    };
  } finally {
    memory.close();
  }
}

export function corpusTranslationReviewPacket(
  jobId: string,
  options: { artifactDir?: string } = {}
): Record<string, unknown> {
  const context = buildTranslationReviewContext(jobId, options);
  return {
    ok: true,
    packet: {
      schema_version: "deepseek-harness.translation-review-packet.v1",
      approval_status: "owner_signed_review_receipt_required",
      job_id: context.ledger.job_id,
      project: context.manifest.project,
      review_payload_sha256: context.reviewPayloadSha256,
      review_payload: context.reviewPayload,
      receipt_schema_version: "deepseek-harness.translation-review-receipt.v1",
      public_key_configured: Boolean(process.env.DEEPSEEK_HARNESS_TRANSLATION_REVIEW_PUBLIC_KEY)
    }
  };
}

interface TranslationReviewContext {
  ledger: CorpusLedger;
  manifest: CorpusManifest;
  config: TranslationAcceptanceConfig & { translationMemoryPath: string };
  reviewEntries: TranslationReviewEntry[];
  reviewPayload: Record<string, unknown>;
  reviewPayloadSha256: string;
}

interface TranslationReviewEntry {
  shard_id: string;
  source_sha256: string;
  target_sha256: string;
  source_lang: string;
  target_lang: string;
  glossary_sha256: string | null;
}

function buildTranslationReviewContext(
  jobId: string,
  options: { artifactDir?: string }
): TranslationReviewContext {
  const validation = corpusValidate(jobId, options) as { ok: boolean; blockers: string[] };
  if (!validation.ok) {
    throw new HarnessError("corpus_validation_failed", "Translation output must pass corpus validation before review", {
      blockers: validation.blockers
    });
  }
  const ledger = readLedger(jobId, options);
  const manifest = parseCorpusManifest(JSON.parse(fs.readFileSync(ledger.manifest_path, "utf8")));
  const config = translationAcceptance(manifest);
  if (manifest.workload_type !== "translation" || !config?.translationMemoryPath) {
    throw new HarnessError(
      "translation_memory_not_configured",
      "Translation manifest acceptance must configure translation_memory_path"
    );
  }
  const sourceHashes = verifySourceIntegrity(manifest);
  const shardsById = new Map(manifest.shards.map((shard) => [shard.id, shard]));
  const reviewEntries: TranslationReviewEntry[] = ledger.shards.map((ledgerShard) => {
    const shard = shardsById.get(ledgerShard.shard_id);
    if (!shard || !ledgerShard.output_path || !ledgerShard.output_sha256) {
      throw new HarnessError("translation_review_payload_incomplete", `Translation review payload is incomplete: ${ledgerShard.shard_id}`);
    }
    const sourceText = readShardInput(shard);
    verifyShardInputIntegrity(shard, sourceText, sourceHashes.get(shard.source_id), manifest.workload_type);
    const outputPath = safeArtifactFile(ledgerShard.output_path, ledger.artifact_dir);
    const targetSha256 = sha256File(outputPath);
    if (targetSha256 !== ledgerShard.output_sha256) {
      throw new HarnessError("translation_review_output_hash_mismatch", `Translation output changed after validation: ${ledgerShard.shard_id}`);
    }
    return {
      shard_id: ledgerShard.shard_id,
      source_sha256: sha256Text(sourceText),
      target_sha256: targetSha256,
      source_lang: stringRecordValue(shard.bounds ?? {}, "source_lang") ?? config.sourceLang,
      target_lang: stringRecordValue(shard.bounds ?? {}, "target_lang") ?? config.targetLang,
      glossary_sha256: config.glossarySha256
    };
  }).sort((left, right) => left.shard_id.localeCompare(right.shard_id));
  const memoryPath = path.isAbsolute(config.translationMemoryPath)
    ? path.resolve(config.translationMemoryPath)
    : path.resolve(defaultArtifactRoot(), config.translationMemoryPath);
  assertTranslationMemoryPathSafe(memoryPath);
  const reviewPayload = {
    schema_version: "deepseek-harness.translation-review-payload.v1",
    job_id: ledger.job_id,
    project: manifest.project,
    namespace: manifest.project,
    translation_memory_path: memoryPath,
    entries: reviewEntries
  };
  return {
    ledger,
    manifest,
    config: { ...config, translationMemoryPath: config.translationMemoryPath },
    reviewEntries,
    reviewPayload,
    reviewPayloadSha256: createHash("sha256").update(canonicalJson(reviewPayload), "utf8").digest("hex")
  };
}

function applyTranslationMemoryHits(
  ledger: CorpusLedger,
  manifest: CorpusManifest,
  shardsById: Map<string, CorpusShard>,
  candidates: CorpusLedgerShard[],
  sourceHashes: Map<string, string>
): CorpusLedgerShard[] {
  const config = translationAcceptance(manifest);
  if (manifest.workload_type !== "translation" || !config?.translationMemoryPath) {
    return candidates;
  }

  const memory = openTranslationMemory({
    dbPath: config.translationMemoryPath,
    allowedRoot: defaultArtifactRoot()
  });
  const remaining: CorpusLedgerShard[] = [];
  try {
    for (const ledgerShard of candidates) {
      const shard = shardsById.get(ledgerShard.shard_id);
      if (!shard) {
        remaining.push(ledgerShard);
        continue;
      }
      const sourceText = readShardInput(shard);
      verifyShardInputIntegrity(shard, sourceText, sourceHashes.get(shard.source_id), manifest.workload_type);
      const lookup = lookupTranslationMemory(memory, {
        namespace: manifest.project,
        sourceText,
        sourceLang: stringRecordValue(shard.bounds ?? {}, "source_lang") ?? config.sourceLang,
        targetLang: stringRecordValue(shard.bounds ?? {}, "target_lang") ?? config.targetLang,
        glossarySha256: config.glossarySha256
      });
      if (!lookup.hit) {
        remaining.push(ledgerShard);
        continue;
      }
      ledgerShard.input_sha256 = lookup.source_sha256;
      commitShardOutput(ledger, ledgerShard, lookup.target_text, "translation_memory.v1", {
        translation_memory_hit: true,
        translation_memory_target_sha256: lookup.target_sha256
      });
      appendEvent(ledger.artifact_dir, "translation_memory_hit", {
        shard_id: ledgerShard.shard_id,
        source_sha256: lookup.source_sha256,
        target_sha256: lookup.target_sha256
      });
    }
    if (remaining.length !== candidates.length) {
      writeLedger(ledger);
    }
    return remaining;
  } finally {
    memory.close();
  }
}

interface TranslationAcceptanceConfig {
  sourceLang: string;
  targetLang: string;
  glossary: Record<string, string>;
  glossarySha256: string | null;
  minLengthRatio: number;
  maxLengthRatio: number;
  translationMemoryPath?: string;
}

function translationAcceptance(manifest: CorpusManifest): TranslationAcceptanceConfig | undefined {
  const acceptance = objectRecord(manifest.acceptance);
  const translation = objectRecord(acceptance?.translation);
  if (!translation) {
    return undefined;
  }
  const sourceLang = stringRecordValue(translation, "source_lang");
  const targetLang = stringRecordValue(translation, "target_lang");
  if (!sourceLang || !targetLang) {
    return undefined;
  }
  const glossaryRecord = objectRecord(translation.glossary) ?? {};
  const glossary = Object.fromEntries(
    Object.entries(glossaryRecord).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const minLengthRatio = numberRecordValue(translation, "min_length_ratio") ?? 0.25;
  const maxLengthRatio = numberRecordValue(translation, "max_length_ratio") ?? 4;
  const glossarySha256 = stringRecordValue(translation, "glossary_sha256") ?? null;
  const translationMemoryPath = stringRecordValue(translation, "translation_memory_path");
  return {
    sourceLang,
    targetLang,
    glossary,
    glossarySha256,
    minLengthRatio,
    maxLengthRatio,
    ...(translationMemoryPath ? { translationMemoryPath } : {})
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberRecordValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function corpusReconcile(jobId: string, options: { artifactDir?: string; output?: string } = {}): Record<string, unknown> {
  const artifactDir = resolveJobArtifactDir(jobId, options);
  return withCorpusWorkerLockSync(artifactDir, () => corpusReconcileUnlocked(jobId, options));
}

function corpusReconcileUnlocked(jobId: string, options: { artifactDir?: string; output?: string } = {}): Record<string, unknown> {
  const validation = corpusValidate(jobId, options) as { ok: boolean; blockers: string[] };
  if (!validation.ok) {
    throw new HarnessError("corpus_validation_failed", "Corpus job cannot be reconciled until validation passes", {
      blockers: validation.blockers
    });
  }
  const ledger = readLedger(jobId, options);
  const outputPath = safeArtifactFile(options.output ?? path.join(ledger.artifact_dir, "reconciled.txt"), ledger.artifact_dir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const outputSha256 = writeReconciledOutputNoClobber(ledger, outputPath);
  appendEvent(ledger.artifact_dir, "job_reconciled", { job_id: jobId, output_path: outputPath, output_sha256: outputSha256 });
  return { ok: true, job_id: jobId, output_path: outputPath, output_sha256: outputSha256, summary: summariseLedger(ledger) };
}

export function corpusCancel(jobId: string, options: { artifactDir?: string } = {}): Record<string, unknown> {
  const artifactDir = resolveJobArtifactDir(jobId, options);
  return withCorpusWorkerLockSync(artifactDir, () => corpusCancelUnlocked(jobId, options));
}

function corpusCancelUnlocked(jobId: string, options: { artifactDir?: string } = {}): Record<string, unknown> {
  const ledger = readLedger(jobId, options);
  for (const shard of ledger.shards) {
    if (shard.status === "pending" || shard.status === "leased" || shard.status === "running") {
      shard.status = "cancelled";
      shard.lease_owner = null;
      shard.lease_expires_at = null;
      shard.finished_at = new Date().toISOString();
    }
  }
  ledger.status = "cancelled";
  ledger.updated_at = new Date().toISOString();
  writeLedger(ledger);
  appendEvent(ledger.artifact_dir, "job_cancelled", { job_id: jobId });
  return { ok: true, summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
}

function parseCorpusManifest(input: unknown): CorpusManifest {
  const parsed = corpusManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new HarnessError("invalid_corpus_manifest", "Corpus manifest failed validation", parsed.error.flatten());
  }
  return parsed.data;
}

function validateCorpusManifestWorkload(manifest: CorpusManifest, ledger?: CorpusLedger): string[] {
  return validateCorpusWorkload({
    workload_type: manifest.workload_type,
    processor: manifest.processor,
    sources: manifest.sources,
    shards: manifest.shards,
    acceptance: manifest.acceptance,
    ...(ledger
      ? {
          ledgerShards: ledger.shards.map((shard) => ({
            shard_id: shard.shard_id,
            bounds: shard.bounds,
            source_id: shard.source_id,
            output_path: shard.output_path,
            output_sha256: shard.output_sha256
          }))
        }
      : {})
  });
}

function assertCorpusWorkloadContract(manifest: CorpusManifest): void {
  if (manifest.workload_type !== "translation" && manifest.workload_type !== "media_catalogue") {
    return;
  }
  const blockers = validateCorpusManifestWorkload(manifest);
  if (blockers.length > 0) {
    throw new HarnessError("corpus_workload_contract_failed", "Corpus workload contract failed", { blockers });
  }
}

function ensureShardSources(manifest: CorpusManifest): void {
  const sourceIds = new Set(manifest.sources.map((source) => source.id));
  const missingSource = manifest.shards.find((shard) => !sourceIds.has(shard.source_id));
  if (missingSource) {
    throw new HarnessError("invalid_corpus_manifest", `Shard references unknown source: ${missingSource.source_id}`);
  }
  for (const shard of manifest.shards) {
    if (shard.inline_text && Buffer.byteLength(shard.inline_text, "utf8") > MAX_SHARD_INPUT_BYTES) {
      throw new HarnessError(
        "corpus_shard_too_large",
        `Inline corpus shard exceeds the ${MAX_SHARD_INPUT_BYTES}-byte processing cap: ${shard.id}`
      );
    }
    const source = manifest.sources.find((candidate) => candidate.id === shard.source_id);
    if (!source?.path || manifest.workload_type === "ocr") {
      continue;
    }
    const bounds = shard.bounds ?? {};
    const shardDigest =
      stringRecordValue(bounds, "shard_sha256") ??
      (manifest.workload_type === "media_catalogue" ? stringRecordValue(bounds, "sidecar_sha256") : undefined);
    if (!shardDigest) {
      throw new HarnessError(
        "corpus_shard_provenance_required",
        `File-backed corpus shard requires a declared shard digest: ${shard.id}`
      );
    }
  }
}

function assertShardInputsSafe(manifest: CorpusManifest): void {
  const sourceRoots = new Map<string, { root: string; exactFile: string | null }>();
  for (const source of manifest.sources) {
    if (!source.path) {
      continue;
    }
    const sourcePath = assertSafeCorpusSourcePath(source.path);
    assertNotForbiddenPath(sourcePath);
    assertNotSensitiveSourcePath(sourcePath);
    if (!fs.existsSync(sourcePath)) {
      throw new HarnessError("corpus_source_missing", `Corpus source path does not exist: ${source.id}`);
    }
    const realSourcePath = assertSafeCorpusSourcePath(fs.realpathSync(sourcePath));
    assertNotForbiddenPath(realSourcePath);
    assertNotSensitiveSourcePath(realSourcePath);
    const sourceStat = fs.statSync(realSourcePath);
    if (sourceStat.isFile() && !source.sha256) {
      throw new HarnessError("corpus_source_hash_required", `File-backed corpus source requires sha256: ${source.id}`);
    }
    sourceRoots.set(source.id, sourceStat.isFile()
      ? { root: path.dirname(realSourcePath), exactFile: realSourcePath }
      : { root: realSourcePath, exactFile: null });
  }

  for (const shard of manifest.shards) {
    if (!shard.input_path) {
      continue;
    }
    const inputPath = assertSafeCorpusSourcePath(shard.input_path);
    assertNotForbiddenPath(inputPath);
    assertNotSensitiveSourcePath(inputPath);
    const sourceBoundary = sourceRoots.get(shard.source_id);
    if (!sourceBoundary) {
      throw new HarnessError(
        "corpus_input_source_path_required",
        `Shard file input requires sources[].path for source: ${shard.source_id}`
      );
    }
    if (!fs.existsSync(inputPath)) {
      throw new HarnessError("corpus_shard_input_missing", `Shard input does not exist: ${shard.id}`);
    }
    const realInputPath = assertSafeCorpusSourcePath(fs.realpathSync(inputPath));
    assertNotForbiddenPath(realInputPath);
    assertNotSensitiveSourcePath(realInputPath);
    if (
      (sourceBoundary.exactFile && realInputPath !== sourceBoundary.exactFile) ||
      !isWithin(realInputPath, sourceBoundary.root)
    ) {
      throw new HarnessError("corpus_input_outside_source", `Shard input is outside declared source path: ${shard.id}`);
    }
  }
}

function verifySourceIntegrity(manifest: CorpusManifest): Map<string, string> {
  const verified = new Map<string, string>();
  for (const source of manifest.sources) {
    if (!source.path) {
      continue;
    }
    const sourcePath = path.resolve(source.path);
    if (!fs.existsSync(sourcePath)) {
      throw new HarnessError("corpus_source_missing", `Corpus source path does not exist: ${source.id}`);
    }
    const stats = fs.statSync(sourcePath);
    if (!stats.isFile()) {
      continue;
    }
    const actualSha256 = sha256File(sourcePath);
    if (source.sha256 && source.sha256 !== actualSha256) {
      throw new HarnessError("corpus_source_hash_mismatch", `Corpus source hash changed after manifest creation: ${source.id}`);
    }
    verified.set(source.id, actualSha256);
  }
  return verified;
}

function verifyInlineShardIntegrity(manifest: CorpusManifest, sourceHashes: Map<string, string>): void {
  for (const shard of manifest.shards) {
    if (!shard.inline_text) {
      continue;
    }
    verifyShardInputIntegrity(shard, shard.inline_text, sourceHashes.get(shard.source_id), manifest.workload_type);
  }
}

function verifyShardInputIntegrity(
  shard: CorpusShard,
  input: string,
  verifiedSourceSha256: string | undefined,
  workloadType: CorpusManifest["workload_type"]
): void {
  const bounds = shard.bounds ?? {};
  const expectedShardSha256 =
    stringRecordValue(bounds, "shard_sha256") ??
    (workloadType === "media_catalogue" ? stringRecordValue(bounds, "sidecar_sha256") : undefined);
  if (expectedShardSha256 && sha256Text(input) !== expectedShardSha256) {
    throw new HarnessError("corpus_shard_hash_mismatch", `Corpus shard content does not match declared provenance: ${shard.id}`);
  }
  const expectedSourceSha256 =
    stringRecordValue(bounds, "source_sha256") ??
    (workloadType === "media_catalogue" ? stringRecordValue(bounds, "sha256") : undefined);
  if (expectedSourceSha256 && verifiedSourceSha256 && expectedSourceSha256 !== verifiedSourceSha256) {
    throw new HarnessError("corpus_shard_source_hash_mismatch", `Corpus shard source provenance does not match its source: ${shard.id}`);
  }
}

function processCorpusShard(
  ledger: CorpusLedger,
  ledgerShard: CorpusLedgerShard,
  shard: CorpusShard,
  processor: CorpusManifest["processor"],
  verifiedSourceSha256?: string
): void {
  const now = new Date().toISOString();
  ledgerShard.status = "leased";
  ledgerShard.lease_owner = `pid:${process.pid}`;
  ledgerShard.lease_expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  ledgerShard.attempts += 1;
  ledgerShard.started_at = ledgerShard.started_at ?? now;
  ledger.updated_at = now;
  appendEvent(ledger.artifact_dir, "shard_leased", {
    shard_id: ledgerShard.shard_id,
    attempt: ledgerShard.attempts,
    lease_owner: ledgerShard.lease_owner,
    lease_expires_at: ledgerShard.lease_expires_at
  });

  try {
    ledgerShard.status = "running";
    appendEvent(ledger.artifact_dir, "shard_running", { shard_id: ledgerShard.shard_id, attempt: ledgerShard.attempts });
    if (processor.type === "local_ocr") {
      if (!shard.input_path) {
        throw new HarnessError("ocr_input_path_required", "local_ocr shards require input_path");
      }
      const result = extractOcrShard(shard.input_path, shard.bounds, processor);
      const observedSourceSha256 = sha256File(shard.input_path);
      if (verifiedSourceSha256 && observedSourceSha256 !== verifiedSourceSha256) {
        throw new HarnessError("corpus_source_changed_during_ocr", `Corpus source changed during OCR: ${shard.id}`);
      }
      ledgerShard.input_sha256 = observedSourceSha256;
      commitShardOutput(ledger, ledgerShard, result.text, `local_ocr.${result.engine}.v1`, {
        ocr_engine: result.engine,
        ocr_metadata: result.metadata
      });
    } else if (processor.type === "copy_text") {
      const input = readShardInput(shard);
      verifyShardInputIntegrity(shard, input, verifiedSourceSha256, ledger.workload_type);
      ledgerShard.input_sha256 = sha256Text(input);
      commitShardOutput(ledger, ledgerShard, input, "copy_text.v1");
    } else {
      throw new HarnessError("corpus_async_processor_required", "deepseek_batch corpus jobs must run through the async corpus path");
    }
  } catch (error) {
    markShardFailed(ledgerShard, error instanceof Error ? error.message : String(error), ledger.max_retries);
    appendEvent(ledger.artifact_dir, "shard_failed", { shard_id: ledgerShard.shard_id, error: ledgerShard.error });
  }
  ledger.updated_at = new Date().toISOString();
  writeShardCheckpoint(ledger, ledgerShard);
}

async function processDeepSeekCorpusBatch(
  ledger: CorpusLedger,
  manifest: CorpusManifest,
  options: { allowLive?: boolean }
): Promise<Record<string, unknown>> {
  const processor = manifest.processor;
  if (processor.type !== "deepseek_batch") {
    throw new HarnessError("corpus_processor_mismatch", "Expected deepseek_batch processor");
  }
  if (ledger.status === "cancelled") {
    return { ok: true, summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
  }
  if (processor.transport === "deepseek" && manifest.privacy_lane === "local_only") {
    throw new HarnessError("corpus_live_egress_blocked", "local_only corpus jobs cannot use live DeepSeek transport");
  }
  if (processor.transport === "deepseek" && manifest.privacy_lane === "redacted_external_allowed") {
    throw new HarnessError(
      "corpus_redaction_not_implemented",
      "redacted_external_allowed jobs cannot use live DeepSeek until a verified redaction processor is configured"
    );
  }
  if (processor.transport === "deepseek" && !deepSeekCorpusFitsSingleBatch(manifest)) {
    throw new HarnessError(
      "corpus_live_requires_single_batch",
      "Live corpus jobs must fit one separately approved count-and-byte-bounded batch"
    );
  }

  ensureShardSources(manifest);
  assertShardInputsSafe(manifest);
  const sourceHashes = verifySourceIntegrity(manifest);
  recoverCompletedShardProofs(ledger, manifest, sourceHashes);
  reconcileInterruptedProcessorRuns(ledger);
  if (
    processor.transport === "deepseek" &&
    processor.approval_receipt?.signature_base64 === "[signed-receipt-redacted]" &&
    ledger.shards.some((shard) => shard.status === "pending" || shard.status === "failed")
  ) {
    finaliseLedgerStatus(ledger);
    writeLedger(ledger);
    throw new HarnessError(
      "corpus_live_receipt_not_persisted",
      "Live corpus continuation requires a fresh separately approved job; signed authority is not persisted"
    );
  }
  const manifestShards = new Map(manifest.shards.map((shard) => [shard.id, shard]));
  const batchCap = ledger.max_shards_per_batch ?? manifest.max_shards_per_batch;
  const candidates = ledger.shards.filter((shard) => {
    if (shard.status === "succeeded" || shard.status === "cancelled" || shard.status === "quarantined" || shard.status === "invalidated") {
      return false;
    }
    if (shard.status === "failed" && !retryDue(shard)) {
      return false;
    }
    return shard.status !== "failed" || shard.attempts < ledger.max_retries;
  }).slice(0, batchCap);
  const runnable = applyTranslationMemoryHits(ledger, manifest, manifestShards, candidates, sourceHashes);

  if (runnable.length === 0) {
    finaliseLedgerStatus(ledger);
    writeLedger(ledger);
    return { ok: ledger.status === "completed", summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
  }

  const now = new Date().toISOString();
  const leaseOwner = `pid:${process.pid}`;
  const leaseExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const items: RunManifest["items"] = [];
  const selectedRunnable: CorpusLedgerShard[] = [];
  const batchByteCap = ledger.max_batch_input_bytes ?? manifest.max_batch_input_bytes;
  let batchInputBytes = 0;
  for (const ledgerShard of runnable) {
    const shard = manifestShards.get(ledgerShard.shard_id);
    if (!shard) {
      markShardFailed(ledgerShard, "shard_missing_from_manifest", ledger.max_retries);
      continue;
    }
    const input = readShardInput(shard);
    verifyShardInputIntegrity(shard, input, sourceHashes.get(shard.source_id), manifest.workload_type);
    const inputBytes = Buffer.byteLength(input, "utf8");
    if (inputBytes > batchByteCap) {
      ledgerShard.status = "quarantined";
      ledgerShard.error = `shard_input_exceeds_batch_byte_cap:${inputBytes}:${batchByteCap}`;
      ledgerShard.last_error_type = "invalid_input_size";
      ledgerShard.next_retry_at = null;
      ledgerShard.finished_at = new Date().toISOString();
      appendEvent(ledger.artifact_dir, "shard_quarantined", {
        shard_id: ledgerShard.shard_id,
        error: ledgerShard.error
      });
      continue;
    }
    const prompt = renderPrompt(processor.prompt_template, {
      text: input,
      shard_id: ledgerShard.shard_id,
      source_id: ledgerShard.source_id,
      bounds: JSON.stringify(ledgerShard.bounds ?? {})
    });
    const renderedBytes = Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(processor.system_prompt ?? "", "utf8");
    if (renderedBytes > batchByteCap) {
      ledgerShard.status = "quarantined";
      ledgerShard.error = `rendered_prompt_exceeds_batch_byte_cap:${renderedBytes}:${batchByteCap}`;
      ledgerShard.last_error_type = "invalid_input_size";
      ledgerShard.next_retry_at = null;
      ledgerShard.finished_at = new Date().toISOString();
      appendEvent(ledger.artifact_dir, "shard_quarantined", {
        shard_id: ledgerShard.shard_id,
        error: ledgerShard.error
      });
      continue;
    }
    if (items.length > 0 && batchInputBytes + renderedBytes > batchByteCap) {
      break;
    }
    batchInputBytes += renderedBytes;
    selectedRunnable.push(ledgerShard);
    ledgerShard.status = "running";
    ledgerShard.attempts += 1;
    ledgerShard.started_at = ledgerShard.started_at ?? now;
    ledgerShard.lease_owner = leaseOwner;
    ledgerShard.lease_expires_at = leaseExpiresAt;
    ledgerShard.input_sha256 = sha256Text(input);
    ledgerShard.processor_version = "deepseek_batch.v1";
    appendEvent(ledger.artifact_dir, "shard_running", {
      shard_id: ledgerShard.shard_id,
      attempt: ledgerShard.attempts,
      lease_owner: ledgerShard.lease_owner,
      lease_expires_at: ledgerShard.lease_expires_at
    });
    items.push({
      id: ledgerShard.shard_id,
      ...(processor.system_prompt
        ? { messages: [{ role: "system", content: processor.system_prompt }, { role: "user", content: prompt }] }
        : { prompt }),
      metadata: {
        corpus_job_id: ledger.job_id,
        source_id: ledgerShard.source_id,
        input_sha256: ledgerShard.input_sha256
      }
    });
  }
  writeLedger(ledger);

  if (items.length === 0) {
    finaliseLedgerStatus(ledger);
    writeLedger(ledger);
    return { ok: ledger.status === "completed", summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
  }

  const runId = `${ledger.job_id}-processor-${Date.now()}`;
  for (const ledgerShard of selectedRunnable) {
    ledgerShard.processor_run_id = runId;
  }
  appendEvent(ledger.artifact_dir, "processor_run_prepared", {
    processor_run_id: runId,
    shard_ids: selectedRunnable.map((shard) => shard.shard_id)
  });
  writeLedger(ledger);
  const runManifest: RunManifest = {
    schema_version: "deepseek-harness.run.v1",
    run_id: runId,
    project: `${manifest.project}-corpus`,
    description: `Corpus processor run for ${ledger.job_id}`,
    egress_class: manifest.privacy_lane === "local_only" ? "local_private" : "non_sensitive_bulk",
    transport: processor.transport,
    model: processor.model,
    thinking: processor.thinking,
    response_format: processor.response_format,
    concurrency: processor.concurrency,
    cost_cap_usd: processor.cost_cap_usd,
    max_tokens: processor.max_tokens,
    approval_receipt: processor.approval_receipt,
    artifact_dir: path.join(ledger.artifact_dir, "processor-runs", runId),
    canonical_writes: false,
    external_side_effects: false,
    workload_profile: `corpus:${manifest.workload_type}`,
    items
  };

  try {
    await submitManifest(runManifest, {}, { start: true, allowLive: Boolean(options.allowLive) });
    const results = getResults(runId) as { items?: Array<{ item_id: string; status: string; result: unknown; error: string | null }> };
    const resultsById = new Map((results.items ?? []).map((item) => [item.item_id, item]));
    for (const ledgerShard of selectedRunnable) {
      const result = resultsById.get(ledgerShard.shard_id);
      if (!result || result.status !== "completed") {
        markShardFailed(ledgerShard, result?.error ?? "processor_result_missing_or_failed", ledger.max_retries);
        appendEvent(ledger.artifact_dir, "shard_failed", { shard_id: ledgerShard.shard_id, error: ledgerShard.error });
        continue;
      }
      commitShardOutput(ledger, ledgerShard, resultContent(result.result), "deepseek_batch.v1", {
        processor_run_id: runId,
        processor_item_id: ledgerShard.shard_id
      });
    }
  } catch (error) {
    for (const ledgerShard of selectedRunnable) {
      if (ledgerShard.status === "succeeded") {
        continue;
      }
      markShardFailed(ledgerShard, error instanceof Error ? error.message : String(error), ledger.max_retries);
      appendEvent(ledger.artifact_dir, "shard_failed", { shard_id: ledgerShard.shard_id, error: ledgerShard.error });
    }
  }

  for (const ledgerShard of ledger.shards) {
    if (ledgerShard.status === "failed" && ledgerShard.attempts >= ledger.max_retries) {
      ledgerShard.status = "quarantined";
      ledgerShard.next_retry_at = null;
      appendEvent(ledger.artifact_dir, "shard_quarantined", {
        shard_id: ledgerShard.shard_id,
        attempts: ledgerShard.attempts,
        error: ledgerShard.error
      });
    }
  }
  finaliseLedgerStatus(ledger);
  writeLedger(ledger);
  return { ok: ledger.status === "completed", summary: summariseLedger(ledger), ledger_path: ledgerPath(ledger.artifact_dir) };
}

function deepSeekCorpusFitsSingleBatch(manifest: CorpusManifest): boolean {
  if (manifest.processor.type !== "deepseek_batch") {
    return true;
  }
  if (manifest.shards.length > manifest.max_shards_per_batch) {
    return false;
  }
  let totalBytes = 0;
  for (const shard of manifest.shards) {
    const input = readShardInput(shard);
    const prompt = renderPrompt(manifest.processor.prompt_template, {
      text: input,
      shard_id: shard.id,
      source_id: shard.source_id,
      bounds: JSON.stringify(shard.bounds ?? {})
    });
    const renderedBytes = Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(manifest.processor.system_prompt ?? "", "utf8");
    if (renderedBytes > manifest.max_batch_input_bytes) {
      return false;
    }
    totalBytes += renderedBytes;
    if (totalBytes > manifest.max_batch_input_bytes) {
      return false;
    }
  }
  return true;
}

function reconcileInterruptedProcessorRuns(ledger: CorpusLedger): void {
  const interrupted = ledger.shards.filter(
    (shard) => shard.status === "running" && typeof shard.processor_run_id === "string" && shard.processor_run_id.length > 0
  );
  const runIds = [...new Set(interrupted.map((shard) => shard.processor_run_id as string))];
  for (const runId of runIds) {
    let resultsById = new Map<string, { item_id: string; status: string; result: unknown; error: string | null }>();
    try {
      const results = getResults(runId) as {
        items?: Array<{ item_id: string; status: string; result: unknown; error: string | null }>;
      };
      resultsById = new Map((results.items ?? []).map((item) => [item.item_id, item]));
    } catch {
    }

    for (const ledgerShard of interrupted.filter((shard) => shard.processor_run_id === runId)) {
      const result = resultsById.get(ledgerShard.shard_id);
      if (result?.status === "completed") {
        commitShardOutput(ledger, ledgerShard, resultContent(result.result), "deepseek_batch.v1", {
          processor_run_id: runId,
          processor_item_id: ledgerShard.shard_id,
          recovered_after_interruption: true
        });
        continue;
      }
      ledgerShard.status = "quarantined";
      ledgerShard.error = result?.error ?? "processor_run_interrupted_manual_recovery_required";
      ledgerShard.last_error_type = "interrupted_processor_run";
      ledgerShard.lease_owner = null;
      ledgerShard.lease_expires_at = null;
      ledgerShard.next_retry_at = null;
      ledgerShard.finished_at = new Date().toISOString();
      appendEvent(ledger.artifact_dir, "shard_quarantined", {
        shard_id: ledgerShard.shard_id,
        processor_run_id: runId,
        error: ledgerShard.error
      });
    }
  }
}

function buildDeepSeekRunManifestForPlan(manifest: CorpusManifest, artifactDir: string): RunManifest {
  const processor = manifest.processor;
  if (processor.type !== "deepseek_batch") {
    throw new HarnessError("corpus_processor_mismatch", "Expected deepseek_batch processor");
  }
  const runId = `${manifest.job_id ?? "corpus-plan"}-processor-plan`;
  const items: RunManifest["items"] = [];
  let batchInputBytes = 0;
  for (const shard of manifest.shards.slice(0, manifest.max_shards_per_batch)) {
    const input = readShardInput(shard);
    verifyShardInputIntegrity(
      shard,
      input,
      manifest.sources.find((source) => source.id === shard.source_id)?.sha256,
      manifest.workload_type
    );
    const inputBytes = Buffer.byteLength(input, "utf8");
    if (inputBytes > manifest.max_batch_input_bytes) {
      throw new HarnessError(
        "corpus_shard_exceeds_batch_byte_cap",
        `Corpus shard exceeds max_batch_input_bytes: ${shard.id}`
      );
    }
    const prompt = renderPrompt(processor.prompt_template, {
      text: input,
      shard_id: shard.id,
      source_id: shard.source_id,
      bounds: JSON.stringify(shard.bounds ?? {})
    });
    const renderedBytes = Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(processor.system_prompt ?? "", "utf8");
    if (renderedBytes > manifest.max_batch_input_bytes) {
      throw new HarnessError(
        "corpus_shard_exceeds_batch_byte_cap",
        `Rendered corpus prompt exceeds max_batch_input_bytes: ${shard.id}`
      );
    }
    if (items.length > 0 && batchInputBytes + renderedBytes > manifest.max_batch_input_bytes) {
      break;
    }
    batchInputBytes += renderedBytes;
    items.push({
      id: shard.id,
      ...(processor.system_prompt
        ? { messages: [{ role: "system" as const, content: processor.system_prompt }, { role: "user" as const, content: prompt }] }
        : { prompt }),
      metadata: {
        corpus_source_id: shard.source_id,
        input_sha256: sha256Text(input)
      }
    });
  }
  return {
    schema_version: "deepseek-harness.run.v1",
    run_id: runId,
    project: `${manifest.project}-corpus`,
    description: `Corpus processor plan for ${manifest.job_id ?? manifest.project}`,
    egress_class: manifest.privacy_lane === "local_only" ? "local_private" : "non_sensitive_bulk",
    transport: processor.transport,
    model: processor.model,
    thinking: processor.thinking,
    response_format: processor.response_format,
    concurrency: processor.concurrency,
    cost_cap_usd: processor.cost_cap_usd,
    max_tokens: processor.max_tokens,
    approval_receipt: processor.approval_receipt,
    artifact_dir: path.join(artifactDir, "processor-runs", runId),
    canonical_writes: false,
    external_side_effects: false,
    workload_profile: `corpus:${manifest.workload_type}`,
    items
  };
}

function commitShardOutput(
  ledger: CorpusLedger,
  ledgerShard: CorpusLedgerShard,
  output: string,
  processorVersion: string,
  extraProof: Record<string, unknown> = {}
): void {
  const outputPath = safeArtifactFile(
    path.join(ledger.artifact_dir, "outputs", `${safeFileName(ledgerShard.shard_id)}.txt`),
    ledger.artifact_dir
  );
  const proofPath = safeArtifactFile(
    path.join(ledger.artifact_dir, "proof", `${safeFileName(ledgerShard.shard_id)}.json`),
    ledger.artifact_dir
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  writeShardArtifactNoClobber(ledger, ledgerShard, outputPath, output, "output");
  ledgerShard.output_path = outputPath;
  ledgerShard.output_sha256 = sha256Text(output);
  ledgerShard.proof_path = proofPath;
  ledgerShard.processor_version = processorVersion;
  ledgerShard.status = "succeeded";
  ledgerShard.lease_owner = null;
  ledgerShard.lease_expires_at = null;
  ledgerShard.error = null;
  ledgerShard.last_error_type = null;
  ledgerShard.next_retry_at = null;
  ledgerShard.finished_at = new Date().toISOString();
  ledgerShard.committed_at = ledgerShard.finished_at;
  const proof = JSON.stringify(
    {
      schema_version: "deepseek-harness.corpus-shard-proof.v1",
      job_id: ledger.job_id,
      shard_id: ledgerShard.shard_id,
      source_id: ledgerShard.source_id,
      processor_version: ledgerShard.processor_version,
      input_sha256: ledgerShard.input_sha256,
      output_sha256: ledgerShard.output_sha256,
      committed_at: ledgerShard.committed_at,
      ...extraProof
    },
    null,
    2
  );
  writeShardArtifactNoClobber(ledger, ledgerShard, proofPath, proof, "proof");
  writeShardCheckpoint(ledger, ledgerShard);
  appendEvent(ledger.artifact_dir, "shard_succeeded", { shard_id: ledgerShard.shard_id, output_sha256: ledgerShard.output_sha256 });
}

function readShardInput(shard: CorpusShard): string {
  if (shard.inline_text) {
    return shard.inline_text;
  }
  if (!shard.input_path) {
    throw new HarnessError("corpus_shard_input_missing", `Shard input missing: ${shard.id}`);
  }
  const inputPath = path.resolve(shard.input_path);
  const byteStart = numberRecordValue(shard.bounds ?? {}, "byte_start");
  const byteEnd = numberRecordValue(shard.bounds ?? {}, "byte_end");
  if (byteStart === undefined && byteEnd === undefined) {
    const stat = fs.statSync(inputPath);
    if (!stat.isFile()) {
      throw new HarnessError("corpus_shard_input_not_file", `Shard input is not a regular file: ${shard.id}`);
    }
    if (stat.size > MAX_SHARD_INPUT_BYTES) {
      throw new HarnessError("corpus_shard_too_large", `Shard input exceeds the 64 MiB processing cap: ${shard.id}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(inputPath));
    } catch {
      throw new HarnessError("invalid_corpus_utf8", `Shard input is not valid UTF-8: ${shard.id}`);
    }
  }
  if (
    !Number.isInteger(byteStart) ||
    !Number.isInteger(byteEnd) ||
    byteStart === undefined ||
    byteEnd === undefined ||
    byteStart < 0 ||
    byteEnd <= byteStart
  ) {
    throw new HarnessError("invalid_corpus_byte_range", `Shard byte range is invalid: ${shard.id}`);
  }
  const byteLength = byteEnd - byteStart;
  if (byteLength > MAX_SHARD_INPUT_BYTES) {
    throw new HarnessError("corpus_shard_too_large", `Shard byte range exceeds the 64 MiB processing cap: ${shard.id}`);
  }
  const stat = fs.statSync(inputPath);
  if (byteEnd > stat.size) {
    throw new HarnessError("invalid_corpus_byte_range", `Shard byte range exceeds its source file: ${shard.id}`);
  }
  const buffer = Buffer.allocUnsafe(byteLength);
  const fd = fs.openSync(inputPath, "r");
  try {
    let offset = 0;
    while (offset < byteLength) {
      const bytesRead = fs.readSync(fd, buffer, offset, byteLength - offset, byteStart + offset);
      if (bytesRead === 0) {
        throw new HarnessError("corpus_shard_read_incomplete", `Shard byte range could not be read fully: ${shard.id}`);
      }
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new HarnessError("invalid_corpus_utf8", `Shard byte range is not valid UTF-8: ${shard.id}`);
  }
}

function markShardFailed(shard: CorpusLedgerShard, error: string, maxRetries = 0): void {
  shard.status = "failed";
  shard.error = error;
  shard.last_error_type = classifyError(error);
  shard.lease_owner = null;
  shard.lease_expires_at = null;
  shard.next_retry_at = shard.attempts < maxRetries ? new Date(Date.now() + 30_000 * Math.max(1, shard.attempts)).toISOString() : null;
  shard.finished_at = new Date().toISOString();
}

function finaliseLedgerStatus(ledger: CorpusLedger): void {
  const failed = ledger.shards.some((shard) => shard.status === "failed" && shard.attempts >= ledger.max_retries);
  const retryableFailed = ledger.shards.some((shard) => shard.status === "failed" && shard.attempts < ledger.max_retries);
  const quarantined = ledger.shards.some((shard) => shard.status === "quarantined");
  const unfinished = ledger.shards.some((shard) => shard.status === "pending" || shard.status === "leased" || shard.status === "running");
  ledger.status = failed || quarantined ? "failed" : unfinished || retryableFailed ? "running" : "completed";
  ledger.updated_at = new Date().toISOString();
  appendEvent(ledger.artifact_dir, `job_${ledger.status}`, { job_id: ledger.job_id });
}

function readLedger(jobId: string, options: { artifactDir?: string }): CorpusLedger {
  const candidateDir = options.artifactDir ? safeArtifactDir(options.artifactDir) : safeArtifactDir(path.join(defaultArtifactRoot(), "corpus", jobId));
  const filePath = safeArtifactFile(ledgerPath(candidateDir), candidateDir);
  if (!fs.existsSync(filePath)) {
    throw new HarnessError("corpus_job_not_found", `Corpus job not found: ${jobId}`);
  }
  const ledger = JSON.parse(fs.readFileSync(filePath, "utf8")) as CorpusLedger;
  if (ledger.job_id !== jobId) {
    throw new HarnessError("corpus_job_mismatch", `Ledger job_id does not match requested job: ${jobId}`);
  }
  if (path.resolve(ledger.artifact_dir) !== candidateDir) {
    throw new HarnessError("corpus_job_mismatch", `Ledger artifact_dir does not match requested job directory: ${jobId}`);
  }
  ledger.manifest_path = safeArtifactFile(ledger.manifest_path, candidateDir);
  applyShardCheckpoints(ledger);
  return ledger;
}

function writeShardCheckpoint(ledger: CorpusLedger, shard: CorpusLedgerShard): void {
  const artifactDir = safeArtifactDir(ledger.artifact_dir);
  const directory = safeArtifactFile(path.join(artifactDir, "shard-checkpoints"), artifactDir);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = safeArtifactFile(path.join(directory, `${safeFileName(shard.shard_id)}.json`), artifactDir);
  const tmpPath = safeArtifactFile(`${filePath}.${randomUUID()}.tmp`, artifactDir);
  const body = JSON.stringify({
    schema_version: "deepseek-harness.corpus-shard-checkpoint.v1",
    job_id: ledger.job_id,
    shard_id: shard.shard_id,
    shard
  });
  const fd = fs.openSync(tmpPath, "wx");
  try {
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  fsyncDirectory(directory);
}

function applyShardCheckpoints(ledger: CorpusLedger): void {
  const directory = path.join(ledger.artifact_dir, "shard-checkpoints");
  if (!fs.existsSync(directory)) {
    return;
  }
  const safeDirectory = safeArtifactFile(directory, ledger.artifact_dir);
  const directoryStat = fs.lstatSync(safeDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new HarnessError("corpus_checkpoint_invalid", "Corpus shard checkpoint path must be a regular directory");
  }
  const files = fs.readdirSync(safeDirectory).filter((file) => file.endsWith(".json")).sort();
  if (files.length > ledger.shards.length) {
    throw new HarnessError("corpus_checkpoint_invalid", "Corpus shard checkpoint count exceeds ledger shard count");
  }
  const shardsById = new Map(ledger.shards.map((shard) => [shard.shard_id, shard]));
  for (const file of files) {
    const filePath = safeArtifactFile(path.join(safeDirectory, file), ledger.artifact_dir);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 256 * 1024) {
      throw new HarnessError("corpus_checkpoint_invalid", `Corpus shard checkpoint is invalid: ${file}`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new HarnessError("corpus_checkpoint_invalid", `Corpus shard checkpoint is not valid JSON: ${file}`);
    }
    const checkpointShard = objectRecord(parsed.shard) as unknown as CorpusLedgerShard | undefined;
    const shardId = typeof parsed.shard_id === "string" ? parsed.shard_id : "";
    const ledgerShard = shardsById.get(shardId);
    if (
      parsed.schema_version !== "deepseek-harness.corpus-shard-checkpoint.v1" ||
      parsed.job_id !== ledger.job_id ||
      !ledgerShard ||
      !checkpointShard ||
      checkpointShard.shard_id !== ledgerShard.shard_id ||
      checkpointShard.source_id !== ledgerShard.source_id ||
      !isCorpusShardStatus(checkpointShard.status) ||
      !Number.isInteger(checkpointShard.attempts) ||
      checkpointShard.attempts < 0
    ) {
      throw new HarnessError("corpus_checkpoint_invalid", `Corpus shard checkpoint does not match its ledger: ${file}`);
    }
    if (checkpointShard.output_path) {
      checkpointShard.output_path = safeArtifactFile(checkpointShard.output_path, ledger.artifact_dir);
    }
    if (checkpointShard.proof_path) {
      checkpointShard.proof_path = safeArtifactFile(checkpointShard.proof_path, ledger.artifact_dir);
    }
    Object.assign(ledgerShard, checkpointShard);
  }
}

function recoverCompletedShardProofs(
  ledger: CorpusLedger,
  manifest: CorpusManifest,
  sourceHashes: Map<string, string>
): void {
  const manifestShards = new Map(manifest.shards.map((shard) => [shard.id, shard]));
  for (const shard of ledger.shards) {
    if (["succeeded", "cancelled", "quarantined", "invalidated"].includes(shard.status)) {
      continue;
    }
    const outputPath = safeArtifactFile(
      path.join(ledger.artifact_dir, "outputs", `${safeFileName(shard.shard_id)}.txt`),
      ledger.artifact_dir
    );
    const proofPath = safeArtifactFile(
      path.join(ledger.artifact_dir, "proof", `${safeFileName(shard.shard_id)}.json`),
      ledger.artifact_dir
    );
    if (!fs.existsSync(outputPath) || !fs.existsSync(proofPath)) {
      continue;
    }
    const proofStat = fs.statSync(proofPath);
    if (!proofStat.isFile() || proofStat.size > 1024 * 1024) {
      throw new HarnessError("corpus_shard_proof_invalid", `Corpus shard proof is invalid: ${shard.shard_id}`);
    }
    const proofBody = fs.readFileSync(proofPath, "utf8");
    let proof: Record<string, unknown>;
    try {
      proof = JSON.parse(proofBody) as Record<string, unknown>;
    } catch {
      if (looksLikeInterruptedShardProof(proofBody, ledger, shard)) {
        continue;
      }
      throw new HarnessError("corpus_shard_proof_invalid", `Corpus shard proof is not valid JSON: ${shard.shard_id}`);
    }
    const outputSha256 = typeof proof.output_sha256 === "string" ? proof.output_sha256 : "";
    const processorVersion = typeof proof.processor_version === "string" ? proof.processor_version : "";
    const committedAt = typeof proof.committed_at === "string" ? proof.committed_at : "";
    const manifestShard = manifestShards.get(shard.shard_id);
    if (!manifestShard) {
      throw new HarnessError("corpus_shard_proof_invalid", `Corpus shard proof has no manifest shard: ${shard.shard_id}`);
    }
    if (!proofProcessorMatchesManifest(manifest.processor, processorVersion, proof)) {
      throw new HarnessError(
        "corpus_shard_proof_invalid",
        `Corpus shard proof processor does not match manifest processor: ${shard.shard_id}`
      );
    }
    const expectedInputSha256 = processorVersion.startsWith("local_ocr.")
      ? sourceHashes.get(shard.source_id)
      : sha256Text(readShardInput(manifestShard));
    if (
      proof.schema_version !== "deepseek-harness.corpus-shard-proof.v1" ||
      proof.job_id !== ledger.job_id ||
      proof.shard_id !== shard.shard_id ||
      proof.source_id !== shard.source_id ||
      !/^[a-f0-9]{64}$/.test(outputSha256) ||
      !processorVersion ||
      !Number.isFinite(Date.parse(committedAt)) ||
      typeof proof.input_sha256 !== "string" ||
      proof.input_sha256 !== expectedInputSha256 ||
      sha256File(outputPath) !== outputSha256
    ) {
      throw new HarnessError("corpus_shard_proof_invalid", `Corpus shard proof does not match its output: ${shard.shard_id}`);
    }
    shard.status = "succeeded";
    shard.input_sha256 = typeof proof.input_sha256 === "string" ? proof.input_sha256 : null;
    shard.output_path = outputPath;
    shard.output_sha256 = outputSha256;
    shard.proof_path = proofPath;
    shard.processor_version = processorVersion;
    shard.processor_run_id = typeof proof.processor_run_id === "string" ? proof.processor_run_id : shard.processor_run_id;
    shard.error = null;
    shard.last_error_type = null;
    shard.next_retry_at = null;
    shard.lease_owner = null;
    shard.lease_expires_at = null;
    shard.finished_at = committedAt;
    shard.committed_at = committedAt;
  }
}

function proofProcessorMatchesManifest(
  processor: CorpusManifest["processor"],
  processorVersion: string,
  proof: Record<string, unknown>
): boolean {
  if (processor.type === "copy_text") {
    return processorVersion === "copy_text.v1";
  }
  if (processor.type === "local_ocr") {
    const match = /^local_ocr\.(macos_vision|focr|tesseract)\.v1$/.exec(processorVersion);
    return Boolean(match) && (processor.engine === "auto" || match?.[1] === processor.engine);
  }
  return processorVersion === "deepseek_batch.v1" || (
    processorVersion === "translation_memory.v1" && proof.translation_memory_hit === true
  );
}

function looksLikeInterruptedShardProof(
  body: string,
  ledger: CorpusLedger,
  shard: CorpusLedgerShard
): boolean {
  if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
    return false;
  }
  const identityPrefix = [
    "{",
    `  "schema_version": ${JSON.stringify("deepseek-harness.corpus-shard-proof.v1")},`,
    `  "job_id": ${JSON.stringify(ledger.job_id)},`,
    `  "shard_id": ${JSON.stringify(shard.shard_id)},`,
    `  "source_id": ${JSON.stringify(shard.source_id)},`
  ].join("\n");
  return identityPrefix.startsWith(body) || body.startsWith(identityPrefix);
}

function isCorpusShardStatus(value: unknown): value is CorpusShardStatus {
  return typeof value === "string" && [
    "pending",
    "leased",
    "running",
    "succeeded",
    "failed",
    "quarantined",
    "cancelled",
    "invalidated"
  ].includes(value);
}

function clearShardCheckpoints(artifactDir: string): void {
  const directory = path.join(artifactDir, "shard-checkpoints");
  if (!fs.existsSync(directory)) {
    return;
  }
  const safeDirectory = safeArtifactFile(directory, artifactDir);
  const stat = fs.lstatSync(safeDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HarnessError("corpus_checkpoint_invalid", "Corpus shard checkpoint path must be a regular directory");
  }
  fs.rmSync(safeDirectory, { recursive: true });
}

function writeLedger(ledger: CorpusLedger): void {
  const artifactDir = safeArtifactDir(ledger.artifact_dir);
  fs.mkdirSync(ledger.artifact_dir, { recursive: true });
  const filePath = safeArtifactFile(ledgerPath(artifactDir), artifactDir);
  const tmpPath = safeArtifactFile(`${filePath}.${randomUUID()}.tmp`, artifactDir);
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2), { flag: "wx" });
  fs.renameSync(tmpPath, filePath);
  clearShardCheckpoints(ledger.artifact_dir);
}

function ledgerPath(artifactDir: string): string {
  return path.join(artifactDir, "ledger.json");
}

function appendEvent(artifactDir: string, type: string, payload: Record<string, unknown>): void {
  const safeDir = safeArtifactDir(artifactDir);
  fs.mkdirSync(artifactDir, { recursive: true });
  const eventPath = safeArtifactFile(path.join(safeDir, "events.jsonl"), safeDir);
  fs.appendFileSync(
    eventPath,
    `${JSON.stringify({ ts: new Date().toISOString(), type, payload })}\n`
  );
}

function summariseLedger(ledger: CorpusLedger): Record<string, unknown> {
  const counts = ledger.shards.reduce<Record<CorpusShardStatus, number>>(
    (acc, shard) => {
      acc[shard.status] += 1;
      return acc;
    },
    { pending: 0, leased: 0, running: 0, succeeded: 0, failed: 0, quarantined: 0, cancelled: 0, invalidated: 0 }
  );
  return {
    job_id: ledger.job_id,
    project: ledger.project,
    workload_type: ledger.workload_type,
    privacy_lane: ledger.privacy_lane,
    status: ledger.status,
    artifact_dir: ledger.artifact_dir,
    shard_count: ledger.shards.length,
    counts,
    updated_at: ledger.updated_at
  };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicate.add(value);
    }
    seen.add(value);
  }
  return [...duplicate];
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function resultContent(result: unknown): string {
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
  }
  return JSON.stringify(result);
}

function corpusPreflight(
  manifest: CorpusManifest,
  artifactDir: string
): {
  blockers: string[];
  warnings: string[];
  tools: Record<string, { present: boolean; required: boolean }>;
  storage: Record<string, unknown>;
} {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const requiredTools = toolsForManifest(manifest);
  const tools: Record<string, { present: boolean; required: boolean }> = {};
  for (const tool of requiredTools.required) {
    const present = commandAvailable(tool);
    tools[tool] = { present, required: true };
    if (!present) {
      blockers.push(`missing_required_tool:${tool}`);
    }
  }
  for (const tool of requiredTools.optional) {
    if (tools[tool]) {
      continue;
    }
    const present = commandAvailable(tool);
    tools[tool] = { present, required: false };
    if (!present) {
      warnings.push(`missing_optional_tool:${tool}`);
    }
  }

  if (manifest.processor.type === "local_ocr" && manifest.processor.engine === "auto") {
    const selected = tools.focr?.present
      ? "focr"
      : tools.tesseract?.present
        ? "tesseract"
        : process.platform === "darwin" && tools.swiftc?.present
          ? "macos_vision"
          : null;
    if (!selected) {
      blockers.push("no_local_ocr_engine_available");
    } else if (selected === "tesseract" && manifest.sources.some((source) => source.type === "pdf") && !tools.pdftoppm?.present) {
      blockers.push("missing_required_tool:pdftoppm");
      tools.pdftoppm = { present: false, required: true };
    }
  } else if (
    manifest.processor.type === "local_ocr" &&
    manifest.processor.engine === "macos_vision" &&
    process.platform !== "darwin"
  ) {
    blockers.push("macos_vision_requires_macos");
  }

  const translationConfig = translationAcceptance(manifest);
  if (translationConfig?.translationMemoryPath) {
    const memoryPath = path.isAbsolute(translationConfig.translationMemoryPath)
      ? path.resolve(translationConfig.translationMemoryPath)
      : path.resolve(defaultArtifactRoot(), translationConfig.translationMemoryPath);
    try {
      assertNotForbiddenPath(memoryPath);
      if (!isWithin(memoryPath, path.resolve(defaultArtifactRoot()))) {
        blockers.push("translation_memory_path_outside_artifact_root");
      }
    } catch {
      blockers.push("translation_memory_path_forbidden");
    }
  }

  if (manifest.processor.type === "deepseek_batch" && manifest.processor.transport === "deepseek") {
    if (manifest.privacy_lane === "local_only") {
      blockers.push("live_deepseek_blocked_for_local_only_privacy_lane");
    }
    if (manifest.privacy_lane === "redacted_external_allowed") {
      blockers.push("live_deepseek_blocked_until_verified_redaction_is_implemented");
    }
    if (!deepSeekCorpusFitsSingleBatch(manifest)) {
      blockers.push("live_corpus_requires_single_approved_batch");
    }
    if (!process.env.DEEPSEEK_API_KEY) {
      blockers.push("deepseek_api_key_not_present");
    }
    if (!process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY) {
      blockers.push("signed_receipt_public_key_not_present");
    }
  }

  const storage = storagePreflight(artifactDir);
  if (storage.warning) {
    warnings.push(String(storage.warning));
  }

  return { blockers, warnings, tools, storage };
}

function toolsForManifest(manifest: CorpusManifest): { required: string[]; optional: string[] } {
  if (manifest.processor.type === "local_ocr") {
    const common = ["focr", "tesseract", "swiftc", "pdfinfo", "pdftoppm"];
    switch (manifest.processor.engine) {
      case "focr":
        return { required: ["focr"], optional: common.filter((tool) => tool !== "focr") };
      case "tesseract":
        return {
          required: ["tesseract", ...(manifest.sources.some((source) => source.type === "pdf") ? ["pdftoppm"] : [])],
          optional: common.filter((tool) => tool !== "tesseract" && tool !== "pdftoppm")
        };
      case "macos_vision":
        return { required: ["swiftc"], optional: common.filter((tool) => tool !== "swiftc") };
      case "auto":
        return { required: [], optional: common };
    }
  }

  switch (manifest.workload_type) {
    case "ocr":
      return { required: [], optional: ["focr", "tesseract", "swiftc", "pdfinfo", "pdftoppm"] };
    case "media_catalogue":
      return { required: [], optional: ["ffprobe", "ffmpeg", "exiftool"] };
    case "dataset_transform":
      return { required: [], optional: ["jq", "sqlite3"] };
    default:
      return { required: [], optional: [] };
  }
}

function commandAvailable(command: string): boolean {
  const checked = spawnSync("/usr/bin/which", [command], { stdio: "ignore" });
  return checked.status === 0;
}

function storagePreflight(artifactDir: string): Record<string, unknown> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const stats = fs.statfsSync(artifactDir);
  const freeBytes = stats.bavail * stats.bsize;
  return {
    path: artifactDir,
    free_bytes: freeBytes,
    ...(freeBytes < 5 * 1024 * 1024 * 1024 ? { warning: "artifact_storage_below_5_gib" } : {})
  };
}

function retryDue(shard: CorpusLedgerShard): boolean {
  if (shard.status !== "failed" || !shard.next_retry_at) {
    return true;
  }
  return Date.parse(shard.next_retry_at) <= Date.now();
}

function resolveJobArtifactDir(jobId: string, options: { artifactDir?: string }): string {
  return options.artifactDir ? safeArtifactDir(options.artifactDir) : safeArtifactDir(path.join(defaultArtifactRoot(), "corpus", jobId));
}

async function withCorpusWorkerLock<T>(artifactDir: string, fn: () => Promise<T>): Promise<T> {
  const acquired = acquireCorpusWorkerLock(artifactDir);
  try {
    return await fn();
  } finally {
    releaseCorpusWorkerLock(acquired.lockPath, acquired.fd);
  }
}

function withCorpusWorkerLockSync<T>(artifactDir: string, fn: () => T): T {
  const acquired = acquireCorpusWorkerLock(artifactDir);
  try {
    return fn();
  } finally {
    releaseCorpusWorkerLock(acquired.lockPath, acquired.fd);
  }
}

function acquireCorpusWorkerLock(artifactDir: string): { lockPath: string; fd: number } {
  fs.mkdirSync(artifactDir, { recursive: true });
  const lockPath = path.join(artifactDir, "worker.lock");
  let fd: number | null = null;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fd = fs.openSync(lockPath, "wx");
        break;
      } catch (error) {
        if (attempt === 0 && isFileExistsError(error) && removeStaleWorkerLock(lockPath)) {
          continue;
        }
        throw error;
      }
    }
    if (fd === null) {
      throw new HarnessError("corpus_worker_lock_failed", `Corpus worker lock could not be acquired: ${lockPath}`);
    }
    fs.writeFileSync(
      fd,
      JSON.stringify({ schema_version: "deepseek-harness.corpus-worker-lock.v1", pid: process.pid, acquired_at: new Date().toISOString() })
    );
    return { lockPath, fd };
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new HarnessError("corpus_worker_already_running", `Corpus worker lock already exists: ${lockPath}`);
    }
    if (fd !== null) {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lockPath);
      } catch (cleanupError) {
        if (!isNoEntryError(cleanupError)) {
          throw cleanupError;
        }
      }
    }
    throw error;
  }
}

function releaseCorpusWorkerLock(lockPath: string, fd: number): void {
  fs.closeSync(fd);
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (!isNoEntryError(error)) {
      throw error;
    }
  }
}

function removeStaleWorkerLock(lockPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0 || processExists(Number(parsed.pid))) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ESRCH");
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function classifyError(error: string): string {
  if (error.includes("ENOENT")) {
    return "missing_input";
  }
  if (error.includes("EACCES") || error.includes("EPERM")) {
    return "permission_denied";
  }
  return "processor_error";
}

function safeArtifactDir(value: string): string {
  const allowedRoot = path.resolve(defaultArtifactRoot());
  const segments = value.split(/[\\/]+/).filter(Boolean);
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.join(allowedRoot, ...(segments[0] === "artifacts" ? segments.slice(1) : segments));
  assertNotForbiddenPath(resolved);
  if (!isWithin(resolved, allowedRoot)) {
    throw new HarnessError("corpus_artifact_path_blocked", "Corpus artefacts must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR");
  }
  fs.mkdirSync(allowedRoot, { recursive: true });
  const realAllowedRoot = fs.realpathSync(allowedRoot);
  const realExistingPath = existingRealPath(resolved);
  assertNotForbiddenPath(realAllowedRoot);
  assertNotForbiddenPath(realExistingPath);
  if (!isWithin(realExistingPath, realAllowedRoot)) {
    throw new HarnessError("corpus_artifact_path_blocked", "Corpus artefacts must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR");
  }
  return resolved;
}

function safeArtifactFile(value: string, artifactDir: string): string {
  const resolved = path.resolve(value);
  const safeDir = safeArtifactDir(artifactDir);
  assertNotForbiddenPath(resolved);
  if (!isWithin(resolved, safeDir)) {
    throw new HarnessError("corpus_output_path_blocked", "Corpus output must stay under the job artefact directory");
  }
  const realArtifactDir = existingRealPath(safeDir);
  const realExistingPath = existingRealPath(resolved);
  assertNotForbiddenPath(realArtifactDir);
  assertNotForbiddenPath(realExistingPath);
  if (!isWithin(realExistingPath, realArtifactDir)) {
    throw new HarnessError("corpus_output_path_blocked", "Corpus output must stay under the job artefact directory");
  }
  return resolved;
}

function existingRealPath(value: string): string {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new HarnessError("corpus_path_unresolvable", `Corpus path has no existing ancestor: ${value}`);
    }
    current = parent;
  }
  return fs.realpathSync(current);
}

function assertTranslationMemoryPathSafe(memoryPath: string): void {
  const resolved = path.resolve(memoryPath);
  const allowedRoot = path.resolve(defaultArtifactRoot());
  assertNotForbiddenPath(resolved);
  if (!isWithin(resolved, allowedRoot)) {
    throw new HarnessError(
      "translation_memory_path_blocked",
      "Translation memory must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR"
    );
  }
  fs.mkdirSync(allowedRoot, { recursive: true });
  const realAllowedRoot = fs.realpathSync(allowedRoot);
  const realExistingPath = existingRealPath(resolved);
  if (!isWithin(realExistingPath, realAllowedRoot)) {
    throw new HarnessError(
      "translation_memory_path_blocked",
      "Translation memory must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR"
    );
  }
}

function writeReconciledOutputNoClobber(ledger: CorpusLedger, outputPath: string): string {
  if (fs.existsSync(outputPath)) {
    const expectedSha256 = streamReconciledOutput(ledger);
    const existingSha256 = sha256File(outputPath);
    if (expectedSha256 !== existingSha256) {
      throw new HarnessError("corpus_output_exists", `Refusing to overwrite existing corpus output: ${outputPath}`);
    }
    return existingSha256;
  }

  const tmpPath = safeArtifactFile(`${outputPath}.${randomUUID()}.tmp`, ledger.artifact_dir);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "wx");
    const outputSha256 = streamReconciledOutput(ledger, fd);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(tmpPath, outputPath);
    } catch (error) {
      if (!isFileExistsError(error) || sha256File(outputPath) !== outputSha256) {
        throw error;
      }
    }
    return outputSha256;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch (error) {
      if (!isNoEntryError(error)) {
        throw error;
      }
    }
  }
}

function streamReconciledOutput(ledger: CorpusLedger, destinationFd?: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const separator = Buffer.from("\n\n", "utf8");
  for (let index = 0; index < ledger.shards.length; index += 1) {
    const shard = ledger.shards[index];
    if (!shard?.output_path) {
      throw new HarnessError("corpus_output_missing", `Shard output missing: ${shard?.shard_id ?? index}`);
    }
    if (index > 0) {
      hash.update(separator);
      if (destinationFd !== undefined) {
        writeBufferFully(destinationFd, separator);
      }
    }
    const sourcePath = safeArtifactFile(shard.output_path, ledger.artifact_dir);
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile()) {
      throw new HarnessError("corpus_output_missing", `Shard output is not a regular file: ${shard.shard_id}`);
    }
    const sourceFd = fs.openSync(sourcePath, "r");
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (bytesRead > 0) {
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          if (destinationFd !== undefined) {
            writeBufferFully(destinationFd, chunk);
          }
        }
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(sourceFd);
    }
  }
  return hash.digest("hex");
}

function writeBufferFully(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      throw new HarnessError("corpus_output_write_incomplete", "Corpus reconciliation output could not be written fully");
    }
    offset += written;
  }
}

function writeNoClobber(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing !== content) {
      throw new HarnessError("corpus_output_exists", `Refusing to overwrite existing corpus output: ${filePath}`);
    }
    return;
  }
  fs.writeFileSync(filePath, content);
}

function writeShardArtifactNoClobber(
  ledger: CorpusLedger,
  shard: CorpusLedgerShard,
  filePath: string,
  content: string,
  kind: "output" | "proof"
): void {
  const safePath = safeArtifactFile(filePath, ledger.artifact_dir);
  const expected = Buffer.from(content, "utf8");
  let interrupted = false;
  if (fs.existsSync(safePath)) {
    const existing = fs.readFileSync(safePath);
    if (existing.equals(expected)) {
      return;
    }
    interrupted = kind === "output"
      ? existing.length < expected.length && expected.subarray(0, existing.length).equals(existing)
      : isInterruptedProofBytes(existing, expected, ledger, shard);
    if (!interrupted) {
      throw new HarnessError("corpus_output_exists", `Refusing to overwrite existing corpus output: ${safePath}`);
    }
  }

  const tmpPath = safeArtifactFile(`${safePath}.${randomUUID()}.tmp`, ledger.artifact_dir);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "wx");
    writeBufferFully(fd, expected);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (interrupted) {
      quarantineInterruptedShardArtifact(safePath, ledger.artifact_dir);
    }
    try {
      fs.linkSync(tmpPath, safePath);
    } catch (error) {
      if (!isFileExistsError(error) || !fs.readFileSync(safePath).equals(expected)) {
        throw error;
      }
    }
    fsyncDirectory(path.dirname(safePath));
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch (error) {
      if (!isNoEntryError(error)) {
        throw error;
      }
    }
  }
}

function isInterruptedProofBytes(
  existing: Buffer,
  expected: Buffer,
  ledger: CorpusLedger,
  shard: CorpusLedgerShard
): boolean {
  if (existing.length >= expected.length) {
    return false;
  }
  const body = existing.toString("utf8");
  try {
    JSON.parse(body);
    return false;
  } catch {
    return looksLikeInterruptedShardProof(body, ledger, shard);
  }
}

function quarantineInterruptedShardArtifact(filePath: string, artifactDir: string): void {
  const existing = fs.readFileSync(filePath);
  const digest = createHash("sha256").update(existing).digest("hex").slice(0, 16);
  const quarantinePath = safeArtifactFile(`${filePath}.interrupted-${digest}.partial`, artifactDir);
  try {
    fs.linkSync(filePath, quarantinePath);
  } catch (error) {
    if (!isFileExistsError(error) || !fs.readFileSync(quarantinePath).equals(existing)) {
      throw error;
    }
  }
  fs.unlinkSync(filePath);
  fsyncDirectory(path.dirname(filePath));
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertNotForbiddenPath(filePath: string): void {
  const normalised = filePath.split(path.sep).join("/");
  const protectedWorkspaceRoot = path.resolve(os.homedir(), "Documents", "Obsidian").split(path.sep).join("/");
  const forbidden = [
    `${protectedWorkspaceRoot}/`,
    "/.ssh/",
    "/.gnupg/",
    "/Library/Keychains/",
    "/.config/opencode/auth",
    "/.codex/auth"
  ];
  if (forbidden.some((part) => normalised.includes(part))) {
    throw new HarnessError("corpus_path_forbidden", `Corpus path is forbidden: ${filePath}`);
  }
}

function assertNotSensitiveSourcePath(filePath: string): void {
  const segments = path.resolve(filePath).split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  const sensitiveSegments = new Set([
    ".aws",
    ".git",
    ".kube",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "certs",
    "certificates",
    "credential",
    "credentials",
    "keychain",
    "keychains",
    "passwords",
    "private-keys",
    "private_keys",
    "secret",
    "secrets",
    "token",
    "tokens"
  ]);
  const basename = segments.at(-1) ?? "";
  const sensitiveName =
    basename === ".env" ||
    basename.startsWith(".env.") ||
    /(?:^|[._-])(?:auth|credential|password|private[-_]?key|secret|token)(?:[._-]|$)/i.test(basename);
  const systemRoot = segments[0] === "etc" || segments[0] === "system";
  if (segments.some((segment) => sensitiveSegments.has(segment)) || sensitiveName || systemRoot) {
    throw new HarnessError("corpus_sensitive_source_path_blocked", `Corpus source path is sensitive and cannot be ingested: ${filePath}`);
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

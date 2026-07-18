#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };
import {
  agentCanary,
  cancelRun,
  approvalPacket,
  dispatchProposal,
  doctor,
  exportCostLedger,
  exportApprovalPacket,
  exportHarnessState,
  exportReviewPacket,
  failureCanary,
  getResults,
  getStatus,
  harnessState,
  modelComparisonPlan,
  planManifest,
  privacyCheck,
  processRun,
  scaleRamp,
  submitManifest,
  workloadBenchmark
} from "./runner.js";
import {
  corpusApprovalPacket,
  corpusCancel,
  corpusCommitTranslationMemory,
  corpusPlan,
  corpusReconcile,
  corpusResumeAsync,
  corpusStartAsync,
  corpusStatus,
  corpusTranslationReviewPacket,
  corpusValidate,
  corpusWorkAsync
} from "./corpus.js";
import { buildJsonlCorpusManifest, buildTextCorpusManifest } from "./corpus_ingest.js";
import { buildBookCorpusManifest, buildLongformCorpusManifest } from "./corpus_authoring.js";
import { buildMediaCorpusManifest } from "./corpus_media.js";
import { buildOcrCorpusManifest } from "./corpus_ocr.js";
import { corpusSupervisorAsync } from "./corpus_supervisor.js";
import { buildTranslationCorpusManifest } from "./corpus_translation.js";
import { toErrorPayload } from "./errors.js";

const server = new McpServer({
  name: "deepseek-harness",
  version: packageMetadata.version
});

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

async function wrap(fn: () => unknown | Promise<unknown>) {
  try {
    return jsonContent(await fn());
  } catch (error) {
    return jsonContent(toErrorPayload(error));
  }
}

server.registerTool(
  "deepseek_harness_doctor",
  {
    title: "DeepSeek Harness Doctor",
    description: "Check local harness state without exposing secrets.",
    inputSchema: {}
  },
  async () => wrap(() => doctor())
);

server.registerTool(
  "deepseek_harness_plan",
  {
    title: "DeepSeek Harness Plan",
    description: "Validate a run manifest and return safety blockers or warnings.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, allow_live }) => wrap(() => planManifest(manifest, { allowLive: allow_live }))
);

server.registerTool(
  "deepseek_harness_submit",
  {
    title: "DeepSeek Harness Submit",
    description: "Create a run and optionally start it. Live calls require allow_live and a valid approval packet.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      start: z.boolean().optional(),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, start, allow_live }) =>
    wrap(() => submitManifest(manifest, {}, { start: Boolean(start), allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_work",
  {
    title: "DeepSeek Harness Work",
    description: "Process a queued run by run_id.",
    inputSchema: {
      run_id: z.string().min(1),
      allow_live: z.boolean().optional()
    }
  },
  async ({ run_id, allow_live }) => wrap(() => processRun(run_id, {}, { allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_status",
  {
    title: "DeepSeek Harness Status",
    description: "Get a run summary by run_id.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => getStatus(run_id))
);

server.registerTool(
  "deepseek_harness_results",
  {
    title: "DeepSeek Harness Results",
    description: "Get run results by run_id.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => getResults(run_id))
);

server.registerTool(
  "deepseek_harness_cancel",
  {
    title: "DeepSeek Harness Cancel",
    description: "Cancel queued or running work for a run_id.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => cancelRun(run_id))
);

server.registerTool(
  "deepseek_harness_corpus_ingest_text",
  {
    title: "DeepSeek Harness Corpus Ingest Text",
    description: "Build a deterministic corpus manifest from a local UTF-8 text file.",
    inputSchema: {
      project: z.string().min(1),
      source_path: z.string().min(1),
      workload_type: z.enum(["book_reading", "ocr", "translation", "dataset_transform", "longform_generation", "media_catalogue", "mixed"]).optional(),
      privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]).optional(),
      chunk_chars: z.number().int().positive(),
      overlap_chars: z.number().int().nonnegative().optional(),
      artifact_dir: z.string().optional()
    }
  },
  async ({ project, source_path, workload_type, privacy_lane, chunk_chars, overlap_chars, artifact_dir }) =>
    wrap(() => ({
      ok: true,
      manifest: buildTextCorpusManifest({
        project,
        sourcePath: source_path,
        workloadType: workload_type ?? "mixed",
        privacyLane: privacy_lane ?? "local_only",
        chunkChars: chunk_chars,
        overlapChars: overlap_chars ?? 0,
        artifactDir: artifact_dir
      })
    }))
);

server.registerTool(
  "deepseek_harness_corpus_ingest_jsonl",
  {
    title: "DeepSeek Harness Corpus Ingest JSONL",
    description: "Build a deterministic dataset corpus manifest from a local JSONL file.",
    inputSchema: {
      project: z.string().min(1),
      source_path: z.string().min(1),
      privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]).optional(),
      records_per_shard: z.number().int().positive(),
      artifact_dir: z.string().optional()
    }
  },
  async ({ project, source_path, privacy_lane, records_per_shard, artifact_dir }) =>
    wrap(() => ({
      ok: true,
      manifest: buildJsonlCorpusManifest({
        project,
        sourcePath: source_path,
        privacyLane: privacy_lane ?? "local_only",
        recordsPerShard: records_per_shard,
        artifactDir: artifact_dir
      })
    }))
);

server.registerTool(
  "deepseek_harness_corpus_ingest_ocr",
  {
    title: "DeepSeek Harness Corpus Ingest OCR",
    description: "Build a page-bounded local OCR manifest for an image or PDF.",
    inputSchema: {
      project: z.string().min(1),
      source_path: z.string().min(1),
      privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]).optional(),
      engine: z.enum(["auto", "macos_vision", "focr", "tesseract"]).optional(),
      language: z.string().min(1).optional(),
      page_count: z.number().int().positive().optional(),
      artifact_dir: z.string().optional()
    }
  },
  async ({ project, source_path, privacy_lane, engine, language, page_count, artifact_dir }) =>
    wrap(() => ({
      ok: true,
      manifest: buildOcrCorpusManifest({
        project,
        sourcePath: source_path,
        privacyLane: privacy_lane ?? "local_only",
        engine,
        language,
        pageCount: page_count,
        artifactDir: artifact_dir
      })
    }))
);

server.registerTool(
  "deepseek_harness_corpus_ingest_media",
  {
    title: "DeepSeek Harness Corpus Ingest Media",
    description: "Build a deterministic ffprobe-backed audio/video catalogue manifest.",
    inputSchema: {
      project: z.string().min(1),
      source_path: z.string().min(1),
      privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]).optional(),
      recursive: z.boolean().optional(),
      max_files: z.number().int().positive().optional(),
      artifact_dir: z.string().optional()
    }
  },
  async ({ project, source_path, privacy_lane, recursive, max_files, artifact_dir }) =>
    wrap(() => ({
      ok: true,
      manifest: buildMediaCorpusManifest({
        project,
        sourcePath: source_path,
        privacyLane: privacy_lane ?? "local_only",
        recursive,
        maxFiles: max_files,
        artifactDir: artifact_dir
      })
    }))
);

server.registerTool(
  "deepseek_harness_corpus_ingest_translation",
  {
    title: "DeepSeek Harness Corpus Ingest Translation",
    description: "Build a bounded translation manifest with glossary, placeholder, QA and translation-memory contracts.",
    inputSchema: {
      project: z.string().min(1),
      source_path: z.string().min(1),
      source_lang: z.string().min(1),
      target_lang: z.string().min(1),
      glossary_path: z.string().optional(),
      chunk_chars: z.number().int().positive().optional(),
      overlap_chars: z.number().int().nonnegative().optional(),
      transport: z.enum(["fake", "dry-run", "deepseek"]).optional(),
      privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]).optional(),
      model: z.enum(["deepseek-v4-flash", "deepseek-v4-pro"]).optional(),
      concurrency: z.number().int().positive().max(100).optional(),
      cost_cap_usd: z.number().positive().max(100).optional(),
      max_tokens: z.number().int().positive().max(384000).optional(),
      max_retries: z.number().int().min(0).max(10).optional(),
      system_prompt: z.string().min(1).max(65_536).optional(),
      artifact_dir: z.string().optional(),
      translation_memory_path: z.string().optional()
    }
  },
  async (input) =>
    wrap(() => ({
      ok: true,
      manifest: buildTranslationCorpusManifest({
        project: input.project,
        sourcePath: input.source_path,
        sourceLang: input.source_lang,
        targetLang: input.target_lang,
        glossaryPath: input.glossary_path,
        chunkChars: input.chunk_chars,
        overlapChars: input.overlap_chars,
        transport: input.transport,
        privacyLane: input.privacy_lane ?? "local_only",
        model: input.model,
        concurrency: input.concurrency,
        costCapUsd: input.cost_cap_usd,
        maxTokens: input.max_tokens,
        maxRetries: input.max_retries,
        systemPrompt: input.system_prompt,
        artifactDir: input.artifact_dir,
        translationMemoryPath: input.translation_memory_path
      })
    }))
);

server.registerTool(
  "deepseek_harness_corpus_ingest_book",
  {
    title: "DeepSeek Harness Corpus Ingest Book",
    description: "Build a chapter-aware whole-book analysis manifest.",
    inputSchema: {
      project: z.string().min(1),
      source_path: z.string().min(1),
      chunk_chars: z.number().int().positive().optional(),
      overlap_chars: z.number().int().nonnegative().optional(),
      transport: z.enum(["fake", "dry-run", "deepseek"]).optional(),
      privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]).optional(),
      model: z.enum(["deepseek-v4-flash", "deepseek-v4-pro"]).optional(),
      concurrency: z.number().int().positive().max(100).optional(),
      cost_cap_usd: z.number().positive().max(100).optional(),
      max_tokens: z.number().int().positive().max(384000).optional(),
      prompt_template: z.string().min(1).max(65_536).optional(),
      artifact_dir: z.string().optional()
    }
  },
  async (input) =>
    wrap(() => ({
      ok: true,
      manifest: buildBookCorpusManifest({
        project: input.project,
        sourcePath: input.source_path,
        chunkChars: input.chunk_chars,
        overlapChars: input.overlap_chars,
        transport: input.transport,
        privacyLane: input.privacy_lane ?? "local_only",
        model: input.model,
        concurrency: input.concurrency,
        costCapUsd: input.cost_cap_usd,
        maxTokens: input.max_tokens,
        promptTemplate: input.prompt_template,
        artifactDir: input.artifact_dir
      })
    }))
);

server.registerTool(
  "deepseek_harness_corpus_ingest_longform",
  {
    title: "DeepSeek Harness Corpus Ingest Long Form",
    description: "Build a section-bounded long-form authoring manifest from an outline JSON file.",
    inputSchema: {
      project: z.string().min(1),
      outline_path: z.string().min(1),
      minimum_words_per_section: z.number().int().positive().optional(),
      continuity_required: z.boolean().optional(),
      citation_policy: z.string().min(1).optional(),
      transport: z.enum(["fake", "dry-run", "deepseek"]).optional(),
      privacy_lane: z.enum(["local_only", "external_inference_allowed", "redacted_external_allowed"]).optional(),
      model: z.enum(["deepseek-v4-flash", "deepseek-v4-pro"]).optional(),
      concurrency: z.number().int().positive().max(100).optional(),
      cost_cap_usd: z.number().positive().max(100).optional(),
      max_tokens: z.number().int().positive().max(384000).optional(),
      prompt_template: z.string().min(1).max(65_536).optional(),
      artifact_dir: z.string().optional()
    }
  },
  async (input) =>
    wrap(() => ({
      ok: true,
      manifest: buildLongformCorpusManifest({
        project: input.project,
        outlinePath: input.outline_path,
        minimumWordsPerSection: input.minimum_words_per_section,
        continuityRequired: input.continuity_required,
        citationPolicy: input.citation_policy,
        transport: input.transport,
        privacyLane: input.privacy_lane ?? "local_only",
        model: input.model,
        concurrency: input.concurrency,
        costCapUsd: input.cost_cap_usd,
        maxTokens: input.max_tokens,
        promptTemplate: input.prompt_template,
        artifactDir: input.artifact_dir
      })
    }))
);

server.registerTool(
  "deepseek_harness_corpus_plan",
  {
    title: "DeepSeek Harness Corpus Plan",
    description: "Preflight a corpus manifest for workload tools, storage, validation blockers, and DeepSeek live gates.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, allow_live }) => wrap(() => corpusPlan(manifest, { allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_corpus_approval_packet",
  {
    title: "DeepSeek Harness Corpus Approval Packet",
    description: "Prepare the exact owner-signing packet for a live DeepSeek corpus manifest without granting authority.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      output: z.string().optional()
    }
  },
  async ({ manifest, output }) => wrap(() => corpusApprovalPacket(manifest, { output }))
);

server.registerTool(
  "deepseek_harness_corpus_start",
  {
    title: "DeepSeek Harness Corpus Start",
    description: "Start a local corpus job from a corpus manifest object.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      enqueue_only: z.boolean().optional(),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, enqueue_only, allow_live }) =>
    wrap(() => corpusStartAsync(manifest, { allowLive: Boolean(allow_live), enqueueOnly: Boolean(enqueue_only) }))
);

server.registerTool(
  "deepseek_harness_corpus_status",
  {
    title: "DeepSeek Harness Corpus Status",
    description: "Return a local corpus job summary by job_id.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional()
    }
  },
  async ({ job_id, artifact_dir }) => wrap(() => corpusStatus(job_id, { artifactDir: artifact_dir }))
);

server.registerTool(
  "deepseek_harness_corpus_resume",
  {
    title: "DeepSeek Harness Corpus Resume",
    description: "Resume local corpus job processing by job_id.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional(),
      allow_live: z.boolean().optional()
    }
  },
  async ({ job_id, artifact_dir, allow_live }) =>
    wrap(() => corpusResumeAsync(job_id, { artifactDir: artifact_dir, allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_corpus_validate",
  {
    title: "DeepSeek Harness Corpus Validate",
    description: "Validate local corpus job artefacts by job_id.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional()
    }
  },
  async ({ job_id, artifact_dir }) => wrap(() => corpusValidate(job_id, { artifactDir: artifact_dir }))
);

server.registerTool(
  "deepseek_harness_corpus_work",
  {
    title: "DeepSeek Harness Corpus Work",
    description: "Run a bounded corpus worker loop until the job reaches a terminal state or max_iterations is hit.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional(),
      allow_live: z.boolean().optional(),
      max_iterations: z.number().int().positive().max(10000).optional(),
      interval_ms: z.number().int().nonnegative().max(3600000).optional()
    }
  },
  async ({ job_id, artifact_dir, allow_live, max_iterations, interval_ms }) =>
    wrap(() =>
      corpusWorkAsync(job_id, {
        artifactDir: artifact_dir,
        allowLive: Boolean(allow_live),
        maxIterations: max_iterations,
        intervalMs: interval_ms
      })
    )
);

server.registerTool(
  "deepseek_harness_corpus_reconcile",
  {
    title: "DeepSeek Harness Corpus Reconcile",
    description: "Reconcile local corpus shard outputs into a job-level output file.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional(),
      output: z.string().optional()
    }
  },
  async ({ job_id, artifact_dir, output }) => wrap(() => corpusReconcile(job_id, { artifactDir: artifact_dir, output }))
);

server.registerTool(
  "deepseek_harness_corpus_cancel",
  {
    title: "DeepSeek Harness Corpus Cancel",
    description: "Cancel pending or running local corpus work by job_id.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional()
    }
  },
  async ({ job_id, artifact_dir }) => wrap(() => corpusCancel(job_id, { artifactDir: artifact_dir }))
);

server.registerTool(
  "deepseek_harness_corpus_translation_review_packet",
  {
    title: "DeepSeek Harness Corpus Translation Review Packet",
    description: "Build the immutable digest packet an owner must review and sign before translation-memory commit.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional()
    }
  },
  async ({ job_id, artifact_dir }) => wrap(() => corpusTranslationReviewPacket(job_id, { artifactDir: artifact_dir }))
);

server.registerTool(
  "deepseek_harness_corpus_commit_translation_memory",
  {
    title: "DeepSeek Harness Corpus Commit Translation Memory",
    description: "Commit QA-passing translation outputs using an owner-signed review receipt.",
    inputSchema: {
      job_id: z.string().min(1),
      artifact_dir: z.string().optional(),
      review_receipt: z.record(z.unknown())
    }
  },
  async ({ job_id, artifact_dir, review_receipt }) =>
    wrap(() => corpusCommitTranslationMemory(job_id, { artifactDir: artifact_dir, reviewReceipt: review_receipt }))
);

server.registerTool(
  "deepseek_harness_corpus_supervise",
  {
    title: "DeepSeek Harness Corpus Supervise",
    description: "Run bounded supervisor cycles over local, fake and dry-run corpus ledgers; live jobs are always deferred.",
    inputSchema: {
      corpus_root: z.string().optional(),
      max_cycles: z.number().int().positive().max(10000).optional(),
      interval_ms: z.number().int().nonnegative().max(3600000).optional(),
      max_jobs_per_cycle: z.number().int().positive().max(1000).optional(),
      max_iterations_per_job: z.number().int().positive().max(10000).optional()
    }
  },
  async (input) =>
    wrap(() =>
      corpusSupervisorAsync({
        maxCycles: input.max_cycles,
        intervalMs: input.interval_ms,
        maxJobsPerCycle: input.max_jobs_per_cycle,
        maxIterationsPerJob: input.max_iterations_per_job,
        corpusRoot: input.corpus_root
      })
    )
);

server.registerTool(
  "deepseek_harness_export_review_packet",
  {
    title: "DeepSeek Harness Export Review Packet",
    description: "Write and return the local review packet for a run.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => exportReviewPacket(run_id))
);

server.registerTool(
  "deepseek_harness_state",
  {
    title: "DeepSeek Harness State",
    description: "Return or export a read-model snapshot. Protected private-workspace state writes are blocked.",
    inputSchema: {
      output: z.string().optional(),
      limit: z.number().int().positive().optional()
    }
  },
  async ({ output, limit }) =>
    wrap(() => (output ? exportHarnessState({}, { output, limit }) : harnessState({}, { limit })))
);

server.registerTool(
  "deepseek_harness_privacy_check",
  {
    title: "DeepSeek Harness Privacy Check",
    description: "Classify manifest egress risk without returning matched sensitive text.",
    inputSchema: {
      manifest: z.record(z.unknown())
    }
  },
  async ({ manifest }) => wrap(() => privacyCheck(manifest))
);

server.registerTool(
  "deepseek_harness_cost_ledger",
  {
    title: "DeepSeek Harness Cost Ledger",
    description: "Export token and cost ledger for an existing run.",
    inputSchema: {
      run_id: z.string().min(1),
      output: z.string().optional()
    }
  },
  async ({ run_id, output }) => wrap(() => exportCostLedger(run_id, {}, { output }))
);

server.registerTool(
  "deepseek_harness_dispatch_proposal",
  {
    title: "DeepSeek Harness Dispatch Proposal",
    description: "Return a Zeus Dispatch-compatible proposal packet without submitting or executing it.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, allow_live }) => wrap(() => dispatchProposal(manifest, { allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_approval_packet",
  {
    title: "DeepSeek Harness Approval Packet",
    description: "Prepare the explicit approval packet required before any live DeepSeek API call.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      output: z.string().optional()
    }
  },
  async ({ manifest, output }) => wrap(() => (output ? exportApprovalPacket(manifest, {}, { output }) : approvalPacket(manifest)))
);

server.registerTool(
  "deepseek_harness_agent_canary",
  {
    title: "DeepSeek Harness Agent Canary",
    description: "Run a local fake canary proving CLI/MCP agent usability and artefact generation.",
    inputSchema: {
      output: z.string().optional()
    }
  },
  async ({ output }) => wrap(() => agentCanary({}, { output }))
);

server.registerTool(
  "deepseek_harness_workload_benchmark",
  {
    title: "DeepSeek Harness Workload Benchmark",
    description: "Run a local fake or dry-run benchmark workload pack.",
    inputSchema: {
      workload: z.string().optional(),
      items: z.number().int().positive().optional(),
      concurrency: z.number().int().positive().optional(),
      transport: z.enum(["fake", "dry-run"]).optional(),
      model: z.enum(["deepseek-v4-flash", "deepseek-v4-pro"]).optional(),
      output: z.string().optional()
    }
  },
  async ({ workload, items, concurrency, transport, model, output }) =>
    wrap(() => workloadBenchmark({}, { workload, items, concurrency, transport, model, output }))
);

server.registerTool(
  "deepseek_harness_failure_canary",
  {
    title: "DeepSeek Harness Failure Canary",
    description: "Run a local failure-injection canary and confirm partial failure reporting.",
    inputSchema: {
      output: z.string().optional()
    }
  },
  async ({ output }) => wrap(() => failureCanary({}, { output }))
);

server.registerTool(
  "deepseek_harness_compare_models",
  {
    title: "DeepSeek Harness Compare Models",
    description: "Prepare fake or dry-run comparison manifests for DeepSeek V4 Flash and Pro.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      models: z.array(z.enum(["deepseek-v4-flash", "deepseek-v4-pro"])).optional(),
      transport: z.enum(["fake", "dry-run"]).optional(),
      output: z.string().optional()
    }
  },
  async ({ manifest, models, transport, output }) => wrap(() => modelComparisonPlan(manifest, { models, transport, output }))
);

server.registerTool(
  "deepseek_harness_scale_ramp",
  {
    title: "DeepSeek Harness Scale Ramp",
    description: "Run a bounded local scale ramp. Live DeepSeek scale requires allow_live and allow_live_scale.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      concurrencies: z.array(z.number().int().positive()).optional(),
      items: z.number().int().positive().optional(),
      output: z.string().optional(),
      allow_live: z.boolean().optional(),
      allow_live_scale: z.boolean().optional()
    }
  },
  async ({ manifest, concurrencies, items, output, allow_live, allow_live_scale }) =>
    wrap(() =>
      scaleRamp(manifest, {}, {
        concurrencies,
        itemCount: items,
        output,
        allowLive: Boolean(allow_live),
        allowLiveScale: Boolean(allow_live_scale)
      })
    )
);

const transport = new StdioServerTransport();
await server.connect(transport);

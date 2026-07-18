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
  quickstart,
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
import { parseMcpProfile, productCapabilities } from "./product.js";
import { approvalReceiptSchema, modelSchema, runManifestSchema, thinkingSchema } from "./schema.js";

const server = new McpServer({
  name: "deepseek-harness",
  version: packageMetadata.version
});
const activeMcpProfile = parseMcpProfile(process.env.DEEPSEEK_HARNESS_MCP_PROFILE, "full");

const normalRunManifestSchema = runManifestSchema.passthrough();
const corpusBoundSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const corpusSourceSchema = z
  .object({
    id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
    path: z.string().min(1).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    type: z.enum(["text", "pdf", "image", "audio", "video", "dataset", "other"]).default("text")
  })
  .passthrough();
const corpusShardSchema = z
  .object({
    id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
    source_id: z.string().min(1).max(200),
    input_path: z.string().min(1).optional(),
    inline_text: z.string().min(1).max(16 * 1024 * 1024).optional(),
    bounds: z.record(corpusBoundSchema).optional()
  })
  .passthrough()
  .refine((shard) => Boolean(shard.input_path) || Boolean(shard.inline_text), {
    message: "Each corpus shard must include input_path or inline_text"
  });
const corpusProcessorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copy_text").default("copy_text") }).passthrough(),
  z
    .object({
      type: z.literal("local_ocr"),
      engine: z.enum(["auto", "macos_vision", "focr", "tesseract"]).default("auto"),
      language: z.string().min(1).optional()
    })
    .passthrough(),
  z
    .object({
      type: z.literal("deepseek_batch"),
      transport: z.enum(["fake", "dry-run", "deepseek"]).default("fake"),
      model: modelSchema.default("deepseek-v4-flash"),
      thinking: thinkingSchema.default({ type: "enabled" }),
      response_format: z.enum(["text", "json_object"]).default("text"),
      prompt_template: z
        .string()
        .min(1)
        .max(65_536)
        .refine(
          (template) => (template.match(/\{\{text\}\}/g) ?? []).length === 1,
          "prompt_template must contain {{text}} exactly once"
        ),
      system_prompt: z.string().min(1).max(65_536).optional(),
      concurrency: z.number().int().positive().max(100).default(5),
      cost_cap_usd: z.number().positive().max(100).default(0.1),
      max_tokens: z.number().int().positive().max(384_000).optional(),
      approval_receipt: approvalReceiptSchema.optional()
    })
    .passthrough()
]);
const corpusManifestSchema = z
  .object({
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
    acceptance: z.object({}).passthrough().optional()
  })
  .passthrough();

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;
const localWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
} as const;
const liveWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
} as const;

const doctorOutputSchema = {
  ok: z.boolean(),
  version: z.string(),
  node: z.string(),
  state_dir: z.string(),
  db_path: z.string(),
  state_schema: z.object({
    current: z.number(),
    supported: z.number(),
    compatible: z.boolean()
  }),
  cwd: z.string(),
  corpus_input_root: z.string(),
  cli: z.object({
    source_entrypoint: z.string(),
    mcp_entrypoint: z.string()
  }),
  deepseek_api_key_present: z.boolean(),
  signed_receipt_public_key_present: z.boolean(),
  live_calls_default: z.literal("disabled"),
  live_concurrency_cap: z.number().int().positive(),
  canonical_state_write: z.literal(false),
  external_side_effects: z.literal(false)
};
const capabilitiesOutputSchema = {
  ok: z.boolean(),
  schema_version: z.literal("deepseek-harness.capabilities.v1"),
  product: z.object({
    name: z.string(),
    version: z.string(),
    status: z.string(),
    interfaces: z.array(z.string())
  }),
  active_mcp_profile: z.enum(["core", "corpus", "full"]),
  mcp_profiles: z.record(z.object({
    description: z.string(),
    tool_groups: z.array(z.string())
  })),
  model_strategy: z.object({
    provider: z.literal("deepseek"),
    generation: z.literal("v4"),
    default_model: z.literal("deepseek-v4-flash"),
    escalation_model: z.literal("deepseek-v4-pro"),
    thinking_default: z.literal("enabled"),
    reasoning_effort_default: z.literal("high"),
    reasoning_effort_escalation: z.literal("max"),
    routing_policy: z.string(),
    comparison_command: z.string()
  }),
  safety_defaults: z.object({
    live_calls: z.string(),
    external_side_effects: z.boolean(),
    canonical_state_write: z.boolean(),
    sensitive_external_egress: z.string(),
    live_authority: z.string()
  }),
  workflows: z.array(z.object({ id: z.string() }).passthrough()),
  discovery: z.object({
    cli_help: z.string(),
    this_document: z.string(),
    mcp_configuration: z.string(),
    safe_smoke: z.string()
  }),
  exit_codes: z.record(z.string())
};
const macroAuthorityOutputSchema = z.object({
  canonical_state_write: z.boolean(),
  command_centre_state_write: z.boolean(),
  local_workspace_apply: z.boolean(),
  github_write: z.boolean(),
  deploy: z.boolean(),
  publish: z.boolean(),
  send: z.boolean(),
  external_api_calls: z.boolean(),
  transport: z.string()
});
const runSummaryOutputSchema = z.object({
  run_id: z.string(),
  status: z.string(),
  project: z.string(),
  transport: z.string(),
  model: z.string(),
  artifact_dir: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  error: z.string().nullable(),
  item_count: z.number(),
  counts: z.record(z.number()),
  budget: z.union([z.object({}).passthrough(), z.null()])
});
const quickstartOutputSchema = {
  ok: z.boolean(),
  schema_version: z.literal("deepseek-harness.quickstart.v1"),
  status: z.enum(["ready", "failed"]),
  elapsed_ms: z.number().nonnegative(),
  network_calls: z.literal(0),
  health: z.object(doctorOutputSchema),
  canary: z.object({
    ok: z.boolean(),
    path: z.string().nullable(),
    report: z
      .object({
        schema_version: z.literal("deepseek-harness.agent-canary.v1"),
        status: z.enum(["ok", "failed"]),
        elapsed_ms: z.number().nonnegative(),
        run_id: z.string(),
        summary: runSummaryOutputSchema,
        artefacts: z.object({
          review_packet: z.string(),
          cost_ledger: z.string()
        }),
        authority: macroAuthorityOutputSchema
      })
      .passthrough()
  }),
  capabilities: z.object(capabilitiesOutputSchema),
  next_actions: z.array(z.string())
};

function isObjectPayload(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function jsonContent(payload: unknown, isError = false) {
  const response = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    isError
  };
  return isObjectPayload(payload) ? { ...response, structuredContent: payload } : response;
}

async function wrap(fn: () => unknown | Promise<unknown>) {
  try {
    return jsonContent(await fn());
  } catch (error) {
    return jsonContent(toErrorPayload(error), true);
  }
}

server.registerTool(
  "deepseek_harness_capabilities",
  {
    title: "DeepSeek Harness Capabilities",
    description: "Start here. Discover safe workflows, active tool profile, boundaries and exact next tool calls.",
    inputSchema: {},
    outputSchema: capabilitiesOutputSchema,
    annotations: readOnlyAnnotations
  },
  async () => wrap(() => productCapabilities(activeMcpProfile))
);

server.registerTool(
  "deepseek_harness_quickstart",
  {
    title: "DeepSeek Harness Quickstart",
    description: "Run a zero-network fake canary and return health, review artefacts, cost ledger and next actions.",
    inputSchema: {
      output: z.string().optional()
    },
    outputSchema: quickstartOutputSchema,
    annotations: localWriteAnnotations
  },
  async ({ output }) => wrap(() => quickstart({}, { output }))
);

server.registerTool(
  "deepseek_harness_doctor",
  {
    title: "DeepSeek Harness Doctor",
    description: "Check local harness state without exposing secrets.",
    inputSchema: {},
    outputSchema: doctorOutputSchema,
    annotations: readOnlyAnnotations
  },
  async () => wrap(() => doctor())
);

if (activeMcpProfile !== "corpus") {

server.registerTool(
  "deepseek_harness_plan",
  {
    title: "DeepSeek Harness Plan",
    description: "Validate a run manifest and return safety blockers or warnings.",
    inputSchema: {
      manifest: normalRunManifestSchema,
      allow_live: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  async ({ manifest, allow_live }) => wrap(() => planManifest(manifest, { allowLive: allow_live }))
);

server.registerTool(
  "deepseek_harness_submit",
  {
    title: "DeepSeek Harness Submit",
    description: "Create a run and optionally start it. Live calls require allow_live and a valid approval packet.",
    inputSchema: {
      manifest: normalRunManifestSchema,
      start: z.boolean().optional(),
      allow_live: z.boolean().optional()
    },
    annotations: liveWriteAnnotations
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
    },
    annotations: liveWriteAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: localWriteAnnotations
  },
  async ({ run_id }) => wrap(() => cancelRun(run_id))
);

}

if (activeMcpProfile !== "core") {

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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: readOnlyAnnotations
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
      manifest: corpusManifestSchema,
      allow_live: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  async ({ manifest, allow_live }) => wrap(() => corpusPlan(manifest, { allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_corpus_approval_packet",
  {
    title: "DeepSeek Harness Corpus Approval Packet",
    description: "Prepare the exact owner-signing packet for a live DeepSeek corpus manifest without granting authority.",
    inputSchema: {
      manifest: corpusManifestSchema,
      output: z.string().optional()
    },
    annotations: localWriteAnnotations
  },
  async ({ manifest, output }) => wrap(() => corpusApprovalPacket(manifest, { output }))
);

server.registerTool(
  "deepseek_harness_corpus_start",
  {
    title: "DeepSeek Harness Corpus Start",
    description: "Start a local corpus job from a corpus manifest object.",
    inputSchema: {
      manifest: corpusManifestSchema,
      enqueue_only: z.boolean().optional(),
      allow_live: z.boolean().optional()
    },
    annotations: liveWriteAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: liveWriteAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: liveWriteAnnotations
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
    },
    annotations: localWriteAnnotations
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
    },
    annotations: localWriteAnnotations
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
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: localWriteAnnotations
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
    },
    annotations: localWriteAnnotations
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

}

if (activeMcpProfile !== "corpus") {

server.registerTool(
  "deepseek_harness_export_review_packet",
  {
    title: "DeepSeek Harness Export Review Packet",
    description: "Write and return the local review packet for a run.",
    inputSchema: {
      run_id: z.string().min(1)
    },
    annotations: localWriteAnnotations
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
    },
    annotations: localWriteAnnotations
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
      manifest: normalRunManifestSchema
    },
    annotations: readOnlyAnnotations
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
    },
    annotations: localWriteAnnotations
  },
  async ({ run_id, output }) => wrap(() => exportCostLedger(run_id, {}, { output }))
);

server.registerTool(
  "deepseek_harness_dispatch_proposal",
  {
    title: "DeepSeek Harness Dispatch Proposal",
    description: "Return a Zeus Dispatch-compatible proposal packet without submitting or executing it.",
    inputSchema: {
      manifest: normalRunManifestSchema,
      allow_live: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  async ({ manifest, allow_live }) => wrap(() => dispatchProposal(manifest, { allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_approval_packet",
  {
    title: "DeepSeek Harness Approval Packet",
    description: "Prepare the explicit approval packet required before any live DeepSeek API call.",
    inputSchema: {
      manifest: normalRunManifestSchema,
      output: z.string().optional()
    },
    annotations: localWriteAnnotations
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
    },
    annotations: localWriteAnnotations
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
    },
    annotations: localWriteAnnotations
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
    },
    annotations: localWriteAnnotations
  },
  async ({ output }) => wrap(() => failureCanary({}, { output }))
);

server.registerTool(
  "deepseek_harness_compare_models",
  {
    title: "DeepSeek Harness Compare Models",
    description: "Prepare fake or dry-run comparison manifests for DeepSeek V4 Flash and Pro.",
    inputSchema: {
      manifest: normalRunManifestSchema,
      models: z.array(z.enum(["deepseek-v4-flash", "deepseek-v4-pro"])).optional(),
      transport: z.enum(["fake", "dry-run"]).optional(),
      output: z.string().optional()
    },
    annotations: localWriteAnnotations
  },
  async ({ manifest, models, transport, output }) => wrap(() => modelComparisonPlan(manifest, { models, transport, output }))
);

server.registerTool(
  "deepseek_harness_scale_ramp",
  {
    title: "DeepSeek Harness Scale Ramp",
    description: "Run a bounded local scale ramp. Live DeepSeek scale requires allow_live and allow_live_scale.",
    inputSchema: {
      manifest: normalRunManifestSchema,
      concurrencies: z.array(z.number().int().positive()).optional(),
      items: z.number().int().positive().optional(),
      output: z.string().optional(),
      allow_live: z.boolean().optional(),
      allow_live_scale: z.boolean().optional()
    },
    annotations: liveWriteAnnotations
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

}

const transport = new StdioServerTransport();
await server.connect(transport);

#!/usr/bin/env node
import fs from "node:fs";
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
  mcpConfig,
  mcpConfigToml,
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
import { buildOcrCorpusManifest, type OcrEngine } from "./corpus_ocr.js";
import { corpusSupervisorAsync } from "./corpus_supervisor.js";
import { buildTranslationCorpusManifest, type TranslationTransport } from "./corpus_translation.js";
import { toErrorPayload } from "./errors.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allowLive = Boolean(args.flags["allow-live"]);

  let result: unknown;
  let rawOutput: string | undefined;
  switch (args.command) {
    case "corpus":
      result = await handleCorpusCommand(args, { allowLive });
      break;
    case "doctor":
      result = doctor();
      break;
    case "mcp-config":
      {
        const options = {
          command: optionalString(args.flags.command),
          stateDir: optionalString(args.flags["state-dir"]),
          artifactDir: optionalString(args.flags["artifact-dir"])
        };
        const format = optionalString(args.flags.format) ?? "json";
        if (format === "json") {
          result = mcpConfig(options);
        } else if (format === "codex-toml") {
          rawOutput = mcpConfigToml(options);
        } else {
          throw new Error(`Unknown mcp-config format: ${format}`);
        }
      }
      break;
    case "plan":
      result = planManifest(readJson(requiredArg(args, 0, "manifest path")), { allowLive });
      break;
    case "submit":
      result = await submitManifest(readJson(requiredArg(args, 0, "manifest path")), {}, {
        start: Boolean(args.flags.start),
        allowLive
      });
      break;
    case "work":
      result = await processRun(requiredFlagOrArg(args, "run", 0), {}, { allowLive });
      break;
    case "status":
      result = getStatus(requiredArg(args, 0, "run_id"));
      break;
    case "results":
      result = getResults(requiredArg(args, 0, "run_id"));
      break;
    case "cancel":
      result = cancelRun(requiredArg(args, 0, "run_id"));
      break;
    case "export-review-packet":
      result = exportReviewPacket(requiredArg(args, 0, "run_id"));
      break;
    case "state":
      result = args.flags.output
        ? exportHarnessState({}, { output: String(args.flags.output), limit: optionalNumber(args.flags.limit) })
        : harnessState({}, { limit: optionalNumber(args.flags.limit) });
      break;
    case "privacy-check":
      result = privacyCheck(readJson(requiredArg(args, 0, "manifest path")));
      break;
    case "cost-ledger":
      result = exportCostLedger(requiredArg(args, 0, "run_id"), {}, { output: optionalString(args.flags.output) });
      break;
    case "dispatch-proposal":
      result = dispatchProposal(readJson(requiredArg(args, 0, "manifest path")), { allowLive });
      break;
    case "approval-packet":
      result = args.flags.output
        ? exportApprovalPacket(readJson(requiredArg(args, 0, "manifest path")), {}, { output: String(args.flags.output) })
        : approvalPacket(readJson(requiredArg(args, 0, "manifest path")));
      break;
    case "scale-ramp":
      result = await scaleRamp(readJson(requiredArg(args, 0, "manifest path")), {}, {
        concurrencies: optionalNumberList(args.flags.concurrency),
        itemCount: optionalNumber(args.flags.items),
        output: optionalString(args.flags.output),
        allowLive,
        allowLiveScale: Boolean(args.flags["allow-live-scale"])
      });
      break;
    case "agent-canary":
      result = await agentCanary({}, { output: optionalString(args.flags.output) });
      break;
    case "workload-benchmark":
      result = await workloadBenchmark({}, {
        workload: optionalString(args.flags.workload),
        items: optionalNumber(args.flags.items),
        concurrency: optionalNumber(args.flags.concurrency),
        transport: optionalLocalTransport(args.flags.transport),
        model: optionalModel(args.flags.model),
        output: optionalString(args.flags.output)
      });
      break;
    case "failure-canary":
      result = await failureCanary({}, { output: optionalString(args.flags.output) });
      break;
    case "compare-models":
      result = modelComparisonPlan(readJson(requiredArg(args, 0, "manifest path")), {
        models: optionalModelList(args.flags.models),
        transport: optionalLocalTransport(args.flags.transport),
        output: optionalString(args.flags.output)
      });
      break;
    default:
      throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  }

  process.stdout.write(rawOutput ?? `${JSON.stringify(result, null, 2)}\n`);
}

async function handleCorpusCommand(args: ParsedArgs, options: { allowLive?: boolean } = {}): Promise<Record<string, unknown>> {
  const [subcommand = "", ...rest] = args.positional;
  const corpusArgs: ParsedArgs = {
    command: subcommand,
    positional: rest,
    flags: args.flags
  };

  switch (subcommand) {
    case "ingest-text":
      return {
        ok: true,
        manifest: buildTextCorpusManifest({
          project: requiredStringFlag(corpusArgs, "project"),
          sourcePath: requiredArg(corpusArgs, 0, "source path"),
          workloadType: optionalCorpusWorkload(args.flags.workload) ?? "mixed",
          privacyLane: optionalCorpusPrivacy(args.flags.privacy) ?? "local_only",
          chunkChars: requiredNumberFlag(corpusArgs, "chunk-chars"),
          overlapChars: optionalNumber(args.flags["overlap-chars"]) ?? 0,
          artifactDir: optionalString(args.flags["artifact-dir"])
        })
      };
    case "ingest-jsonl":
      return {
        ok: true,
        manifest: buildJsonlCorpusManifest({
          project: requiredStringFlag(corpusArgs, "project"),
          sourcePath: requiredArg(corpusArgs, 0, "source path"),
          privacyLane: optionalCorpusPrivacy(args.flags.privacy) ?? "local_only",
          recordsPerShard: requiredNumberFlag(corpusArgs, "records-per-shard"),
          artifactDir: optionalString(args.flags["artifact-dir"])
        })
      };
    case "ingest-ocr":
      return {
        ok: true,
        manifest: buildOcrCorpusManifest({
          project: requiredStringFlag(corpusArgs, "project"),
          sourcePath: requiredArg(corpusArgs, 0, "source path"),
          privacyLane: optionalCorpusPrivacy(args.flags.privacy) ?? "local_only",
          engine: optionalOcrEngine(args.flags.engine),
          language: optionalString(args.flags.language),
          artifactDir: optionalString(args.flags["artifact-dir"]),
          pageCount: optionalNumber(args.flags["page-count"])
        })
      };
    case "ingest-media":
      return {
        ok: true,
        manifest: buildMediaCorpusManifest({
          project: requiredStringFlag(corpusArgs, "project"),
          sourcePath: requiredArg(corpusArgs, 0, "source path"),
          privacyLane: optionalCorpusPrivacy(args.flags.privacy) ?? "local_only",
          artifactDir: optionalString(args.flags["artifact-dir"]),
          recursive: Boolean(args.flags.recursive),
          maxFiles: optionalNumber(args.flags["max-files"])
        })
      };
    case "ingest-translation":
      return {
        ok: true,
        manifest: buildTranslationCorpusManifest({
          project: requiredStringFlag(corpusArgs, "project"),
          sourcePath: requiredArg(corpusArgs, 0, "source path"),
          sourceLang: requiredStringFlag(corpusArgs, "source-lang"),
          targetLang: requiredStringFlag(corpusArgs, "target-lang"),
          glossaryPath: optionalString(args.flags.glossary),
          chunkChars: optionalNumber(args.flags["chunk-chars"]),
          overlapChars: optionalNumber(args.flags["overlap-chars"]),
          transport: optionalCorpusTransport(args.flags.transport),
          privacyLane: optionalCorpusPrivacy(args.flags.privacy) ?? "local_only",
          model: optionalModel(args.flags.model),
          concurrency: optionalNumber(args.flags.concurrency),
          costCapUsd: optionalNumber(args.flags["cost-cap-usd"]),
          maxTokens: optionalNumber(args.flags["max-tokens"]),
          maxRetries: optionalNumber(args.flags["max-retries"]),
          artifactDir: optionalString(args.flags["artifact-dir"]),
          translationMemoryPath: optionalString(args.flags["translation-memory"]),
          systemPrompt: optionalString(args.flags["system-prompt"])
        })
      };
    case "ingest-book":
      return {
        ok: true,
        manifest: buildBookCorpusManifest({
          project: requiredStringFlag(corpusArgs, "project"),
          sourcePath: requiredArg(corpusArgs, 0, "source path"),
          privacyLane: optionalCorpusPrivacy(args.flags.privacy) ?? "local_only",
          chunkChars: optionalNumber(args.flags["chunk-chars"]),
          overlapChars: optionalNumber(args.flags["overlap-chars"]),
          transport: optionalCorpusTransport(args.flags.transport),
          model: optionalModel(args.flags.model),
          concurrency: optionalNumber(args.flags.concurrency),
          costCapUsd: optionalNumber(args.flags["cost-cap-usd"]),
          maxTokens: optionalNumber(args.flags["max-tokens"]),
          artifactDir: optionalString(args.flags["artifact-dir"]),
          promptTemplate: optionalString(args.flags["prompt-template"])
        })
      };
    case "ingest-longform":
      return {
        ok: true,
        manifest: buildLongformCorpusManifest({
          project: requiredStringFlag(corpusArgs, "project"),
          outlinePath: requiredArg(corpusArgs, 0, "outline path"),
          privacyLane: optionalCorpusPrivacy(args.flags.privacy) ?? "local_only",
          transport: optionalCorpusTransport(args.flags.transport),
          model: optionalModel(args.flags.model),
          concurrency: optionalNumber(args.flags.concurrency),
          costCapUsd: optionalNumber(args.flags["cost-cap-usd"]),
          maxTokens: optionalNumber(args.flags["max-tokens"]),
          artifactDir: optionalString(args.flags["artifact-dir"]),
          promptTemplate: optionalString(args.flags["prompt-template"]),
          minimumWordsPerSection: optionalNumber(args.flags["minimum-words-per-section"]),
          continuityRequired: args.flags["no-continuity"] ? false : undefined,
          citationPolicy: optionalString(args.flags["citation-policy"])
        })
      };
    case "plan":
      return corpusPlan(readJson(requiredArg(corpusArgs, 0, "manifest path")), { allowLive: options.allowLive });
    case "approval-packet":
      return corpusApprovalPacket(readJson(requiredArg(corpusArgs, 0, "manifest path")), {
        output: optionalString(args.flags.output)
      });
    case "start":
      return corpusStartAsync(readJson(requiredArg(corpusArgs, 0, "manifest path")), {
        allowLive: options.allowLive,
        enqueueOnly: Boolean(args.flags["enqueue-only"])
      });
    case "status":
      return corpusStatus(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"])
      });
    case "resume":
      return corpusResumeAsync(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"]),
        allowLive: options.allowLive
      });
    case "work":
      return corpusWorkAsync(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"]),
        allowLive: options.allowLive,
        maxIterations: optionalNumber(args.flags["max-iterations"]),
        intervalMs: optionalNumber(args.flags["interval-ms"])
      });
    case "validate":
      return corpusValidate(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"])
      });
    case "reconcile":
      return corpusReconcile(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"]),
        output: optionalString(args.flags.output)
      });
    case "cancel":
      return corpusCancel(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"])
      });
    case "commit-translation-memory":
      return corpusCommitTranslationMemory(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"]),
        reviewReceipt: readJson(requiredStringFlag(corpusArgs, "review-receipt"))
      });
    case "translation-review-packet":
      return corpusTranslationReviewPacket(requiredArg(corpusArgs, 0, "job_id"), {
        artifactDir: optionalString(args.flags["artifact-dir"])
      });
    case "supervise":
      return { ...await corpusSupervisorAsync({
        corpusRoot: optionalString(args.flags["corpus-root"]),
        once: Boolean(args.flags.once),
        maxCycles: optionalNumber(args.flags["max-cycles"]),
        intervalMs: optionalNumber(args.flags["interval-ms"]),
        maxJobsPerCycle: optionalNumber(args.flags["max-jobs-per-cycle"]),
        maxIterationsPerJob: optionalNumber(args.flags["max-iterations-per-job"]),
        allowLive: Boolean(options.allowLive)
      }) };
    default:
      throw new Error(`Unknown corpus command: ${subcommand || "(missing)"}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(value);
    }
  }

  return { command, positional, flags };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredArg(args: ParsedArgs, index: number, label: string): string {
  const value = args.positional[index];
  if (!value) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function requiredFlagOrArg(args: ParsedArgs, flag: string, index: number): string {
  const fromFlag = args.flags[flag];
  if (typeof fromFlag === "string") {
    return fromFlag;
  }
  return requiredArg(args, index, flag);
}

function optionalNumber(value: string | boolean | undefined): number | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected number, got ${value}`);
  }
  return parsed;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredStringFlag(args: ParsedArgs, flag: string): string {
  const value = optionalString(args.flags[flag]);
  if (!value) {
    throw new Error(`Missing --${flag}`);
  }
  return value;
}

function requiredNumberFlag(args: ParsedArgs, flag: string): number {
  const value = optionalNumber(args.flags[flag]);
  if (value === undefined) {
    throw new Error(`Missing --${flag}`);
  }
  return value;
}

function optionalCorpusWorkload(value: string | boolean | undefined):
  | "book_reading"
  | "ocr"
  | "translation"
  | "dataset_transform"
  | "longform_generation"
  | "media_catalogue"
  | "mixed"
  | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }
  if (
    raw === "book_reading" ||
    raw === "ocr" ||
    raw === "translation" ||
    raw === "dataset_transform" ||
    raw === "longform_generation" ||
    raw === "media_catalogue" ||
    raw === "mixed"
  ) {
    return raw;
  }
  throw new Error(`Unknown corpus workload: ${raw}`);
}

function optionalCorpusPrivacy(value: string | boolean | undefined):
  | "local_only"
  | "external_inference_allowed"
  | "redacted_external_allowed"
  | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }
  if (raw === "local_only" || raw === "external_inference_allowed" || raw === "redacted_external_allowed") {
    return raw;
  }
  throw new Error(`Unknown corpus privacy lane: ${raw}`);
}

function optionalCorpusTransport(value: string | boolean | undefined): TranslationTransport | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }
  if (raw === "fake" || raw === "dry-run" || raw === "deepseek") {
    return raw;
  }
  throw new Error(`Unknown corpus transport: ${raw}`);
}

function optionalOcrEngine(value: string | boolean | undefined): OcrEngine | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }
  if (raw === "auto" || raw === "macos_vision" || raw === "focr" || raw === "tesseract") {
    return raw;
  }
  throw new Error(`Unknown OCR engine: ${raw}`);
}

function optionalNumberList(value: string | boolean | undefined): number[] | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part) || part <= 0 || !Number.isInteger(part))) {
    throw new Error(`Expected comma-separated positive integers, got ${value}`);
  }
  return parts;
}

function optionalLocalTransport(value: string | boolean | undefined): "fake" | "dry-run" | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  if (value === "fake" || value === "dry-run") {
    return value;
  }
  throw new Error(`Expected fake or dry-run transport, got ${value}`);
}

function optionalModel(value: string | boolean | undefined): "deepseek-v4-flash" | "deepseek-v4-pro" | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  if (value === "deepseek-v4-flash" || value === "deepseek-v4-pro") {
    return value;
  }
  throw new Error(`Expected DeepSeek V4 model, got ${value}`);
}

function optionalModelList(value: string | boolean | undefined): Array<"deepseek-v4-flash" | "deepseek-v4-pro"> | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  return value.split(",").map((part) => {
    const model = optionalModel(part.trim());
    if (!model) {
      throw new Error(`Expected DeepSeek V4 model, got ${part}`);
    }
    return model;
  });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(toErrorPayload(error), null, 2)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import fs from "node:fs";
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
  mcpConfig,
  mcpConfigToml,
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
import { buildOcrCorpusManifest, type OcrEngine } from "./corpus_ocr.js";
import { corpusSupervisorAsync } from "./corpus_supervisor.js";
import { buildTranslationCorpusManifest, type TranslationTransport } from "./corpus_translation.js";
import { errorExitCode, toErrorPayload, usageError } from "./errors.js";
import { parseMcpProfile, productCapabilities, type McpProfile } from "./product.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const COMMANDS = [
  "chat",
  "quickstart",
  "capabilities",
  "doctor",
  "mcp-config",
  "plan",
  "submit",
  "work",
  "status",
  "results",
  "cancel",
  "export-review-packet",
  "state",
  "privacy-check",
  "cost-ledger",
  "dispatch-proposal",
  "approval-packet",
  "agent-canary",
  "workload-benchmark",
  "failure-canary",
  "compare-models",
  "scale-ramp",
  "corpus"
] as const;

const CORPUS_COMMANDS = [
  "ingest-text",
  "ingest-jsonl",
  "ingest-ocr",
  "ingest-media",
  "ingest-translation",
  "ingest-book",
  "ingest-longform",
  "plan",
  "approval-packet",
  "start",
  "status",
  "resume",
  "work",
  "validate",
  "reconcile",
  "cancel",
  "translation-review-packet",
  "commit-translation-memory",
  "supervise"
] as const;

const CHAT_FLAGS: Record<string, readonly string[]> = {
  chat: ["resume", "list", "model", "plain", "tui"]
};

const COMMAND_FLAGS: Record<string, readonly string[]> = {
  quickstart: ["output"],
  capabilities: ["profile"],
  doctor: [],
  "mcp-config": ["command", "state-dir", "artifact-dir", "input-root", "format", "profile"],
  plan: ["allow-live"],
  submit: ["start", "allow-live"],
  work: ["run", "allow-live"],
  status: [],
  results: [],
  cancel: [],
  "export-review-packet": [],
  state: ["output", "limit"],
  "privacy-check": [],
  "cost-ledger": ["output"],
  "dispatch-proposal": ["allow-live"],
  "approval-packet": ["output"],
  "agent-canary": ["output"],
  "workload-benchmark": ["workload", "items", "concurrency", "transport", "model", "output"],
  "failure-canary": ["output"],
  "compare-models": ["models", "transport", "output"],
  "scale-ramp": ["concurrency", "items", "output", "allow-live", "allow-live-scale"],
  ...CHAT_FLAGS,
};

const CORPUS_FLAGS: Record<string, readonly string[]> = {
  "ingest-text": ["project", "workload", "privacy", "chunk-chars", "overlap-chars", "artifact-dir"],
  "ingest-jsonl": ["project", "privacy", "records-per-shard", "artifact-dir"],
  "ingest-ocr": ["project", "privacy", "engine", "language", "artifact-dir", "page-count"],
  "ingest-media": ["project", "privacy", "artifact-dir", "recursive", "max-files"],
  "ingest-translation": [
    "project", "source-lang", "target-lang", "glossary", "chunk-chars", "overlap-chars", "transport",
    "privacy", "model", "concurrency", "cost-cap-usd", "max-tokens", "max-retries", "artifact-dir",
    "translation-memory", "system-prompt"
  ],
  "ingest-book": [
    "project", "privacy", "chunk-chars", "overlap-chars", "transport", "model", "concurrency",
    "cost-cap-usd", "max-tokens", "artifact-dir", "prompt-template"
  ],
  "ingest-longform": [
    "project", "privacy", "transport", "model", "concurrency", "cost-cap-usd", "max-tokens", "artifact-dir",
    "prompt-template", "minimum-words-per-section", "no-continuity", "citation-policy"
  ],
  plan: ["allow-live"],
  "approval-packet": ["output"],
  start: ["allow-live", "enqueue-only"],
  status: ["artifact-dir"],
  resume: ["artifact-dir", "allow-live"],
  work: ["artifact-dir", "allow-live", "max-iterations", "interval-ms"],
  validate: ["artifact-dir"],
  reconcile: ["artifact-dir", "output"],
  cancel: ["artifact-dir"],
  "commit-translation-memory": ["artifact-dir", "review-receipt"],
  "translation-review-packet": ["artifact-dir"],
  supervise: ["corpus-root", "once", "max-cycles", "interval-ms", "max-jobs-per-cycle", "max-iterations-per-job", "allow-live"]
};

const BOOLEAN_FLAGS = new Set([
  "allow-live",
  "allow-live-scale",
  "enqueue-only",
  "force",
  "help",
  "no-continuity",
  "once",
  "list",
  "plain",
  "recursive",
  "start",
  "tui"
]);

function helpText(): string {
  return `DeepSeek Harness ${packageMetadata.version}
Local-first, safety-gated parallel DeepSeek batch and corpus runtime.

Usage:
  deepseek-harness <command> [options]

Start here:
  chat                    Start an interactive coding session
  quickstart              Run a local fake canary and return proof artefacts
  capabilities            Discover workflows, safety boundaries and MCP profiles as JSON
  doctor                  Inspect local paths and live-call prerequisites without secrets
  mcp-config              Generate MCP JSON or Codex TOML (new installs default to core profile)

Batch:
  plan | submit | work | status | results | cancel
  workload-benchmark | scale-ramp | compare-models | failure-canary

Safety and proof:
  privacy-check | approval-packet | export-review-packet | cost-ledger | state

Corpus:
  corpus --help           OCR, books, JSONL, translation, long-form and media workflows

Global:
  -h, --help              Show help
  -V, --version           Print version

Examples:
  deepseek-harness quickstart
  deepseek-harness capabilities
  deepseek-harness plan examples/basic-run.json
  deepseek-harness mcp-config --format codex-toml --profile core

Commands return JSON on stdout. Diagnostics and structured errors use stderr.
Live calls remain disabled unless all signed authority, privacy and cost gates pass.
`;
}

function corpusHelpText(): string {
  return `DeepSeek Harness corpus workflows

Usage:
  deepseek-harness corpus <command> [options]

Create a manifest:
  ingest-text | ingest-jsonl | ingest-ocr | ingest-media
  ingest-translation | ingest-book | ingest-longform

Run a resumable job:
  plan | start | status | resume | work | validate | reconcile | cancel

Governed operations:
  approval-packet | translation-review-packet | commit-translation-memory | supervise

Canonical lifecycle:
  ingest -> plan -> start -> validate -> reconcile

Run deepseek-harness capabilities for workflow selection and safety boundaries.
`;
}

function chatHelpText(): string {
  return `DeepSeek Harness chat

Usage:
  deepseek-harness chat [prompt] [--resume SESSION] [--model MODEL]

Modes:
  --tui                   Force the full-screen terminal UI (TTY required)
  --plain                 Force the plain/headless interface
  --list                  List recent chat sessions

Without a prompt or mode flag, chat selects TUI only when stdin and stdout are TTYs.
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "--robot-help") {
    process.stdout.write(argv[0] === "help" && argv[1] === "corpus" ? corpusHelpText() : argv[0] === "help" && argv[1] === "chat" ? chatHelpText() : helpText());
    return;
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${packageMetadata.version}\n`);
    return;
  }

  const args = parseArgs(argv);
  if (args.flags.help || args.flags.h) {
    process.stdout.write(args.command === "corpus" ? corpusHelpText() : args.command === "chat" ? chatHelpText() : helpText());
    return;
  }
  validateCommandFlags(args);
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
    case "capabilities":
      result = productCapabilities(cliMcpProfile(args.flags.profile, "full"));
      break;
    case "quickstart":
      result = await quickstart({}, { output: optionalString(args.flags.output) });
      break;
    case "mcp-config":
      {
        const options = {
          command: optionalString(args.flags.command),
          stateDir: optionalString(args.flags["state-dir"]),
          artifactDir: optionalString(args.flags["artifact-dir"]),
          inputRoot: optionalString(args.flags["input-root"]),
          profile: cliMcpProfile(args.flags.profile, "core")
        };
        const format = optionalString(args.flags.format) ?? "json";
        if (format === "json") {
          result = mcpConfig(options);
        } else if (format === "codex-toml") {
          rawOutput = mcpConfigToml(options);
        } else {
          throw usageError(
            "invalid_format",
            `Unknown mcp-config format: ${format}`,
            "deepseek-harness mcp-config --format codex-toml --profile core"
          );
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
    case "chat": {
      const { chatCommand } = await import("./agent/cli.js");
      await chatCommand({
        sessionId: optionalString(args.flags.resume),
        model: optionalModel(args.flags.model) as string | undefined,
        list: Boolean(args.flags.list),
        prompt: args.positional.length > 0 ? args.positional.join(" ") : undefined,
        plain: Boolean(args.flags.plain),
        tui: Boolean(args.flags.tui),
      });
      return;
    }
    default:
      throw unknownCommandError(args.command);
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
  validateCorpusFlags(corpusArgs);

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
      throw unknownCorpusCommandError(subcommand);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "-h") {
      flags.help = true;
    } else if (value.startsWith("--")) {
      const rawFlag = value.slice(2);
      const equalsIndex = rawFlag.indexOf("=");
      const key = equalsIndex >= 0 ? rawFlag.slice(0, equalsIndex) : rawFlag;
      const inlineValue = equalsIndex >= 0 ? rawFlag.slice(equalsIndex + 1) : undefined;
      if (inlineValue !== undefined) {
        if (BOOLEAN_FLAGS.has(key)) {
          if (inlineValue !== "true" && inlineValue !== "false") {
            throw usageError("invalid_boolean", `Expected true or false for --${key}, got ${inlineValue}.`, "deepseek-harness help");
          }
          flags[key] = inlineValue === "true";
        } else {
          flags[key] = inlineValue;
        }
        continue;
      }
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
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
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError(
      "invalid_manifest_file",
      `Could not read JSON manifest ${filePath}: ${reason}`,
      `deepseek-harness plan ${filePath}`,
      ["Confirm the file exists and contains valid JSON.", `deepseek-harness plan ${filePath}`]
    );
  }
}

function requiredArg(args: ParsedArgs, index: number, label: string): string {
  const value = args.positional[index];
  if (!value) {
    throw usageError("missing_argument", `Missing ${label}.`, "deepseek-harness help");
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
    throw usageError("invalid_number", `Expected a number, got ${value}.`, "deepseek-harness help");
  }
  return parsed;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredStringFlag(args: ParsedArgs, flag: string): string {
  const value = optionalString(args.flags[flag]);
  if (!value) {
    throw usageError("missing_flag", `Missing --${flag}.`, "deepseek-harness help");
  }
  return value;
}

function requiredNumberFlag(args: ParsedArgs, flag: string): number {
  const value = optionalNumber(args.flags[flag]);
  if (value === undefined) {
    throw usageError("missing_flag", `Missing --${flag}.`, "deepseek-harness help");
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
  throw usageError("invalid_workload", `Unknown corpus workload: ${raw}.`, "deepseek-harness corpus --help");
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
  throw usageError("invalid_privacy_lane", `Unknown corpus privacy lane: ${raw}.`, "deepseek-harness corpus --help");
}

function optionalCorpusTransport(value: string | boolean | undefined): TranslationTransport | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }
  if (raw === "fake" || raw === "dry-run" || raw === "deepseek") {
    return raw;
  }
  throw usageError("invalid_transport", `Unknown corpus transport: ${raw}.`, "deepseek-harness corpus --help");
}

function optionalOcrEngine(value: string | boolean | undefined): OcrEngine | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }
  if (raw === "auto" || raw === "macos_vision" || raw === "focr" || raw === "tesseract") {
    return raw;
  }
  throw usageError("invalid_ocr_engine", `Unknown OCR engine: ${raw}.`, "deepseek-harness corpus --help");
}

function optionalNumberList(value: string | boolean | undefined): number[] | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part) || part <= 0 || !Number.isInteger(part))) {
    throw usageError(
      "invalid_concurrency",
      `Expected comma-separated positive integers, got ${value}.`,
      "deepseek-harness scale-ramp examples/basic-run.json --concurrency 5,10,20"
    );
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
  throw usageError("invalid_transport", `Expected fake or dry-run transport, got ${value}.`, "deepseek-harness capabilities");
}

function optionalModel(value: string | boolean | undefined): "deepseek-v4-flash" | "deepseek-v4-pro" | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  if (value === "deepseek-v4-flash" || value === "deepseek-v4-pro") {
    return value;
  }
  throw usageError("invalid_model", `Expected DeepSeek V4 model, got ${value}.`, "deepseek-harness capabilities");
}

function optionalModelList(value: string | boolean | undefined): Array<"deepseek-v4-flash" | "deepseek-v4-pro"> | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  return value.split(",").map((part) => {
    const model = optionalModel(part.trim());
    if (!model) {
      throw usageError("invalid_model", `Expected DeepSeek V4 model, got ${part}.`, "deepseek-harness capabilities");
    }
    return model;
  });
}

function validateCommandFlags(args: ParsedArgs): void {
  if (args.command === "corpus") {
    return;
  }
  const allowed = COMMAND_FLAGS[args.command];
  if (!allowed) {
    return;
  }
  validateFlags(args.flags, allowed, `deepseek-harness ${args.command} --help`);
}

function validateCorpusFlags(args: ParsedArgs): void {
  const allowed = CORPUS_FLAGS[args.command];
  if (!allowed) {
    return;
  }
  validateFlags(args.flags, allowed, `deepseek-harness corpus ${args.command} --help`);
}

function validateFlags(flags: Record<string, string | boolean>, allowed: readonly string[], helpCommand: string): void {
  const supported = [...allowed, "help"];
  for (const flag of Object.keys(flags)) {
    if (supported.includes(flag)) {
      continue;
    }
    const suggestion = closestMatch(flag, supported);
    const corrected = suggestion ? `--${suggestion}` : helpCommand;
    throw usageError(
      "unknown_flag",
      `Unknown flag: --${flag}.${suggestion ? ` Did you mean --${suggestion}?` : ""}`,
      corrected,
      [corrected, helpCommand]
    );
  }
}

function cliMcpProfile(value: string | boolean | undefined, fallback: McpProfile): McpProfile {
  try {
    return parseMcpProfile(optionalString(value), fallback);
  } catch {
    throw usageError(
      "invalid_mcp_profile",
      `Unknown MCP profile: ${String(value)}. Expected core, corpus, or full.`,
      `deepseek-harness mcp-config --profile ${fallback}`
    );
  }
}

function unknownCommandError(command: string) {
  const suggestion = closestMatch(command, COMMANDS);
  const corrected = suggestion ? `deepseek-harness ${suggestion}` : "deepseek-harness help";
  return usageError(
    "unknown_command",
    `Unknown command: ${command || "(missing)"}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
    corrected,
    [corrected, "deepseek-harness capabilities"]
  );
}

function unknownCorpusCommandError(command: string) {
  const suggestion = closestMatch(command, CORPUS_COMMANDS);
  const corrected = suggestion ? `deepseek-harness corpus ${suggestion}` : "deepseek-harness corpus --help";
  return usageError(
    "unknown_corpus_command",
    `Unknown corpus command: ${command || "(missing)"}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
    corrected,
    [corrected, "deepseek-harness corpus --help"]
  );
}

function closestMatch(value: string, choices: readonly string[]): string | undefined {
  if (!value) {
    return undefined;
  }
  const ranked = choices
    .map((choice) => ({ choice, distance: editDistance(value, choice) }))
    .sort((left, right) => left.distance - right.distance || left.choice.localeCompare(right.choice));
  const best = ranked[0];
  return best && best.distance <= Math.max(2, Math.floor(best.choice.length / 3)) ? best.choice : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(toErrorPayload(error), null, 2)}\n`);
  process.exitCode = errorExitCode(error);
});

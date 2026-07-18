import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { observedUsageCost } from "./budget.js";
import { buildCostLedger } from "./cost.js";
import { HarnessError } from "./errors.js";
import {
  defaultArtifactRoot,
  defaultCorpusInputRoot,
  defaultStateDir,
  resolveArtifactOutputPath,
  writeArtifactOutput
} from "./paths.js";
import { classifyManifestPrivacy } from "./privacy.js";
import { HarnessStore, type ItemRecord } from "./store.js";
import {
  assertPlanExecutable,
  buildExecutionPlan,
  parseManifest,
  type ExecutionPlan,
  type RunItem,
  type RunManifest
} from "./schema.js";
import {
  DeepSeekDryRunTransport,
  DeepSeekLiveTransport,
  FakeTransport,
  type CompletionTransport
} from "./transport.js";
import {
  buildAgentCanaryManifest,
  buildFailureCanaryManifest,
  buildWorkloadBenchmarkManifest,
  listWorkloads,
  type LocalTransport
} from "./workloads.js";

export interface HarnessContext {
  stateDir?: string;
  artifactRoot?: string;
}

export interface SubmitOptions {
  start?: boolean;
  allowLive?: boolean;
}

export interface SubmitResult {
  ok: true;
  run_id: string;
  status: string;
  plan: ExecutionPlan;
  summary: Record<string, unknown>;
}

export interface ScaleRampOptions {
  concurrencies?: number[];
  itemCount?: number;
  output?: string;
  allowLive?: boolean;
  allowLiveScale?: boolean;
}

export interface MacroOptions {
  output?: string;
}

export interface WorkloadBenchmarkOptions extends MacroOptions {
  workload?: string;
  items?: number;
  concurrency?: number;
  transport?: LocalTransport;
  model?: RunManifest["model"];
}

export interface CompareModelsOptions extends MacroOptions {
  models?: RunManifest["model"][];
  transport?: LocalTransport;
}

export interface McpConfigOptions {
  command?: string;
  stateDir?: string;
  artifactDir?: string;
  inputRoot?: string;
}

export function createStore(context: HarnessContext = {}): HarnessStore {
  return new HarnessStore(context.stateDir ?? defaultStateDir());
}

export function doctor(context: HarnessContext = {}): Record<string, unknown> {
  const store = createStore(context);
  try {
    return {
      ok: true,
      node: process.version,
      state_dir: store.stateDir,
      db_path: store.dbPath,
      cwd: process.cwd(),
      corpus_input_root: defaultCorpusInputRoot(),
      cli: {
        source_entrypoint: path.resolve(process.cwd(), "dist/src/cli.js"),
        mcp_entrypoint: path.resolve(process.cwd(), "dist/src/mcp.js")
      },
      deepseek_api_key_present: Boolean(process.env.DEEPSEEK_API_KEY),
      signed_receipt_public_key_present: Boolean(process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY),
      live_calls_default: "disabled",
      live_concurrency_cap: 20,
      canonical_state_write: false,
      external_side_effects: false
    };
  } finally {
    store.close();
  }
}

export function mcpConfig(options: McpConfigOptions = {}): Record<string, unknown> {
  const mcpEntrypoint = path.resolve(process.cwd(), "dist/src/mcp.js");
  const command = options.command ? path.resolve(options.command) : process.execPath;
  const args = options.command ? [] : [mcpEntrypoint];
  const stateDir = path.resolve(options.stateDir ?? process.env.DEEPSEEK_HARNESS_STATE_DIR ?? path.join(process.cwd(), ".state"));
  const artifactDir = path.resolve(
    options.artifactDir ?? process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR ?? path.join(process.cwd(), "artifacts")
  );
  const inputRoot = path.resolve(options.inputRoot ?? defaultCorpusInputRoot());

  return {
    mcpServers: {
      "deepseek-harness": {
        command,
        args,
        env: {
          DEEPSEEK_HARNESS_STATE_DIR: stateDir,
          DEEPSEEK_HARNESS_ARTIFACT_DIR: artifactDir,
          DEEPSEEK_HARNESS_INPUT_ROOT: inputRoot
        }
      }
    }
  };
}

export function mcpConfigToml(options: McpConfigOptions = {}): string {
  const config = mcpConfig(options) as {
    mcpServers: {
      "deepseek-harness": {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
    };
  };
  const server = config.mcpServers["deepseek-harness"];

  return [
    "[mcp_servers.deepseek-harness]",
    `args = [${server.args.map(tomlString).join(", ")}]`,
    `command = ${tomlString(server.command)}`,
    "",
    "[mcp_servers.deepseek-harness.env]",
    `DEEPSEEK_HARNESS_STATE_DIR = ${tomlString(server.env.DEEPSEEK_HARNESS_STATE_DIR)}`,
    `DEEPSEEK_HARNESS_ARTIFACT_DIR = ${tomlString(server.env.DEEPSEEK_HARNESS_ARTIFACT_DIR)}`,
    `DEEPSEEK_HARNESS_INPUT_ROOT = ${tomlString(server.env.DEEPSEEK_HARNESS_INPUT_ROOT)}`,
    ""
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function planManifest(input: unknown, options: { allowLive?: boolean } = {}): Record<string, unknown> {
  const manifest = parseManifest(input);
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: options.allowLive,
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
    approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
  });
  return { ok: plan.ok, plan };
}

export async function submitManifest(
  input: unknown,
  context: HarnessContext = {},
  options: SubmitOptions = {}
): Promise<SubmitResult> {
  const manifest = parseManifest(input);
  const plan = buildExecutionPlan(manifest, {
    mode: "queued",
    allowLive: options.allowLive,
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
    approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
  });
  assertPlanExecutable(plan);

  const store = createStore(context);
  try {
    const runId = manifest.run_id ?? randomUUID();
    const artifactRoot = context.artifactRoot ?? defaultArtifactRoot();
    const artifactDir = resolveArtifactOutputPath(artifactRoot, resolveRunArtifactDirectory(artifactRoot, manifest.artifact_dir, runId));
    const manifestWithRunId: RunManifest = { ...manifest, run_id: runId, artifact_dir: artifactDir };
    store.createRun(runId, manifestWithRunId, artifactDir);
    writeArtifactOutput(artifactDir, path.join(artifactDir, "manifest.json"), JSON.stringify(redactReceiptForArtifact(manifestWithRunId), null, 2));

    if (options.start) {
      await processRun(runId, context, { allowLive: options.allowLive });
    }

    return {
      ok: true,
      run_id: runId,
      status: store.getRun(runId).status,
      plan,
      summary: store.summary(runId)
    };
  } finally {
    store.close();
  }
}

export async function processRun(
  runId: string,
  context: HarnessContext = {},
  options: { allowLive?: boolean } = {}
): Promise<Record<string, unknown>> {
  const store = createStore(context);
  try {
    const run = store.getRun(runId);
    if (run.status === "cancelled") {
      return store.summary(runId);
    }
    const plan = buildExecutionPlan(run.manifest, {
      mode: "execute",
      allowLive: options.allowLive,
      apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
      approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
    });
    assertPlanExecutable(plan);

    if (run.manifest.transport === "deepseek") {
      const receipt = run.manifest.approval_receipt;
      const receiptSha256 = plan.approval.receipt_sha256;
      const reservation = plan.budget_reservation;
      if (!receipt || !receiptSha256 || !reservation) {
        throw new HarnessError("live_authority_incomplete", "Signed approval and budget reservation are required");
      }
      try {
        store.authoriseAndReserveLiveRun(
          runId,
          receipt,
          receiptSha256,
          reservation,
          plan.approval.network_payload_sha256
        );
      } catch (error) {
        if (error instanceof HarnessError && error.code === "daily_budget_exhausted") {
          store.markBudgetExhausted(runId, error.code);
          writeResultArtifacts(store, runId);
          return store.summary(runId);
        }
        store.setRunStatus(runId, "failed", error instanceof HarnessError ? error.code : "live_authority_failed");
        writeResultArtifacts(store, runId);
        throw error;
      }
    }

    const transport = selectTransport(run.manifest, options);
    store.setRunStatus(runId, "running");

    await mapLimit(store.queuedItems(runId), run.manifest.concurrency, async (item) => {
      const latestRun = store.getRun(runId);
      if (latestRun.status === "cancelled") {
        return;
      }
      await processItem(store, transport, run.manifest, item);
    });

    const items = store.listItems(runId);
    const failed = items.filter((item) => item.status === "failed");
    const cancelled = items.filter((item) => item.status === "cancelled");
    if (cancelled.length > 0) {
      store.setRunStatus(runId, "cancelled");
    } else if (failed.length > 0) {
      store.setRunStatus(runId, "failed", `${failed.length} item(s) failed`);
    } else {
      store.setRunStatus(runId, "completed");
    }

    if (run.manifest.transport === "deepseek" && run.manifest.approval_receipt) {
      const observedCosts = items.map((item) => observedUsageCost(item.usage, run.manifest.approval_receipt!));
      const charged = observedCosts.every((cost) => cost !== null)
        ? Number(observedCosts.reduce<number>((total, cost) => total + Number(cost), 0).toFixed(8))
        : null;
      store.reconcileBudget(runId, charged);
    }

    writeResultArtifacts(store, runId);
    return store.summary(runId);
  } finally {
    store.close();
  }
}

export function getStatus(runId: string, context: HarnessContext = {}): Record<string, unknown> {
  const store = createStore(context);
  try {
    return { ok: true, summary: store.summary(runId) };
  } finally {
    store.close();
  }
}

export function getResults(runId: string, context: HarnessContext = {}): Record<string, unknown> {
  const store = createStore(context);
  try {
    return { ok: true, summary: store.summary(runId), items: store.listItems(runId) };
  } finally {
    store.close();
  }
}

export function cancelRun(runId: string, context: HarnessContext = {}): Record<string, unknown> {
  const store = createStore(context);
  try {
    const run = store.cancelRun(runId);
    return { ok: true, run_id: run.run_id, status: run.status, summary: store.summary(runId) };
  } finally {
    store.close();
  }
}

export function exportReviewPacket(runId: string, context: HarnessContext = {}): Record<string, unknown> {
  const store = createStore(context);
  try {
    const run = store.getRun(runId);
    const items = store.listItems(runId);
    const costLedger = buildCostLedger(run, items, store.budgetStatus(runId));
    const packet = {
      schema_version: "deepseek-harness.review-packet.v1",
      run: store.summary(runId),
      safety: {
        canonical_writes: false,
        external_side_effects: false,
        external_api_inference: run.manifest.transport === "deepseek",
        approval_receipt_id: run.manifest.approval_receipt?.receipt_id ?? null,
        approval_receipt_consumed: store.budgetStatus(runId) !== null,
        approval_receipt_signature_stored: false,
        egress_class: run.manifest.egress_class,
        cost_cap_usd: run.manifest.cost_cap_usd
      },
      privacy: classifyManifestPrivacy(run.manifest),
      cost_ledger: costLedger,
      items
    };
    const packetPath = resolveArtifactOutputPath(run.artifact_dir, path.join(run.artifact_dir, "review-packet.json"));
    const writtenPacketPath = writeArtifactOutput(run.artifact_dir, packetPath, JSON.stringify(packet, null, 2));
    return { ok: true, path: writtenPacketPath, packet };
  } finally {
    store.close();
  }
}

export function harnessState(context: HarnessContext = {}, options: { limit?: number } = {}): Record<string, unknown> {
  const store = createStore(context);
  try {
    const runs = store.listRuns(options.limit ?? 20).map((run) => store.runSummaryRecord(run));
    return {
      schema_version: "deepseek-harness.state.v1",
      generated_at: new Date().toISOString(),
      authority: {
        canonical_state_write: false,
        command_centre_state_write: false,
        local_workspace_apply: false,
        external_side_effects: false,
        live_deepseek_calls_default: "disabled"
      },
      environment: {
        node: process.version,
        state_dir: store.stateDir,
        db_path: store.dbPath,
        deepseek_api_key_present: Boolean(process.env.DEEPSEEK_API_KEY)
      },
      runs
    };
  } finally {
    store.close();
  }
}

export function exportHarnessState(
  context: HarnessContext = {},
  options: { output?: string; limit?: number } = {}
): Record<string, unknown> {
  const artifactRoot = context.artifactRoot ?? defaultArtifactRoot();
  const output = resolveArtifactOutputPath(
    artifactRoot,
    options.output ?? path.join(artifactRoot, "deepseek-harness-state.json")
  );

  const state = harnessState(context, { limit: options.limit });
  const writtenOutput = writeArtifactOutput(artifactRoot, output, JSON.stringify(state, null, 2));
  return { ok: true, path: writtenOutput, state };
}

export function dispatchProposal(input: unknown, options: { allowLive?: boolean } = {}): Record<string, unknown> {
  const manifest = parseManifest(input);
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: options.allowLive,
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
    approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
  });
  const payloadHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const approvalRequired = manifest.transport === "deepseek" || !plan.ok;

  return {
    schema_version: "deepseek-harness.dispatch-proposal.v1",
    source: "deepseek-harness",
    selected_action: "prepare_deepseek_batch",
    selected_worker: "deepseek-harness",
    payload_hash: payloadHash,
    approval_required: approvalRequired,
    receipt_required: approvalRequired,
    forbidden_authority: [
      "canonical_state_write",
      "command_centre_state_write",
      "local_workspace_apply",
      "github_write",
      "deploy",
      "publish",
      "external_side_effects",
      "self_approval"
    ],
    agentOs: {
      taskId: manifest.run_id ?? null,
      scopeProfile: "draft_and_prepare",
      executionClass: "sandbox_prepare",
      canonicalStateWrite: false,
      commandCentreStateWrite: false,
      requiresMitlReceipt: false,
      requiresOwnerInferenceReceipt: true
    },
    evidence_target: {
      artifact_dir: manifest.artifact_dir ?? null,
      review_packet: manifest.run_id ? `${manifest.run_id}/review-packet.json` : null
    },
    plan
  };
}

export function approvalPacket(input: unknown): Record<string, unknown> {
  const manifest = parseManifest(input);
  const planWithoutLive = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: false,
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
    approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
  });
  const planWithLiveFlag = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: true,
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
    approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
  });

  return {
    schema_version: "deepseek-harness.approval-packet.v1",
    generated_at: new Date().toISOString(),
    project: manifest.project,
    requested_action: "authorise_deepseek_live_micro_smoke_or_batch",
    approval_required: manifest.transport === "deepseek",
    approval_receipt_id: manifest.approval_receipt?.receipt_id ?? null,
    approval_status: planWithLiveFlag.approval.receipt_sha256
      ? planWithLiveFlag.ok
        ? "signed_receipt_valid"
        : "signed_receipt_blocked"
      : "owner_signed_receipt_required",
    provider: {
      base_url: "https://api.deepseek.com",
      model: manifest.model,
      transport: manifest.transport,
      api_key_present: Boolean(process.env.DEEPSEEK_API_KEY)
    },
    data_egress: {
      egress_class: manifest.egress_class,
      allowed_for_external_deepseek: manifest.egress_class === "non_sensitive_bulk",
      item_count: manifest.items.length,
      redaction_attestation_required: true,
      sends_private_sensitive_health_genetics_or_secrets: manifest.egress_class !== "non_sensitive_bulk"
    },
    cost_and_rate: {
      requested_cost_cap_usd: manifest.cost_cap_usd,
      hard_cost_cap_usd: 5,
      requested_concurrency: manifest.concurrency,
      hard_live_concurrency_cap: 20
    },
    authority: {
      canonical_state_write: false,
      command_centre_state_write: false,
      local_workspace_apply: false,
      github_write: false,
      deploy: false,
      publish: false,
      external_side_effects: false
    },
    gates: {
      live_call_requires_cli_allow_live: true,
      live_call_requires_signed_receipt: true,
      live_call_requires_one_use_receipt_consumption: true,
      live_call_requires_api_key: true,
      live_call_requires_max_tokens_and_budget_reservation: true,
      executable_now_if_allow_live_supplied: planWithLiveFlag.ok
    },
    plan_without_live_flag: planWithoutLive,
    plan_with_live_flag: planWithLiveFlag,
    owner_approval_statement:
      "Issue one signed DeepSeek inference receipt for this exact non-sensitive payload and the listed cost and concurrency caps."
  };
}

export function exportApprovalPacket(
  input: unknown,
  context: HarnessContext = {},
  options: { output?: string } = {}
): Record<string, unknown> {
  const packet = approvalPacket(input);
  const project = typeof packet.project === "string" ? packet.project : "deepseek-harness";
  const artifactRoot = context.artifactRoot ?? defaultArtifactRoot();
  const output = resolveArtifactOutputPath(
    artifactRoot,
    options.output ?? path.join(artifactRoot, `${project}-approval-packet.json`)
  );

  const writtenOutput = writeArtifactOutput(artifactRoot, output, JSON.stringify(packet, null, 2));
  return { ok: true, path: writtenOutput, packet };
}

export function privacyCheck(input: unknown): Record<string, unknown> {
  const manifest = parseManifest(input);
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: false,
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
    approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
  });
  return {
    ok: plan.privacy.external_deepseek_allowed,
    project: manifest.project,
    manifest_egress_class: manifest.egress_class,
    privacy: plan.privacy,
    blockers: plan.blockers,
    warnings: plan.warnings
  };
}

export function exportCostLedger(
  runId: string,
  context: HarnessContext = {},
  options: { output?: string } = {}
): Record<string, unknown> {
  const store = createStore(context);
  try {
    const run = store.getRun(runId);
    const ledger = buildCostLedger(run, store.listItems(runId), store.budgetStatus(runId));
    const output = resolveArtifactOutputPath(
      run.artifact_dir,
      options.output ?? path.join(run.artifact_dir, "cost-ledger.json")
    );

    const writtenOutput = writeArtifactOutput(run.artifact_dir, output, JSON.stringify(ledger, null, 2));
    return { ok: true, path: writtenOutput, ledger };
  } finally {
    store.close();
  }
}

export async function agentCanary(
  context: HarnessContext = {},
  options: MacroOptions = {}
): Promise<Record<string, unknown>> {
  const started = performance.now();
  const manifest = buildAgentCanaryManifest();
  const result = await submitManifest(manifest, context, { start: true });
  const review = exportReviewPacket(result.run_id, context) as { path: string };
  const ledger = exportCostLedger(result.run_id, context) as { path: string };
  const elapsedMs = Math.round(performance.now() - started);
  const report = {
    schema_version: "deepseek-harness.agent-canary.v1",
    status: result.status === "completed" ? "ok" : "failed",
    elapsed_ms: elapsedMs,
    run_id: result.run_id,
    summary: result.summary,
    artefacts: {
      review_packet: review.path,
      cost_ledger: ledger.path
    },
    authority: localMacroAuthority()
  };

  const output = options.output ? writeMacroReport(options.output, report, context.artifactRoot ?? defaultArtifactRoot()) : null;
  return { ok: report.status === "ok", path: output, report };
}

export async function workloadBenchmark(
  context: HarnessContext = {},
  options: WorkloadBenchmarkOptions = {}
): Promise<Record<string, unknown>> {
  const manifest = buildWorkloadBenchmarkManifest({
    workload: options.workload,
    items: options.items,
    concurrency: options.concurrency,
    transport: options.transport,
    model: options.model
  });
  const started = performance.now();
  const result = await submitManifest(manifest, context, { start: true });
  const elapsedMs = Math.round(performance.now() - started);
  const review = exportReviewPacket(result.run_id, context) as { path: string };
  const ledger = exportCostLedger(result.run_id, context) as { path: string };
  const itemCount = Number(result.summary.item_count ?? manifest.items.length);
  const report = {
    schema_version: "deepseek-harness.workload-benchmark.v1",
    status: result.status === "completed" ? "ok" : "failed",
    workload: manifest.workload_profile,
    elapsed_ms: elapsedMs,
    items_per_second: elapsedMs > 0 ? Number((itemCount / (elapsedMs / 1000)).toFixed(2)) : null,
    run_id: result.run_id,
    summary: result.summary,
    artefacts: {
      review_packet: review.path,
      cost_ledger: ledger.path
    },
    available_workloads: listWorkloads(),
    authority: localMacroAuthority()
  };

  const output = options.output ? writeMacroReport(options.output, report, context.artifactRoot ?? defaultArtifactRoot()) : null;
  return { ok: report.status === "ok", path: output, report };
}

export async function failureCanary(
  context: HarnessContext = {},
  options: MacroOptions = {}
): Promise<Record<string, unknown>> {
  const manifest = buildFailureCanaryManifest();
  const result = await submitManifest(manifest, context, { start: true });
  const review = exportReviewPacket(result.run_id, context) as { path: string };
  const ledger = exportCostLedger(result.run_id, context) as { path: string };
  const counts = result.summary.counts as Record<string, number> | undefined;
  const expectedFailureObserved = result.status === "failed" && counts?.failed === 1 && counts.completed === 3;
  const report = {
    schema_version: "deepseek-harness.failure-canary.v1",
    status: expectedFailureObserved ? "ok" : "failed",
    expected_run_status: "failed",
    run_id: result.run_id,
    summary: result.summary,
    artefacts: {
      review_packet: review.path,
      cost_ledger: ledger.path
    },
    authority: localMacroAuthority()
  };

  const output = options.output ? writeMacroReport(options.output, report, context.artifactRoot ?? defaultArtifactRoot()) : null;
  return { ok: expectedFailureObserved, path: output, report };
}

export function modelComparisonPlan(
  input: unknown,
  options: CompareModelsOptions = {}
): Record<string, unknown> {
  const manifest = parseManifest(input);
  const models = options.models ?? ["deepseek-v4-flash", "deepseek-v4-pro"];
  const transport = options.transport ?? "dry-run";
  const candidates = models.map((model) => {
    const candidate: RunManifest = {
      ...manifest,
      run_id: undefined,
      project: `${manifest.project}-${model}`,
      transport,
      model,
      approval_id: undefined,
      approval_receipt: undefined
    };
    const plan = buildExecutionPlan(candidate, {
      mode: "plan",
      allowLive: false,
      apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
      approvalPublicKey: process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY
    });
    return { model, manifest: candidate, plan };
  });
  const report = {
    schema_version: "deepseek-harness.model-comparison-plan.v1",
    source_project: manifest.project,
    live_execution: false,
    transport,
    candidates,
    recommendation: {
      default_model: "deepseek-v4-flash",
      route: "Use fake or dry-run comparison first; promote a single non-sensitive winner to live only with an approval packet."
    },
    authority: localMacroAuthority()
  };

  const output = options.output ? writeMacroReport(options.output, report, defaultArtifactRoot()) : null;
  return { ok: candidates.every((candidate) => candidate.plan.ok), path: output, report };
}

export async function scaleRamp(
  input: unknown,
  context: HarnessContext = {},
  options: ScaleRampOptions = {}
): Promise<Record<string, unknown>> {
  const manifest = parseManifest(input);
  const concurrencies = options.concurrencies ?? [5, 10, 20];
  const itemCount = options.itemCount ?? Math.max(manifest.items.length, 40);
  const startedAt = new Date().toISOString();

  if (manifest.transport === "deepseek" && !options.allowLiveScale) {
    throw new HarnessError(
      "live_scale_requires_allow_live_scale",
      "Live DeepSeek scale ramp requires the separate allow-live-scale gate after DSH-07 live smoke approval"
    );
  }

  const artifactRoot = context.artifactRoot ?? defaultArtifactRoot();
  const output = resolveArtifactOutputPath(
    artifactRoot,
    options.output ?? path.join(artifactRoot, `scale-ramp-${Date.now()}.json`)
  );

  const runs = [];
  for (const concurrency of concurrencies) {
    const rampManifest: RunManifest = {
      ...manifest,
      run_id: undefined,
      project: `${manifest.project}-ramp-c${concurrency}`,
      concurrency,
      items: expandItems(manifest.items, itemCount)
    };
    const started = performance.now();
    const result = await submitManifest(rampManifest, context, {
      start: true,
      allowLive: Boolean(options.allowLive && options.allowLiveScale)
    });
    const elapsedMs = Math.round(performance.now() - started);
    runs.push({
      concurrency,
      run_id: result.run_id,
      status: result.status,
      item_count: itemCount,
      elapsed_ms: elapsedMs,
      items_per_second: elapsedMs > 0 ? Number((itemCount / (elapsedMs / 1000)).toFixed(2)) : null,
      summary: result.summary
    });
  }

  const completedRuns = runs.filter((run) => run.status === "completed").length;
  const fastest = [...runs]
    .filter((run) => typeof run.items_per_second === "number")
    .sort((a, b) => Number(b.items_per_second) - Number(a.items_per_second))[0] ?? null;
  const report = {
    schema_version: "deepseek-harness.scale-ramp.v1",
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    authority: {
      canonical_state_write: false,
      command_centre_state_write: false,
      local_workspace_apply: false,
      external_side_effects: false,
      live_scale_requires_allow_live_scale: true
    },
    input: {
      source_project: manifest.project,
      transport: manifest.transport,
      model: manifest.model,
      requested_concurrencies: concurrencies,
      item_count: itemCount,
      allow_live: Boolean(options.allowLive),
      allow_live_scale: Boolean(options.allowLiveScale)
    },
    result: {
      status: completedRuns === runs.length ? "ok" : "partial",
      completed_runs: completedRuns,
      total_runs: runs.length,
      recommended_next_concurrency: fastest?.concurrency ?? null
    },
    runs
  };

  const writtenOutput = writeArtifactOutput(artifactRoot, output, JSON.stringify(report, null, 2));
  return { ok: true, path: writtenOutput, report };
}

async function processItem(
  store: HarnessStore,
  transport: CompletionTransport,
  manifest: RunManifest,
  item: ItemRecord
): Promise<void> {
  store.markItemRunning(item.run_id, item.item_id);
  try {
    const inputItem = item.input as RunItem;
    const injectedFailure = injectedFailureMessage(manifest, inputItem);
    if (injectedFailure) {
      throw new Error(injectedFailure);
    }
    const result = await transport.complete(manifest, inputItem);
    store.completeItem(item.run_id, item.item_id, { content: result.content, raw: result.raw }, result.usage);
  } catch (error) {
    store.failItem(item.run_id, item.item_id, error instanceof Error ? error.message : String(error));
  }
}

function selectTransport(manifest: RunManifest, options: { allowLive?: boolean }): CompletionTransport {
  if (manifest.transport === "fake") {
    return new FakeTransport();
  }
  if (manifest.transport === "dry-run") {
    return new DeepSeekDryRunTransport();
  }
  if (!options.allowLive) {
    throw new HarnessError("live_deepseek_call_not_enabled_by_caller", "Live DeepSeek transport requires allowLive");
  }
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new HarnessError("deepseek_api_key_not_present", "DEEPSEEK_API_KEY is required for live DeepSeek transport");
  }
  return new DeepSeekLiveTransport(apiKey);
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const active = new Set<Promise<void>>();
  for (const item of items) {
    const promise = worker(item).finally(() => active.delete(promise));
    active.add(promise);
    if (active.size >= limit) {
      await Promise.race(active);
    }
  }
  await Promise.allSettled(active);
}

function writeResultArtifacts(store: HarnessStore, runId: string): void {
  const run = store.getRun(runId);
  const items = store.listItems(runId);
  const costLedger = buildCostLedger(run, items, store.budgetStatus(runId));
  writeArtifactOutput(run.artifact_dir, path.join(run.artifact_dir, "summary.json"), JSON.stringify(store.summary(runId), null, 2));
  writeArtifactOutput(run.artifact_dir, path.join(run.artifact_dir, "cost-ledger.json"), JSON.stringify(costLedger, null, 2));
  writeArtifactOutput(run.artifact_dir, path.join(run.artifact_dir, "results.jsonl"), items.map((item) => JSON.stringify(item)).join("\n") + "\n");
}

function injectedFailureMessage(manifest: RunManifest, item: RunItem): string | null {
  const injection = manifest.failure_injection;
  if (!injection) {
    return null;
  }
  const message = injection.error_message ?? "Injected local failure";
  if (injection.fail_item_ids?.includes(item.id)) {
    return message;
  }
  if (!injection.fail_every_n) {
    return null;
  }
  const suffix = item.id.match(/(\d+)$/)?.[1];
  if (suffix && Number(suffix) % injection.fail_every_n === 0) {
    return message;
  }
  return null;
}

function writeMacroReport(output: string, report: unknown, artifactRoot: string): string {
  return writeArtifactOutput(artifactRoot, output, JSON.stringify(report, null, 2));
}

function resolveRunArtifactDirectory(artifactRoot: string, requested: string | undefined, runId: string): string {
  if (!requested) {
    return path.join(artifactRoot, runId);
  }
  if (path.isAbsolute(requested)) {
    return requested;
  }
  const segments = requested.split(/[\\/]+/).filter(Boolean);
  return path.join(artifactRoot, ...(segments[0] === "artifacts" ? segments.slice(1) : segments));
}

function localMacroAuthority(): Record<string, boolean | string> {
  return {
    canonical_state_write: false,
    command_centre_state_write: false,
    local_workspace_apply: false,
    github_write: false,
    deploy: false,
    publish: false,
    send: false,
    external_api_calls: false,
    transport: "fake_or_dry_run_only"
  };
}

function redactReceiptForArtifact(manifest: RunManifest): RunManifest {
  if (!manifest.approval_receipt) {
    return manifest;
  }
  return {
    ...manifest,
    approval_receipt: {
      ...manifest.approval_receipt,
      signature_base64: "[signed-receipt-redacted]"
    }
  };
}

function expandItems(items: RunManifest["items"], itemCount: number): RunManifest["items"] {
  return Array.from({ length: itemCount }, (_, index) => {
    const source = items[index % items.length];
    const round = Math.floor(index / items.length) + 1;
    return {
      ...source,
      id: `${source.id}-r${round}-i${index + 1}`
    };
  });
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessError } from "./errors.js";
import { defaultArtifactRoot, defaultStateDir } from "./paths.js";
import { HarnessStore, type ItemRecord } from "./store.js";
import {
  assertPlanExecutable,
  buildExecutionPlan,
  parseManifest,
  type ExecutionPlan,
  type RunManifest
} from "./schema.js";
import {
  DeepSeekDryRunTransport,
  DeepSeekLiveTransport,
  FakeTransport,
  type CompletionTransport
} from "./transport.js";

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
      deepseek_api_key_present: Boolean(process.env.DEEPSEEK_API_KEY),
      live_calls_default: "disabled",
      live_concurrency_cap: 20,
      canonical_state_write: false,
      external_side_effects: false
    };
  } finally {
    store.close();
  }
}

export function planManifest(input: unknown, options: { allowLive?: boolean } = {}): Record<string, unknown> {
  const manifest = parseManifest(input);
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: options.allowLive,
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY)
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
    apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY)
  });
  assertPlanExecutable(plan);

  const store = createStore(context);
  try {
    const runId = manifest.run_id ?? randomUUID();
    const artifactRoot = context.artifactRoot ?? defaultArtifactRoot();
    const artifactDir = path.resolve(manifest.artifact_dir ?? path.join(artifactRoot, runId));
    const manifestWithRunId: RunManifest = { ...manifest, run_id: runId, artifact_dir: artifactDir };
    store.createRun(runId, manifestWithRunId, artifactDir);
    fs.writeFileSync(path.join(artifactDir, "manifest.json"), JSON.stringify(manifestWithRunId, null, 2));

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
      apiKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY)
    });
    assertPlanExecutable(plan);

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
    const packet = {
      schema_version: "deepseek-harness.review-packet.v1",
      run: store.summary(runId),
      safety: {
        canonical_writes: false,
        external_side_effects: false,
        external_api_inference: run.manifest.transport === "deepseek",
        approval_id: run.manifest.approval_id ?? null,
        egress_class: run.manifest.egress_class,
        cost_cap_usd: run.manifest.cost_cap_usd
      },
      items
    };
    const packetPath = path.join(run.artifact_dir, "review-packet.json");
    fs.mkdirSync(run.artifact_dir, { recursive: true });
    fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2));
    return { ok: true, path: packetPath, packet };
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
  const output = path.resolve(options.output ?? path.join(context.artifactRoot ?? defaultArtifactRoot(), "deepseek-harness-state.json"));
  if (isCommandCentreStatePath(output)) {
    throw new HarnessError(
      "command_centre_state_write_blocked",
      "Harness must not write Command Centre/_state directly; route this through Agent OS"
    );
  }

  const state = harnessState(context, { limit: options.limit });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(state, null, 2));
  return { ok: true, path: output, state };
}

async function processItem(
  store: HarnessStore,
  transport: CompletionTransport,
  manifest: RunManifest,
  item: ItemRecord
): Promise<void> {
  store.markItemRunning(item.run_id, item.item_id);
  try {
    const result = await transport.complete(manifest, item.input as RunManifest["items"][number]);
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
  fs.mkdirSync(run.artifact_dir, { recursive: true });
  fs.writeFileSync(path.join(run.artifact_dir, "summary.json"), JSON.stringify(store.summary(runId), null, 2));
  fs.writeFileSync(
    path.join(run.artifact_dir, "results.jsonl"),
    items.map((item) => JSON.stringify(item)).join("\n") + "\n"
  );
}

function isCommandCentreStatePath(filePath: string): boolean {
  const normalised = filePath.split(path.sep).join("/");
  return normalised.includes("/Documents/Obsidian/Command Centre/_state/");
}

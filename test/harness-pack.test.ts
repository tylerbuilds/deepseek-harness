import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentCanary,
  exportReviewPacket,
  failureCanary,
  modelComparisonPlan,
  privacyCheck,
  submitManifest,
  workloadBenchmark
} from "../src/runner.js";

function tempContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-pack-"));
  return {
    root,
    context: {
      stateDir: path.join(root, ".state"),
      artifactRoot: path.join(root, "artifacts")
    }
  };
}

test("privacy checker blocks credential values without returning matched text", () => {
  const report = privacyCheck({
    schema_version: "deepseek-harness.run.v1",
    project: "privacy-unit",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    concurrency: 2,
    cost_cap_usd: 0.05,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: ["api", "_key", " = ", "abcDEF0123456789", "abcDEF0123456789"].join("") }]
  }) as {
    ok: boolean;
    privacy: { recommended_egress_class: string; findings: Array<{ signal: string }> };
    blockers: string[];
  };

  assert.equal(report.ok, false);
  assert.equal(report.privacy.recommended_egress_class, "secrets_or_credentials");
  assert.equal(report.privacy.findings.some((finding) => finding.signal === "credential_assignment"), true);
  assert.equal(JSON.stringify(report).includes("abcDEF0123456789"), false);
  assert.equal(report.blockers.includes("privacy_classifier_blocks_external_deepseek"), true);
});

test("privacy checker warns on credential discussion without inventing a secret", () => {
  const report = privacyCheck({
    schema_version: "deepseek-harness.run.v1",
    project: "privacy-discussion",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    concurrency: 1,
    cost_cap_usd: 0.01,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "Explain why API keys should not appear in logs." }]
  }) as { privacy: { external_deepseek_allowed: boolean; findings: Array<{ signal: string; severity: string }> } };

  assert.equal(report.privacy.external_deepseek_allowed, true);
  assert.equal(report.privacy.findings.some((finding) => finding.signal === "credential_discussion" && finding.severity === "warning"), true);
});

test("writes golden artefacts including cost ledger and review packet ledger", async () => {
  const { context } = tempContext();
  const result = await submitManifest(
    {
      schema_version: "deepseek-harness.run.v1",
      project: "golden-unit",
      egress_class: "non_sensitive_bulk",
      transport: "fake",
      model: "deepseek-v4-flash",
      concurrency: 2,
      cost_cap_usd: 0.05,
      canonical_writes: false,
      external_side_effects: false,
      items: [
        { id: "a", prompt: "hello" },
        { id: "b", prompt: "world" }
      ]
    },
    context,
    { start: true }
  );

  const artifactDir = result.summary.artifact_dir as string;
  assert.equal(fs.existsSync(path.join(artifactDir, "summary.json")), true);
  assert.equal(fs.existsSync(path.join(artifactDir, "results.jsonl")), true);
  assert.equal(fs.existsSync(path.join(artifactDir, "cost-ledger.json")), true);

  const ledger = JSON.parse(fs.readFileSync(path.join(artifactDir, "cost-ledger.json"), "utf8")) as {
    schema_version: string;
    observed_usage: { items_with_usage: number };
  };
  assert.equal(ledger.schema_version, "deepseek-harness.cost-ledger.v1");
  assert.equal(ledger.observed_usage.items_with_usage, 2);

  const packet = exportReviewPacket(result.run_id, context) as {
    packet: { cost_ledger: { schema_version: string }; privacy: { schema_version: string } };
  };
  assert.equal(packet.packet.cost_ledger.schema_version, "deepseek-harness.cost-ledger.v1");
  assert.equal(packet.packet.privacy.schema_version, "deepseek-harness.privacy-report.v1");
});

test("runs agent canary and workload benchmark macros locally", async () => {
  const { root, context } = tempContext();
  const canary = await agentCanary(context, { output: path.join(root, "artifacts", "agent-canary.json") }) as {
    ok: boolean;
    path: string;
    report: { status: string; artefacts: { review_packet: string; cost_ledger: string } };
  };
  assert.equal(canary.ok, true);
  assert.equal(canary.report.status, "ok");
  assert.equal(fs.existsSync(canary.path), true);
  assert.equal(fs.existsSync(canary.report.artefacts.review_packet), true);
  assert.equal(fs.existsSync(canary.report.artefacts.cost_ledger), true);

  const benchmark = await workloadBenchmark(context, {
    workload: "extraction",
    items: 5,
    concurrency: 2,
    output: path.join(root, "artifacts", "benchmark.json")
  }) as {
    ok: boolean;
    report: { status: string; workload: string; summary: { item_count: number }; available_workloads: Array<{ name: string }> };
  };
  assert.equal(benchmark.ok, true);
  assert.equal(benchmark.report.status, "ok");
  assert.equal(benchmark.report.workload, "extraction");
  assert.equal(benchmark.report.summary.item_count, 5);
  assert.equal(benchmark.report.available_workloads.some((workload) => workload.name === "second_opinion"), true);
});

test("failure canary proves partial failure handling", async () => {
  const { root, context } = tempContext();
  const result = await failureCanary(context, { output: path.join(root, "artifacts", "failure.json") }) as {
    ok: boolean;
    report: { status: string; summary: { status: string; counts: Record<string, number> } };
  };

  assert.equal(result.ok, true);
  assert.equal(result.report.status, "ok");
  assert.equal(result.report.summary.status, "failed");
  assert.equal(result.report.summary.counts.failed, 1);
  assert.equal(result.report.summary.counts.completed, 3);
});

test("model comparison prepares dry-run candidates without live authority", () => {
  const plan = modelComparisonPlan({
    schema_version: "deepseek-harness.run.v1",
    project: "compare-unit",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    concurrency: 2,
    cost_cap_usd: 0.05,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "Compare this safe public prompt." }]
  }) as {
    ok: boolean;
    report: {
      live_execution: boolean;
      candidates: Array<{ model: string; manifest: { transport: string }; plan: { ok: boolean } }>;
    };
  };

  assert.equal(plan.ok, true);
  assert.equal(plan.report.live_execution, false);
  assert.deepEqual(plan.report.candidates.map((candidate) => candidate.model), [
    "deepseek-v4-flash",
    "deepseek-v4-pro"
  ]);
  assert.equal(plan.report.candidates.every((candidate) => candidate.manifest.transport === "dry-run"), true);
});

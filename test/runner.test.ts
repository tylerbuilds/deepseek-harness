import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exportApprovalPacket,
  exportHarnessState,
  exportReviewPacket,
  getResults,
  mcpConfig,
  mcpConfigToml,
  scaleRamp,
  submitManifest
} from "../src/runner.js";

test("submits and runs fake batch with SQLite state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-"));
  const manifest = {
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "fake",
    model: "deepseek-v4-flash",
    concurrency: 3,
    cost_cap_usd: 0.1,
    canonical_writes: false,
    external_side_effects: false,
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `item-${index + 1}`,
      prompt: `Prompt ${index + 1}`
    }))
  };

  const result = await submitManifest(manifest, {
    stateDir: path.join(root, ".state"),
    artifactRoot: path.join(root, "artifacts")
  }, { start: true });

  assert.equal(result.status, "completed");
  const results = getResults(result.run_id, { stateDir: path.join(root, ".state") }) as {
    items: Array<{ status: string }>;
  };
  assert.equal(results.items.length, 12);
  assert.equal(results.items.every((item) => item.status === "completed"), true);

  const packet = exportReviewPacket(result.run_id, { stateDir: path.join(root, ".state") }) as { path: string };
  assert.equal(fs.existsSync(packet.path), true);

  const statePath = path.join(root, "artifacts", "state.json");
  const state = exportHarnessState(
    { stateDir: path.join(root, ".state"), artifactRoot: path.join(root, "artifacts") },
    { output: statePath }
  ) as { path: string; state: { runs: unknown[] } };
  assert.equal(state.path, statePath);
  assert.equal(state.state.runs.length, 1);
});

test("blocks direct Command Centre state writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-"));
  assert.throws(
    () =>
      exportHarnessState(
        { stateDir: path.join(root, ".state") },
        { output: "/Users/tyler/Documents/Obsidian/Command Centre/_state/deepseek-harness.json" }
      ),
    /Command Centre\/_state/
  );
});

test("builds no-secret MCP config snippets", () => {
  const command = "/tmp/deepseek-harness-mcp";
  const stateDir = "/tmp/deepseek-harness-state";
  const artifactDir = "/tmp/deepseek-harness-artifacts";
  const json = mcpConfig({ command, stateDir, artifactDir }) as {
    mcpServers: {
      "deepseek-harness": {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
    };
  };

  assert.equal(json.mcpServers["deepseek-harness"].command, command);
  assert.deepEqual(json.mcpServers["deepseek-harness"].args, []);
  assert.equal(json.mcpServers["deepseek-harness"].env.DEEPSEEK_HARNESS_STATE_DIR, stateDir);
  assert.equal(json.mcpServers["deepseek-harness"].env.DEEPSEEK_HARNESS_ARTIFACT_DIR, artifactDir);
  assert.equal(JSON.stringify(json).includes("DEEPSEEK_API_KEY"), false);

  const defaultJson = mcpConfig() as {
    mcpServers: {
      "deepseek-harness": {
        command: string;
        args: string[];
      };
    };
  };
  assert.equal(defaultJson.mcpServers["deepseek-harness"].command, process.execPath);
  assert.match(defaultJson.mcpServers["deepseek-harness"].args[0], /dist\/src\/mcp\.js$/);

  const toml = mcpConfigToml({ command, stateDir, artifactDir });
  assert.match(toml, /\[mcp_servers\.deepseek-harness\]/);
  assert.match(toml, /command = "\/tmp\/deepseek-harness-mcp"/);
  assert.match(toml, /\[mcp_servers\.deepseek-harness\.env\]/);
  assert.equal(toml.includes("DEEPSEEK_API_KEY"), false);
});

test("exports approval packet artefact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-"));
  const output = path.join(root, "approval.json");
  const result = exportApprovalPacket(
    {
      schema_version: "deepseek-harness.run.v1",
      project: "unit",
      egress_class: "non_sensitive_bulk",
      transport: "deepseek",
      model: "deepseek-v4-flash",
      concurrency: 2,
      cost_cap_usd: 0.05,
      canonical_writes: false,
      external_side_effects: false,
      items: [{ id: "a", prompt: "hello" }]
    },
    {},
    { output }
  ) as { path: string };

  assert.equal(result.path, output);
  assert.equal(fs.existsSync(output), true);
});

test("runs local scale ramp and writes report", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-"));
  const output = path.join(root, "scale-ramp.json");
  const result = await scaleRamp(
    {
      schema_version: "deepseek-harness.run.v1",
      project: "unit",
      egress_class: "non_sensitive_bulk",
      transport: "fake",
      model: "deepseek-v4-flash",
      concurrency: 2,
      cost_cap_usd: 0.05,
      canonical_writes: false,
      external_side_effects: false,
      items: [{ id: "a", prompt: "hello" }]
    },
    {
      stateDir: path.join(root, ".state"),
      artifactRoot: path.join(root, "artifacts")
    },
    {
      concurrencies: [2, 4],
      itemCount: 8,
      output
    }
  ) as { path: string; report: { result: { status: string }; runs: unknown[] } };

  assert.equal(result.path, output);
  assert.equal(result.report.result.status, "ok");
  assert.equal(result.report.runs.length, 2);
  assert.equal(fs.existsSync(output), true);
});

test("blocks live DeepSeek scale without explicit scale gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-"));
  await assert.rejects(
    () =>
      scaleRamp(
        {
          schema_version: "deepseek-harness.run.v1",
          project: "unit",
          egress_class: "non_sensitive_bulk",
          transport: "deepseek",
          model: "deepseek-v4-flash",
          concurrency: 2,
          cost_cap_usd: 0.05,
          approval_id: "approval-real-123",
          canonical_writes: false,
          external_side_effects: false,
          items: [{ id: "a", prompt: "hello" }]
        },
        {
          stateDir: path.join(root, ".state"),
          artifactRoot: path.join(root, "artifacts")
        },
        {
          concurrencies: [2],
          itemCount: 2,
          allowLive: true
        }
      ),
    /allow-live-scale/
  );
});

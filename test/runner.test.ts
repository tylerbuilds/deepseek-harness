import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportHarnessState, exportReviewPacket, getResults, submitManifest } from "../src/runner.js";

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

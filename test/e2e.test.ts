import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

function e2eRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-e2e-"));
}

async function runCli(root: string, args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, ["dist/src/cli.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPSEEK_HARNESS_STATE_DIR: path.join(root, ".state"),
      DEEPSEEK_HARNESS_ARTIFACT_DIR: path.join(root, "artifacts")
    },
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("e2e CLI runs fake batch, exports review packet, ledger and state", async () => {
  const root = e2eRoot();

  const plan = await runCli(root, ["plan", "examples/basic-run.json"]);
  assert.equal(plan.ok, true);

  const submit = await runCli(root, ["submit", "examples/basic-run.json", "--start"]) as {
    run_id: string;
    status: string;
    summary: { artifact_dir: string; counts: Record<string, number> };
  };
  assert.equal(submit.status, "completed");
  assert.equal(submit.summary.counts.completed, 2);
  assert.equal(fs.existsSync(path.join(submit.summary.artifact_dir, "summary.json")), true);
  assert.equal(fs.existsSync(path.join(submit.summary.artifact_dir, "results.jsonl")), true);
  assert.equal(fs.existsSync(path.join(submit.summary.artifact_dir, "cost-ledger.json")), true);

  const review = await runCli(root, ["export-review-packet", submit.run_id]) as {
    path: string;
    packet: { cost_ledger: { schema_version: string }; privacy: { schema_version: string } };
  };
  assert.equal(fs.existsSync(review.path), true);
  assert.equal(review.packet.cost_ledger.schema_version, "deepseek-harness.cost-ledger.v1");
  assert.equal(review.packet.privacy.schema_version, "deepseek-harness.privacy-report.v1");

  const ledger = await runCli(root, ["cost-ledger", submit.run_id]) as {
    ledger: { observed_usage: { items_with_usage: number } };
  };
  assert.equal(ledger.ledger.observed_usage.items_with_usage, 2);

  const statePath = path.join(root, "state.json");
  const state = await runCli(root, ["state", "--output", statePath]) as {
    path: string;
    state: { runs: Array<{ run_id: string; status: string }> };
  };
  assert.equal(state.path, statePath);
  assert.equal(state.state.runs.some((run) => run.run_id === submit.run_id && run.status === "completed"), true);
});

test("e2e MCP runs workload benchmark through stdio server", async () => {
  const root = e2eRoot();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPSEEK_HARNESS_STATE_DIR: path.join(root, ".state"),
      DEEPSEEK_HARNESS_ARTIFACT_DIR: path.join(root, "artifacts")
    }
  });
  const client = new Client(
    {
      name: "deepseek-harness-e2e",
      version: "0.1.0"
    },
    {
      capabilities: {}
    }
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "deepseek_harness_workload_benchmark"), true);

    const output = path.join(root, "mcp-workload-benchmark.json");
    const response = await client.callTool({
      name: "deepseek_harness_workload_benchmark",
      arguments: {
        workload: "classification",
        items: 4,
        concurrency: 2,
        output
      }
    });
    const payload = parseMcpJson(response) as {
      ok: boolean;
      path: string;
      report: {
        status: string;
        run_id: string;
        summary: { counts: Record<string, number> };
        artefacts: { review_packet: string; cost_ledger: string };
      };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.path, output);
    assert.equal(payload.report.status, "ok");
    assert.equal(payload.report.summary.counts.completed, 4);
    assert.equal(fs.existsSync(payload.report.artefacts.review_packet), true);
    assert.equal(fs.existsSync(payload.report.artefacts.cost_ledger), true);

    const status = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_status",
        arguments: { run_id: payload.report.run_id }
      })
    ) as { summary: { status: string } };
    assert.equal(status.summary.status, "completed");
  } finally {
    await client.close();
  }
});

function parseMcpJson(response: unknown): unknown {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error("MCP response did not include text content");
  }
  return JSON.parse(text);
}

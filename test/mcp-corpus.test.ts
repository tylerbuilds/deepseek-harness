import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function testRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-mcp-corpus-"));
}

test("MCP exposes and runs local corpus job tools", async () => {
  const root = testRoot();
  const artifactRoot = path.join(root, "artifacts");
  const artifactDir = path.join(artifactRoot, "corpus", "mcp-corpus-job");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPSEEK_HARNESS_STATE_DIR: path.join(root, ".state"),
      DEEPSEEK_HARNESS_ARTIFACT_DIR: artifactRoot,
      DEEPSEEK_HARNESS_INPUT_ROOT: root
    }
  });
  const client = new Client(
    {
      name: "deepseek-harness-mcp-corpus-test",
      version: "0.0.1"
    },
    {
      capabilities: {}
    }
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const name of [
      "deepseek_harness_corpus_ingest_text",
      "deepseek_harness_corpus_ingest_jsonl",
      "deepseek_harness_corpus_ingest_ocr",
      "deepseek_harness_corpus_ingest_media",
      "deepseek_harness_corpus_ingest_translation",
      "deepseek_harness_corpus_ingest_book",
      "deepseek_harness_corpus_ingest_longform",
      "deepseek_harness_corpus_plan",
      "deepseek_harness_corpus_approval_packet",
      "deepseek_harness_corpus_start",
      "deepseek_harness_corpus_status",
      "deepseek_harness_corpus_resume",
      "deepseek_harness_corpus_validate",
      "deepseek_harness_corpus_work",
      "deepseek_harness_corpus_reconcile",
      "deepseek_harness_corpus_cancel",
      "deepseek_harness_corpus_translation_review_packet",
      "deepseek_harness_corpus_commit_translation_memory",
      "deepseek_harness_corpus_supervise"
    ]) {
      assert.equal(toolNames.has(name), true, `${name} should be registered`);
    }

    const jsonlPath = path.join(root, "records.jsonl");
    fs.writeFileSync(jsonlPath, '{"id":1}\n{"id":2}\n');
    const ingested = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_ingest_jsonl",
        arguments: { project: "MCP dataset smoke", source_path: jsonlPath, records_per_shard: 1 }
      })
    ) as { ok: boolean; manifest: { workload_type: string; shards: Array<{ bounds: { row_start: number; row_end: number } }> } };
    assert.equal(ingested.ok, true);
    assert.equal(ingested.manifest.workload_type, "dataset_transform");
    assert.deepEqual(
      ingested.manifest.shards.map((shard) => [shard.bounds.row_start, shard.bounds.row_end]),
      [
        [1, 1],
        [2, 2]
      ]
    );

    const textIngested = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_ingest_text",
        arguments: { project: "MCP generic text", source_path: jsonlPath, chunk_chars: 100 }
      })
    ) as { ok: boolean; manifest: { workload_type: string } };
    assert.equal(textIngested.ok, true);
    assert.equal(textIngested.manifest.workload_type, "mixed");

    const manifest = {
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "mcp-corpus-job",
      project: "MCP corpus smoke",
      workload_type: "book_reading",
      privacy_lane: "local_only",
      artifact_dir: artifactDir,
      sources: [{ id: "source-1", type: "text" }],
      shards: [
        {
          id: "shard-1",
          source_id: "source-1",
          inline_text: "The corpus MCP boundary stays local.",
          bounds: { chapter: 1 }
        }
      ]
    };

    const planned = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_plan",
        arguments: { manifest }
      })
    ) as { ok: boolean; blockers: string[] };
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.blockers, []);

    const start = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_start",
        arguments: { manifest }
      })
    ) as { ok: boolean; summary: { status: string; counts: Record<string, number> } };
    assert.equal(start.ok, true);
    assert.equal(start.summary.status, "completed");
    assert.equal(start.summary.counts.succeeded, 1);

    const status = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_status",
        arguments: { job_id: "mcp-corpus-job", artifact_dir: artifactDir }
      })
    ) as { ok: boolean; summary: { status: string } };
    assert.equal(status.ok, true);
    assert.equal(status.summary.status, "completed");

    const resumed = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_resume",
        arguments: { job_id: "mcp-corpus-job", artifact_dir: artifactDir }
      })
    ) as { ok: boolean; summary: { status: string } };
    assert.equal(resumed.ok, true);
    assert.equal(resumed.summary.status, "completed");

    const validation = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_validate",
        arguments: { job_id: "mcp-corpus-job", artifact_dir: artifactDir }
      })
    ) as { ok: boolean; blockers: string[] };
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.blockers, []);

    const worked = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_work",
        arguments: { job_id: "mcp-corpus-job", artifact_dir: artifactDir, max_iterations: 2 }
      })
    ) as { ok: boolean; worker: { terminal: boolean } };
    assert.equal(worked.ok, true);
    assert.equal(worked.worker.terminal, true);

    const output = path.join(artifactDir, "reconciled.txt");
    const reconciled = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_reconcile",
        arguments: { job_id: "mcp-corpus-job", artifact_dir: artifactDir, output }
      })
    ) as { ok: boolean; output_path: string };
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.output_path, output);
    assert.equal(fs.readFileSync(output, "utf8"), "The corpus MCP boundary stays local.");

    const cancelled = parseMcpJson(
      await client.callTool({
        name: "deepseek_harness_corpus_cancel",
        arguments: { job_id: "mcp-corpus-job", artifact_dir: artifactDir }
      })
    ) as { ok: boolean; summary: { status: string } };
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.summary.status, "cancelled");
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

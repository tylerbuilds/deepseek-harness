#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cancelRun,
  doctor,
  exportHarnessState,
  exportReviewPacket,
  getResults,
  getStatus,
  harnessState,
  planManifest,
  processRun,
  submitManifest
} from "./runner.js";
import { toErrorPayload } from "./errors.js";

const server = new McpServer({
  name: "deepseek-harness",
  version: "0.1.0"
});

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

async function wrap(fn: () => unknown | Promise<unknown>) {
  try {
    return jsonContent(await fn());
  } catch (error) {
    return jsonContent(toErrorPayload(error));
  }
}

server.registerTool(
  "deepseek_harness_doctor",
  {
    title: "DeepSeek Harness Doctor",
    description: "Check local harness state without exposing secrets.",
    inputSchema: {}
  },
  async () => wrap(() => doctor())
);

server.registerTool(
  "deepseek_harness_plan",
  {
    title: "DeepSeek Harness Plan",
    description: "Validate a run manifest and return safety blockers or warnings.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, allow_live }) => wrap(() => planManifest(manifest, { allowLive: allow_live }))
);

server.registerTool(
  "deepseek_harness_submit",
  {
    title: "DeepSeek Harness Submit",
    description: "Create a run and optionally start it. Live calls require allow_live and a valid approval packet.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      start: z.boolean().optional(),
      allow_live: z.boolean().optional()
    }
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
    }
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
    }
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
    }
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
    }
  },
  async ({ run_id }) => wrap(() => cancelRun(run_id))
);

server.registerTool(
  "deepseek_harness_export_review_packet",
  {
    title: "DeepSeek Harness Export Review Packet",
    description: "Write and return the local review packet for a run.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => exportReviewPacket(run_id))
);

server.registerTool(
  "deepseek_harness_state",
  {
    title: "DeepSeek Harness State",
    description: "Return or export a read-model snapshot. Direct Command Centre state writes are blocked.",
    inputSchema: {
      output: z.string().optional(),
      limit: z.number().int().positive().optional()
    }
  },
  async ({ output, limit }) =>
    wrap(() => (output ? exportHarnessState({}, { output, limit }) : harnessState({}, { limit })))
);

const transport = new StdioServerTransport();
await server.connect(transport);

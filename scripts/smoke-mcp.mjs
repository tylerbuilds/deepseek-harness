#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseArgs(argv) {
  const args = {
    command: "node",
    commandArgs: ["dist/src/mcp.js"]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--command") {
      if (!argv[index + 1]) {
        throw new Error("Missing value for --command");
      }
      args.command = argv[index + 1];
      args.commandArgs = [];
      index += 1;
    } else if (value === "--") {
      args.commandArgs = argv.slice(index + 1);
      break;
    } else if (value === "--arg") {
      if (!argv[index + 1]) {
        throw new Error("Missing value for --arg");
      }
      args.commandArgs.push(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
const transport = new StdioClientTransport({
  command: args.command,
  args: args.commandArgs,
  cwd: process.cwd()
});

const client = new Client(
  {
    name: "deepseek-harness-smoke",
    version: "0.0.1"
  },
  {
    capabilities: {}
  }
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const requiredTools = [
    "deepseek_harness_doctor",
    "deepseek_harness_plan",
    "deepseek_harness_submit",
    "deepseek_harness_work",
    "deepseek_harness_status",
    "deepseek_harness_results",
    "deepseek_harness_cancel",
    "deepseek_harness_export_review_packet",
    "deepseek_harness_state",
    "deepseek_harness_privacy_check",
    "deepseek_harness_cost_ledger",
    "deepseek_harness_dispatch_proposal",
    "deepseek_harness_approval_packet",
    "deepseek_harness_agent_canary",
    "deepseek_harness_workload_benchmark",
    "deepseek_harness_failure_canary",
    "deepseek_harness_compare_models",
    "deepseek_harness_scale_ramp"
  ];
  const missing = requiredTools.filter((tool) => !toolNames.includes(tool));
  if (missing.length > 0) {
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  }

  const doctor = await client.callTool({
    name: "deepseek_harness_doctor",
    arguments: {}
  });
  const doctorText = doctor.content?.find((item) => item.type === "text")?.text;
  const doctorPayload = doctorText ? JSON.parse(doctorText) : null;
  if (!doctorPayload?.ok) {
    throw new Error(`Doctor did not return ok payload: ${doctorText ?? "(missing text content)"}`);
  }

  console.log(JSON.stringify({ ok: true, tool_count: toolNames.length, tools: toolNames, doctor: doctorPayload }, null, 2));
} finally {
  await client.close();
}

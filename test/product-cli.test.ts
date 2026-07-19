import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_HARNESS_STATE_DIR: path.join(root, ".state"),
    DEEPSEEK_HARNESS_ARTIFACT_DIR: path.join(root, "artifacts"),
    DEEPSEEK_HARNESS_INPUT_ROOT: root
  };
}

async function runCli(args: string[], root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-product-cli-"))) {
  return execFileAsync(process.execPath, ["dist/src/cli.js", ...args], {
    cwd: process.cwd(),
    env: isolatedEnv(root),
    maxBuffer: 4 * 1024 * 1024
  });
}

test("bare invocation and --help teach the canonical first steps", async () => {
  const bare = await runCli([]);
  const explicit = await runCli(["--help"]);

  assert.match(bare.stdout, /deepseek-harness quickstart/i);
  assert.match(bare.stdout, /capabilities/i);
  assert.equal(explicit.stdout, bare.stdout);
  assert.equal(bare.stderr, "");
});

test("version and capabilities are deterministic discovery surfaces", async () => {
  const version = await runCli(["--version"]);
  const first = await runCli(["capabilities"]);
  const second = await runCli(["capabilities"]);
  const capabilities = JSON.parse(first.stdout) as {
    ok: boolean;
    active_mcp_profile: string;
    product: { interfaces: string[] };
    model_strategy: {
      default_model: string;
      escalation_model: string;
      comparison_command: string;
    };
    workflows: Array<{ id: string }>;
    exit_codes: Record<string, string>;
  };

  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(first.stdout, second.stdout);
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.active_mcp_profile, "full");
  assert.equal(capabilities.product.interfaces.includes("tui"), true);
  assert.equal(capabilities.product.interfaces.includes("headless_exec"), true);
  assert.equal(capabilities.model_strategy.default_model, "deepseek-v4-flash");
  assert.equal(capabilities.model_strategy.escalation_model, "deepseek-v4-pro");
  assert.match(capabilities.model_strategy.comparison_command, /compare-models/);
  assert.equal(capabilities.workflows.some((workflow) => workflow.id === "prove_local_setup"), true);
  assert.equal(capabilities.exit_codes["2"], "invalid command, flag, or input");
});

test("forced TUI fails clearly when stdio is not a terminal", async () => {
  // Given / When / Then
  await assert.rejects(
    runCli(["chat", "--tui"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      const payload = JSON.parse(failure.stderr ?? "{}") as { code?: string; message?: string };
      assert.equal(failure.code, 2);
      assert.equal(payload.code, "tui_requires_tty");
      assert.match(payload.message ?? "", /requires a TTY/);
      return true;
    },
  );
});

test("chat mode flags are mutually exclusive", async () => {
  // Given / When / Then
  await assert.rejects(
    runCli(["chat", "--plain", "--tui"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      const payload = JSON.parse(failure.stderr ?? "{}") as { code?: string };
      assert.equal(failure.code, 2);
      assert.equal(payload.code, "invalid_chat_mode");
      return true;
    },
  );
});

test("one-shot chat failures propagate as a non-zero structured error", async () => {
  // Given / When / Then
  await assert.rejects(
    runCli(["chat", "status", "--plain"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      const payload = JSON.parse(failure.stderr ?? "{}") as { code?: string };
      assert.equal(failure.code, 3);
      assert.equal(payload.code, "deepseek_api_key_not_present");
      return true;
    },
  );
});

test("quickstart proves the local product without a network call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-product-quickstart-"));
  const output = path.join(root, "artifacts", "quickstart.json");
  const result = await runCli(["quickstart", "--output", output], root);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    status: string;
    network_calls: number;
    canary: { report: { artefacts: { review_packet: string; cost_ledger: string } } };
    next_actions: string[];
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.status, "ready");
  assert.equal(payload.network_calls, 0);
  assert.equal(fs.existsSync(output), true);
  assert.equal(fs.existsSync(payload.canary.report.artefacts.review_packet), true);
  assert.equal(fs.existsSync(payload.canary.report.artefacts.cost_ledger), true);
  assert.equal(payload.next_actions.some((action) => action.includes("mcp-config")), true);
});

test("mcp-config defaults new agents to the compact core profile", async () => {
  const result = await runCli(["mcp-config", "--format", "codex-toml", "--command", "/tmp/deepseek-harness-mcp"]);

  assert.match(result.stdout, /DEEPSEEK_HARNESS_MCP_PROFILE = "core"/);
  assert.match(result.stdout, /command = "\/tmp\/deepseek-harness-mcp"/);
});

test("common flag ordering and --flag=value forms work", async () => {
  const capabilities = await runCli(["capabilities", "--profile=core"]);
  const capabilityPayload = JSON.parse(capabilities.stdout) as { active_mcp_profile?: string };
  assert.equal(capabilityPayload.active_mcp_profile, "core");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-product-flag-order-"));
  const submit = await runCli(["submit", "--start", "examples/basic-run.json"], root);
  const submitPayload = JSON.parse(submit.stdout) as { status?: string; summary?: { counts?: { completed?: number } } };
  assert.equal(submitPayload.status, "completed");
  assert.equal(submitPayload.summary?.counts?.completed, 2);
});

test("mistyped and incomplete commands return structured recovery with exit code 2", async () => {
  await assert.rejects(
    runCli(["capabilties"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      const payload = JSON.parse(failure.stderr ?? "{}") as {
        code?: string;
        message?: string;
        details?: { suggestion?: string; next_actions?: string[] };
      };
      assert.equal(failure.code, 2);
      assert.equal(payload.code, "unknown_command");
      assert.match(payload.message ?? "", /Did you mean capabilities/);
      assert.equal(payload.details?.suggestion, "deepseek-harness capabilities");
      return true;
    }
  );

  await assert.rejects(
    runCli(["plan"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      const payload = JSON.parse(failure.stderr ?? "{}") as { code?: string; details?: { suggestion?: string } };
      assert.equal(failure.code, 2);
      assert.equal(payload.code, "missing_argument");
      assert.equal(payload.details?.suggestion, "deepseek-harness help");
      return true;
    }
  );

  await assert.rejects(
    runCli(["submit", "examples/basic-run.json", "--enqueue-onyl"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      const payload = JSON.parse(failure.stderr ?? "{}") as {
        details?: { next_actions?: string[] };
      };
      assert.equal(failure.code, 2);
      assert.deepEqual(payload.details?.next_actions, ["deepseek-harness submit --help"]);
      return true;
    }
  );
});

test("help and unknown corpus flags are rejected before any job can execute", async () => {
  const helpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-product-corpus-help-"));
  const help = await runCli(["corpus", "start", "examples/corpus-basic.json", "--help"], helpRoot);
  assert.match(help.stdout, /Canonical lifecycle/);
  assert.equal(fs.existsSync(path.join(helpRoot, ".state")), false);

  const typoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-product-corpus-typo-"));
  await assert.rejects(
    runCli(["corpus", "start", "examples/corpus-basic.json", "--enqueue-onyl"], typoRoot),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      const payload = JSON.parse(failure.stderr ?? "{}") as {
        code?: string;
        message?: string;
        details?: { suggestion?: string };
      };
      assert.equal(failure.code, 2);
      assert.equal(payload.code, "unknown_flag");
      assert.match(payload.message ?? "", /Did you mean --enqueue-only/);
      assert.equal(payload.details?.suggestion, "--enqueue-only");
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(typoRoot, ".state")), false);
});

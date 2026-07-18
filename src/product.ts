import packageMetadata from "../package.json" with { type: "json" };

export type McpProfile = "core" | "corpus" | "full";
export const PRODUCT_VERSION = packageMetadata.version;

export const MCP_PROFILES: Record<McpProfile, { description: string; tool_groups: string[] }> = {
  core: {
    description: "Compact batch, safety, proof and benchmark surface for general agents.",
    tool_groups: ["discovery", "batch", "safety", "proof", "benchmark"]
  },
  corpus: {
    description: "Corpus ingest, OCR, translation, long-form, media and worker operations.",
    tool_groups: ["discovery", "corpus"]
  },
  full: {
    description: "Every DeepSeek Harness tool. Use when one agent needs both batch and corpus planes.",
    tool_groups: ["discovery", "batch", "safety", "proof", "benchmark", "corpus"]
  }
};

export function parseMcpProfile(value: string | undefined, fallback: McpProfile = "full"): McpProfile {
  if (!value) {
    return fallback;
  }
  if (value === "core" || value === "corpus" || value === "full") {
    return value;
  }
  throw new Error(`Unknown MCP profile: ${value}. Expected core, corpus, or full.`);
}

export function productCapabilities(profile: McpProfile = "full"): Record<string, unknown> {
  return {
    ok: true,
    schema_version: "deepseek-harness.capabilities.v1",
    product: {
      name: packageMetadata.name,
      version: PRODUCT_VERSION,
      status: "public_alpha",
      interfaces: ["cli", "mcp_stdio"]
    },
    active_mcp_profile: profile,
    mcp_profiles: MCP_PROFILES,
    model_strategy: {
      provider: "deepseek",
      generation: "v4",
      default_model: "deepseek-v4-flash",
      escalation_model: "deepseek-v4-pro",
      thinking_default: "enabled",
      reasoning_effort_default: "high",
      reasoning_effort_escalation: "max",
      routing_policy: "Start high-volume lanes on Flash; benchmark or escalate complex synthesis and review to Pro.",
      comparison_command: "deepseek-harness compare-models MANIFEST --models deepseek-v4-flash,deepseek-v4-pro"
    },
    safety_defaults: {
      live_calls: "disabled",
      external_side_effects: false,
      canonical_state_write: false,
      sensitive_external_egress: "blocked",
      live_authority: "signed_one_use_receipt"
    },
    workflows: [
      {
        id: "prove_local_setup",
        use_when: "A fresh operator or agent needs proof that the installed harness works.",
        cli: "deepseek-harness quickstart",
        mcp_tool: "deepseek_harness_quickstart",
        network: false,
        writes: "local state and review artefacts only"
      },
      {
        id: "run_safe_batch",
        use_when: "Many independent non-sensitive prompts need bounded parallel processing.",
        cli: "deepseek-harness plan MANIFEST && deepseek-harness submit MANIFEST --start",
        mcp_sequence: ["deepseek_harness_plan", "deepseek_harness_submit", "deepseek_harness_export_review_packet"],
        network: "fake and dry-run are local; live requires signed authority"
      },
      {
        id: "benchmark_workload",
        use_when: "An agent needs throughput and artefact proof before scaling a workload.",
        cli: "deepseek-harness workload-benchmark --workload extraction --items 12 --concurrency 4",
        mcp_tool: "deepseek_harness_workload_benchmark",
        network: false
      },
      {
        id: "process_corpus",
        use_when: "Books, JSONL, OCR, translation, long-form or media inputs need resumable shard processing.",
        cli: "deepseek-harness corpus --help",
        mcp_profile: "corpus",
        lifecycle: ["ingest", "plan", "start", "validate", "reconcile"]
      },
      {
        id: "prepare_live_deepseek",
        use_when: "A reviewed non-sensitive batch is ready for a real provider call.",
        cli: "deepseek-harness approval-packet MANIFEST",
        mcp_tool: "deepseek_harness_approval_packet",
        network: false,
        note: "Preparing a packet does not grant authority or make a live call."
      }
    ],
    discovery: {
      cli_help: "deepseek-harness help",
      this_document: "deepseek-harness capabilities",
      mcp_configuration: "deepseek-harness mcp-config --format codex-toml --profile core",
      safe_smoke: "deepseek-harness quickstart"
    },
    exit_codes: {
      "0": "success",
      "1": "runtime or upstream failure",
      "2": "invalid command, flag, or input",
      "3": "safety or authority block"
    }
  };
}

# DeepSeek Harness

Local-first batch harness for high-throughput DeepSeek work. It is a worker
sidecar, not an approval system and not an Agent OS state writer.

## Status

Core sprint status: `DSH-00` to `DSH-09` complete locally.

- validates explicit run manifests;
- stores runs, items and events in local SQLite;
- supports fake and DeepSeek dry-run transports;
- refuses live DeepSeek calls unless approval, egress, cost and side-effect gates pass;
- exposes a CLI and MCP stdio server over the same service layer;
- exports Agent OS readable state snapshots, Dispatch proposals and review packets;
- includes a gated scale-ramp command for measured concurrency tests;
- includes local agent canary, workload benchmark, privacy check, cost ledger,
  failure canary and model-comparison planning tools.

The live proof on 2026-07-06 completed a non-sensitive DeepSeek V4 Flash
scale ramp at 5, 10 and 20 concurrency. All three 40-item runs completed;
the fastest measured leg was concurrency 20 at 15.86 items/second.

## Safety Contract

The harness may prepare and run batch inference artefacts. It must not write
canonical Agent OS state, apply repo changes, publish, deploy, send messages,
mutate GitHub, handle credentials, or approve its own output.

Live DeepSeek calls require:

- `egress_class: "non_sensitive_bulk"`;
- a real `approval_id`, not a placeholder;
- `cost_cap_usd`;
- `concurrency` within the local live cap;
- `canonical_writes: false`;
- `external_side_effects: false`;
- `DEEPSEEK_API_KEY` present in the process environment.

Live scale ramps additionally require `--allow-live-scale`.

## Commands

```bash
npm install
npm run build
npm test
npm run test:e2e
cargo test
bash scripts/install-local.sh --install-dir "$HOME/bin" --print-config

node dist/src/cli.js doctor
node dist/src/cli.js mcp-config --command "$HOME/bin/deepseek-harness-mcp"
node dist/src/cli.js mcp-config --format codex-toml --command "$HOME/bin/deepseek-harness-mcp"
node dist/src/cli.js plan examples/basic-run.json
node dist/src/cli.js submit examples/basic-run.json --start
node dist/src/cli.js status <run_id>
node dist/src/cli.js results <run_id>
node dist/src/cli.js export-review-packet <run_id>
node dist/src/cli.js cost-ledger <run_id>
node dist/src/cli.js state --output artifacts/deepseek-harness-state.json
node dist/src/cli.js privacy-check examples/live-deepseek-blocked.json
node dist/src/cli.js dispatch-proposal examples/basic-run.json
node dist/src/cli.js approval-packet examples/live-micro-smoke-template.json --output artifacts/live-smoke-approval-packet.json
node dist/src/cli.js agent-canary --output artifacts/agent-canary.json
node dist/src/cli.js workload-benchmark --workload extraction --items 12 --concurrency 4 --output artifacts/workload-benchmark.json
node dist/src/cli.js failure-canary --output artifacts/failure-canary.json
node dist/src/cli.js compare-models examples/model-comparison-base.json --output artifacts/model-comparison-plan.json
node dist/src/cli.js scale-ramp examples/basic-run.json --concurrency 5,10,20 --items 40 --output artifacts/scale-ramp-local.json
cargo run -p deepseek-harness-worker -- --manifest examples/basic-run.json --transport fake --concurrency 4 --output artifacts/rust-worker-basic-run.json
```

The default example uses the fake transport and performs no network calls.

Operator docs:

- `docs/operator-guide.md`
- `docs/sprint-plan.md`
- `docs/proof/DSH-09-CLOSEOUT-2026-07-06.md`

## MCP

```bash
bash scripts/install-local.sh --install-dir "$HOME/bin" --print-config
npm run mcp:smoke -- --command "$HOME/bin/deepseek-harness-mcp"
```

Add the generated MCP snippet at `~/.config/deepseek-harness/mcp-server.json`
to your MCP client. It contains state/artifact paths only; it does not store a
DeepSeek API key.

For Codex, append the generated TOML snippet at
`~/.config/deepseek-harness/codex-mcp-server.toml` to `~/.codex/config.toml`.

Tools:

- `deepseek_harness_doctor`
- `deepseek_harness_plan`
- `deepseek_harness_submit`
- `deepseek_harness_work`
- `deepseek_harness_status`
- `deepseek_harness_results`
- `deepseek_harness_cancel`
- `deepseek_harness_export_review_packet`
- `deepseek_harness_state`
- `deepseek_harness_privacy_check`
- `deepseek_harness_cost_ledger`
- `deepseek_harness_dispatch_proposal`
- `deepseek_harness_approval_packet`
- `deepseek_harness_agent_canary`
- `deepseek_harness_workload_benchmark`
- `deepseek_harness_failure_canary`
- `deepseek_harness_compare_models`
- `deepseek_harness_scale_ramp`

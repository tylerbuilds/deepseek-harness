# DeepSeek Harness Operator Guide

This harness is for fast, bounded DeepSeek batch inference with local evidence.
It is not an approval system, repo applier, publisher, deployer, state writer or
secret manager.

## Normal Route

1. Write or choose a manifest with non-sensitive prompts.
2. Run `plan` and fix any blockers.
3. For live calls, generate an approval packet.
4. Run the batch or scale ramp with explicit live flags.
5. Export review packets and a state snapshot.
6. Let Codex or Agent OS reconcile outputs and decide the next action.

## Local Proof Loop

```bash
npm install
npm run typecheck
npm test
node dist/src/cli.js doctor
node dist/src/cli.js plan examples/basic-run.json
node dist/src/cli.js scale-ramp examples/basic-run.json --concurrency 5,10,20 --items 40 --output artifacts/scale-ramp-local.json
cargo run -p deepseek-harness-worker -- --manifest examples/basic-run.json --transport fake --concurrency 4 --output artifacts/rust-worker-basic-run.json
```

The default example uses `transport: "fake"` and does not call DeepSeek.

## Rust Worker

The Rust worker is an execution-core experiment behind the TypeScript CLI/MCP
surface. It currently supports fake transport only.

```bash
cargo test
cargo run -p deepseek-harness-worker -- --manifest examples/basic-run.json --transport fake --concurrency 4
```

The worker report schema is `deepseek-harness.worker-report.v1`. It does not
call DeepSeek, write SQLite, write Agent OS state, apply repo changes, deploy or
send messages.

## Live Micro-Smoke

Use a manifest modelled on `examples/live-micro-smoke-template.json`, but replace
the placeholder approval only after Tyler has approved the exact run.

```bash
node dist/src/cli.js approval-packet artifacts/live-micro-smoke-approved.json --output artifacts/live-micro-smoke-approval-packet.json
node dist/src/cli.js plan artifacts/live-micro-smoke-approved.json --allow-live
node dist/src/cli.js submit artifacts/live-micro-smoke-approved.json --start --allow-live
```

The key must only be supplied through the process environment. Do not place it in
manifests, docs, logs, shell history snippets, MCP payloads or artefacts.

## Live Scale Ramp

Run the local scale ramp first. For live scale, use both live gates:

```bash
node dist/src/cli.js approval-packet artifacts/live-scale-ramp-approved.json --output artifacts/live-scale-ramp-approval-packet.json
node dist/src/cli.js plan artifacts/live-scale-ramp-approved.json --allow-live
node dist/src/cli.js scale-ramp artifacts/live-scale-ramp-approved.json --concurrency 5,10,20 --items 40 --output artifacts/live-scale-ramp.json --allow-live --allow-live-scale
```

The live 2026-07-06 ramp used `deepseek-v4-flash`, non-sensitive seed prompts,
40 items per leg and a `0.25` USD manifest cap. It completed 120/120 items with
no failed items.

## Evidence Exports

```bash
node dist/src/cli.js export-review-packet <run_id>
node dist/src/cli.js state --output artifacts/deepseek-harness-state.json --limit 12
node dist/src/cli.js dispatch-proposal <manifest.json>
```

Review packets and state snapshots live under `artifacts/`, which is ignored by
git. Keep them local unless a specific review route asks for them.

## MCP

```bash
node dist/src/mcp.js
```

The MCP server exposes the same service layer as the CLI. Treat MCP output as
evidence and control-plane input, not as approval or execution authority.

## Hard Boundaries

- no sensitive egress;
- no raw secrets in manifests, artefacts or git;
- no canonical Agent OS state writes;
- no command-centre `_state` writes;
- no repo apply, deploy, publish, send or permission mutation from harness runs;
- no live DeepSeek calls without approval packet and live flags;
- no live scale ramp without `--allow-live-scale`;
- no GitHub write by the harness runtime.

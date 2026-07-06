# DeepSeek Harness

Local-first batch harness for high-throughput DeepSeek work. It is a worker
sidecar, not an approval system and not an Agent OS state writer.

## Status

Current implementation target: `DSH-00` to `DSH-04`.

- validates explicit run manifests;
- stores runs, items and events in local SQLite;
- supports fake and DeepSeek dry-run transports;
- refuses live DeepSeek calls unless approval, egress, cost and side-effect gates pass;
- exposes a CLI and MCP stdio server over the same service layer.

## Safety Contract

The harness may prepare and run batch inference artefacts. It must not write
canonical Agent OS state, apply repo changes, publish, deploy, send messages,
mutate GitHub, handle credentials, or approve its own output.

Live DeepSeek calls require:

- `egress_class: "non_sensitive_bulk"`;
- `approval_id`;
- `cost_cap_usd`;
- `concurrency` within the local live cap;
- `canonical_writes: false`;
- `external_side_effects: false`;
- `DEEPSEEK_API_KEY` present in the process environment.

## Commands

```bash
npm install
npm run build
npm test

node dist/src/cli.js doctor
node dist/src/cli.js plan examples/basic-run.json
node dist/src/cli.js submit examples/basic-run.json --start
node dist/src/cli.js status <run_id>
node dist/src/cli.js results <run_id>
node dist/src/cli.js export-review-packet <run_id>
node dist/src/cli.js state --output artifacts/deepseek-harness-state.json
```

The default example uses the fake transport and performs no network calls.

## MCP

```bash
node dist/src/mcp.js
```

Tools:

- `deepseek_harness_doctor`
- `deepseek_harness_plan`
- `deepseek_harness_submit`
- `deepseek_harness_status`
- `deepseek_harness_results`
- `deepseek_harness_cancel`
- `deepseek_harness_export_review_packet`
- `deepseek_harness_state`

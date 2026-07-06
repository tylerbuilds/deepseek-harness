# DeepSeek Harness Sprint

## Batches

| Batch | Aim | Status | Exit proof |
| --- | --- | --- | --- |
| DSH-00 | Repo scaffold and Agent OS service contract | Done | `agentos.service.yml`, README, build/test scripts |
| DSH-01 | Manifest and safety gates | Done | invalid sensitive/live manifests are rejected |
| DSH-02 | Batch runner core | Done | fake transport handles parallel items with SQLite state |
| DSH-03 | DeepSeek transport | Done | dry-run request shape and live-call gates proven |
| DSH-04 | MCP control surface | Done | Codex can plan, submit, poll and export results by `run_id` |
| DSH-05 | Agent OS integration | Done | read-model export and contract docs |
| DSH-06 | Zeus Dispatch visibility | Done | proposal/evidence adapter, no execution authority |
| DSH-07 | Live micro-smoke | Done | explicit approval, tiny non-sensitive batch, bounded cost |
| DSH-08 | Scale ramp | Done | measured 5/10/20 concurrency reports, local and live |
| DSH-09 | Closeout | Done locally | proof pack, operator guide, final green checks |
| DSH-10 | Borrowed-patterns design | Proposed PR | GitHub pattern survey and Rust split decision |
| DSH-11 | Rust worker core | Proposed PR | fake-transport Rust worker runs existing manifest shape |
| DSH-12 | Adaptive throughput | Proposed PR | retry/backoff and adaptive concurrency proof |

## Non-Negotiables

- no live DeepSeek calls without explicit approval packet;
- no secrets in logs, artefacts or MCP responses;
- no canonical state writes;
- no external side effects beyond approved DeepSeek API inference;
- Codex remains final reconciler and proof owner.

## DSH-07 Gate

Before any live DeepSeek call, generate:

```bash
node dist/src/cli.js approval-packet examples/live-micro-smoke-template.json --output artifacts/live-smoke-approval-packet.json
```

The template is deliberately non-executable because `approval_id` is a
placeholder. Replace it only after Tyler approves the exact manifest, then run
with `--allow-live` in a shell that has `DEEPSEEK_API_KEY`.

## DSH-08 Scale Ramp

Run the local ramp first:

```bash
node dist/src/cli.js scale-ramp examples/basic-run.json --concurrency 5,10,20 --items 40 --output artifacts/scale-ramp-local.json
```

Live DeepSeek scale is separately gated with `--allow-live-scale` and should not
be used until the DSH-07 live micro-smoke has passed.

2026-07-06 live result: `artifacts/live-scale-ramp-20260706.json` completed
three 40-item DeepSeek V4 Flash runs at 5, 10 and 20 concurrency with no failed
items. The report recommended 20 as the next tested concurrency.

## DSH-09 Closeout

Closeout requires:

- `npm run typecheck`;
- `npm test`;
- `agent-os-repo-proof --repo /Users/tyler/Code/control-plane/deepseek-harness --level quick --run --json`;
- `git diff --check`;
- final state export under `artifacts/`;
- source docs committed without ignored artefacts or secrets.

Push or PR handling depends on the configured git remote. The harness runtime
itself still has no GitHub-write authority.

## DSH-10 Borrowed-Patterns Rule

Do not invent orchestration patterns where mature projects already show the
shape. Borrow selectively, keep the local safety contract, and land changes via
small PRs:

- use current TypeScript MCP as the stable control surface until a Rust MCP
  migration has its own proof;
- introduce Rust first as a worker binary, not a whole-repo rewrite;
- keep manifests, artifacts and review packets compatible across languages;
- keep DeepSeek live calls approval-gated and disabled by default.

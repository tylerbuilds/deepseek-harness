# DeepSeek Harness Operator Guide

This harness is for fast, bounded DeepSeek batch inference with local evidence.
It is not an approval system, repo applier, publisher, deployer, state writer or
secret manager.

The `v0.1.0` public npm package is prepared but has not been published. Until
the first registry publication, operators should use the source installer and
the manual release workflow should be treated as the only publication route.

## Operator installation and discovery

The first operational journey is install, zero-network quickstart, capability
discovery, then MCP configuration:

```bash
git clone https://github.com/tylerbuilds/deepseek-harness.git
cd deepseek-harness
bash scripts/install-local.sh --install-dir "$HOME/bin" --profile core --print-config
export PATH="$HOME/bin:$PATH"
deepseek-harness quickstart
deepseek-harness capabilities
deepseek-harness mcp-config --format codex-toml --command "$HOME/bin/deepseek-harness-mcp" --profile core
```

The source installer builds the launchers and writes only local configuration.
Review its path and profile arguments before use. The quickstart must report
zero provider network calls before an operator proceeds.

After the first registry publication, these future-only commands will provide
the equivalent package route:

```bash
npm install --global deepseek-harness@0.1.0
npx --yes deepseek-harness@0.1.0 quickstart
```

They are not current publication evidence.

## MCP profiles

Use the smallest profile that gives an agent the required tools:

| Profile | Tool groups | Default |
| --- | --- | --- |
| `core` | discovery, batch, safety, proof and benchmark | Yes for new MCP configuration |
| `corpus` | discovery and corpus workflows | No |
| `full` | all available tool groups | No |

Pass `--profile core`, `--profile corpus` or `--profile full` to `mcp-config`,
and keep the same profile in the MCP launcher environment as
`DEEPSEEK_HARNESS_MCP_PROFILE`.

## Normal Route

1. Write or choose a manifest with non-sensitive prompts.
2. Run `plan` and fix any blockers.
3. For live calls, generate an approval packet and obtain an owner-signed receipt from the separate approval authority.
4. Run the batch or scale ramp with explicit live flags.
5. Export review packets and a state snapshot.
6. Let Codex or Agent OS reconcile outputs and decide the next action.

## Operate terminal chat safely

Chat is the supervision and coding surface, not the durable workload runner.
With no mode flag, `deepseek-harness chat` selects the TUI only when both stdin
and stdout are TTYs. `--plain` forces the classic interface, which is suitable
for scripts and pipelines; `--tui` forces the UI and fails with
`tui_requires_tty` when either stream is not a TTY.

```bash
deepseek-harness chat
deepseek-harness chat --plain
deepseek-harness chat --tui
deepseek-harness chat --list
deepseek-harness chat --resume SESSION_ID
deepseek-harness chat --model deepseek-v4-pro
```

Use `--list` to discover a session ID before `--resume SESSION_ID`. The default
model is `deepseek-v4-flash`; the only alternate chat model is
`deepseek-v4-pro`.

The TUI exposes the transcript, streamed reasoning, tool activity, session ID,
model, cost and recent corpus jobs. Approval prompts show the exact tool call
and parameters. `y` approves once, `s` approves that tool for the session, and
`n` declines. `Ctrl-C` cancels the active turn or clears input; `Ctrl-D` exits
when the composer is empty. The slash commands are `/help`, `/clear`, `/cost`,
`/sessions`, `/jobs` and `/exit`.

Read-only tools do not need approval. File writes, exact edits, deletes and
shell commands do. One-shot prompts and non-TTY sessions fail closed for these
mutations; they cannot grant approval by consuming piped input. Keep
`DEEPSEEK_API_KEY` in the process environment or an approved OS-keychain flow,
and never commit it to Git, manifests, docs, logs or shell history.

Use the resumable `corpus` commands for books, OCR and translation. Keep those
jobs in the manifest/shard lifecycle in [Heavy Corpus Workloads](corpus-heavy-workloads.md);
do not send a whole book as one chat prompt.

## Local Proof Loop

```bash
npm run typecheck
npm test
npm run test:e2e
node dist/src/cli.js doctor
node dist/src/cli.js plan examples/basic-run.json
node dist/src/cli.js agent-canary --output artifacts/agent-canary.json
node dist/src/cli.js workload-benchmark --workload classification --items 12 --concurrency 4 --output artifacts/workload-benchmark.json
node dist/src/cli.js failure-canary --output artifacts/failure-canary.json
node dist/src/cli.js scale-ramp examples/basic-run.json --concurrency 5,10,20 --items 40 --output artifacts/scale-ramp-local.json
cargo run -p deepseek-harness-worker -- --manifest examples/basic-run.json --transport fake --concurrency 4 --output rust-worker-basic-run.json
bash scripts/install-local.sh --install-dir "$HOME/bin" --print-config
npm run mcp:smoke -- --command "$HOME/bin/deepseek-harness-mcp" --profile core
npm run package:smoke
npm run pack:check
npm audit --audit-level=high
```

The default example uses `transport: "fake"` and does not call DeepSeek.

## Heavy Corpus Route

Use `docs/corpus-heavy-workloads.md` for whole books, PDF/image OCR,
translations with reviewed local memory, JSONL datasets, long-form sections,
media catalogues and the bounded supervisor. The persistent launchd example is
checked in but is not installed automatically. Its default worker defers live
DeepSeek ledgers without changing them; persistent live authority is not
supported. Live corpus work runs directly as one separately signed bounded
batch.

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

## Agent Utility Loop

Use these commands when testing whether agents can use the harness end to end
without live spend:

```bash
node dist/src/cli.js privacy-check examples/live-deepseek-blocked.json
node dist/src/cli.js agent-canary --output artifacts/agent-canary.json
node dist/src/cli.js workload-benchmark --workload extraction --items 12 --concurrency 4 --output artifacts/workload-benchmark.json
node dist/src/cli.js failure-canary --output artifacts/failure-canary.json
node dist/src/cli.js compare-models examples/model-comparison-base.json --output artifacts/model-comparison-plan.json
```

These commands use fake or dry-run transports only. They write local artefacts
under `artifacts/`: review packets, result JSONL, summaries, benchmark reports
and `cost-ledger.json`.

## Live Micro-Smoke

Use a manifest modelled on `examples/live-micro-smoke-template.json`. Generate
the packet to obtain the exact network-payload digest, then attach a short-lived
owner-signed `deepseek-harness.inference-receipt.v1`. The signer is deliberately
not part of this harness; only its public verification key is available here.

```bash
node dist/src/cli.js approval-packet artifacts/live-micro-smoke-approved.json --output artifacts/live-micro-smoke-approval-packet.json
node dist/src/cli.js plan artifacts/live-micro-smoke-approved.json --allow-live
node dist/src/cli.js submit artifacts/live-micro-smoke-approved.json --start --allow-live
```

The key must only be supplied through the process environment. Do not place it in
manifests, docs, logs, shell history snippets, MCP payloads or artefacts.
The receipt must bind provider, exact model, payload SHA-256, non-sensitive
egress, item/concurrency limits, run/daily cost ceilings, a versioned rate
snapshot, issue/expiry times and a nonce. Receipts are consumed once before the
first request. A free-form approval ID is ignored.

## Live Scale Ramp

Run the local scale ramp first. For live scale, use both live gates:

```bash
node dist/src/cli.js approval-packet artifacts/live-scale-ramp-approved.json --output artifacts/live-scale-ramp-approval-packet.json
node dist/src/cli.js plan artifacts/live-scale-ramp-approved.json --allow-live
node dist/src/cli.js scale-ramp artifacts/live-scale-ramp-approved.json --concurrency 5,10,20 --items 40 --output artifacts/live-scale-ramp.json --allow-live --allow-live-scale
```

Do not copy local throughput numbers into release notes or operational claims.
Record any machine- and manifest-specific measurements in the local artefact
directory and review them separately from this source release.

## Evidence Exports

```bash
node dist/src/cli.js export-review-packet <run_id>
node dist/src/cli.js cost-ledger <run_id>
node dist/src/cli.js state --output artifacts/deepseek-harness-state.json --limit 12
node dist/src/cli.js dispatch-proposal <manifest.json>
```

Review packets and state snapshots live under `artifacts/`, which is ignored by
git. Keep them local unless a specific review route asks for them.

## MCP

```bash
bash scripts/install-local.sh --install-dir "$HOME/bin" --profile core --print-config
npm run mcp:smoke -- --command "$HOME/bin/deepseek-harness-mcp" --profile core
```

The MCP server exposes the same service layer as the CLI. Treat MCP output as
evidence and control-plane input, not as approval or execution authority.

The installer writes:

- `$HOME/bin/deepseek-harness`
- `$HOME/bin/deepseek-harness-mcp`
- `$HOME/.config/deepseek-harness/mcp-server.json`
- `$HOME/.config/deepseek-harness/codex-mcp-server.toml`

The MCP config snippets are safe to paste into client config. They include the
launcher path and local state/artifact directories only. They deliberately do
not include `DEEPSEEK_API_KEY`.

For Codex, append `codex-mcp-server.toml` to `~/.codex/config.toml`.

`npm run mcp:inspect` is optional interactive developer debugging. It opens the
MCP Inspector UI against the local stdio server and may remain running until
you stop it. It is never a CI or release gate and does not replace
`npm run mcp:smoke`, the automated protocol smoke gate.

`npm run package:smoke` is the installed-package proof used by the release
workflow. It installs a temporary npm archive, checks the installed CLI and MCP
launchers, runs the zero-network quickstart and verifies the packaged macOS
Vision adapter. It does not publish anything.

The main CI matrix runs this source/release smoke on `ubuntu-latest` and
`macos-14`; the macOS lane is the platform-specific package proof for the
Vision adapter. That configured CI lane is not a claim that the v0.1.0 release
workflow has run.

## Release readiness

The manual `.github/workflows/release.yml` workflow checks the exact relationship
between the input tag and `package.json` version, runs the complete CI command
set and captures npm pack boundary proof. Its protected release phase creates
one exact npm tarball, computes and verifies its SHA-256 checksum, installs that
same tarball, proves the installed CLI/MCP/quickstart path and checks the
packaged macOS Vision adapter. It then attaches the tarball and checksum to the
matching GitHub Release. An explicit `publish_npm` input can publish that same
file through npm OIDC trusted publishing with `id-token: write`.

Configure required reviewers for the `release` environment in GitHub. The
workflow is manual and has not been run here; do not run `npm publish` from an
operator workstation or infer publication from these local checks.

## Hard Boundaries

- no sensitive egress;
- no raw secrets in manifests, artefacts or git;
- no canonical Agent OS state writes;
- no command-centre `_state` writes;
- no repo apply, deploy, publish, send or permission mutation from harness runs;
- no live DeepSeek calls without a valid signed one-use receipt and live flags;
- no live scale ramp without `--allow-live-scale`;
- no GitHub write by the harness runtime.

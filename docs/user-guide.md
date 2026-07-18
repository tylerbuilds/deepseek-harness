# DeepSeek Harness User Guide

DeepSeek Harness runs bounded batch work locally and leaves an evidence trail
you can inspect. Start with the fake transport: it exercises the real CLI and
storage path without sending prompts to a provider or needing an API key.

## Run a safe first job

You need Node.js 24 or later, npm, and Git.

```bash
git clone https://github.com/tylerbuilds/deepseek-harness.git
cd deepseek-harness
npm ci
npm run build
node dist/src/cli.js doctor
```

The final command should return JSON with `"ok": true`. It also shows the
local state and artefact directories the harness will use.

This repository is the `v0.0.1` source release. It is intentionally private to
npm; do not use `npm install deepseek-harness` or treat `npm pack` as a
publication route. The package check exists only to prove that a local archive
contains the explicitly allowlisted runtime and public documentation.

Treat that artefact directory as the harness sandbox. CLI and MCP output
arguments must stay beneath it, and corpus ingest rejects protected or
credential-shaped local paths before reading them. Set
`DEEPSEEK_HARNESS_ARTIFACT_DIR` at launch time if you need a different local
volume; keep the documented `artifacts/...` paths in manifests and commands.

Corpus sources have a separate read boundary. By default it is the directory
where you launch the harness; set `DEEPSEEK_HARNESS_INPUT_ROOT` to a dedicated
input directory when the source material lives elsewhere. MCP configuration
emits the same setting. Paths outside that root, symlink escapes and protected
credential or workspace paths are rejected before their contents are read.

Run the included fake example:

```bash
node dist/src/cli.js plan examples/basic-run.json
node dist/src/cli.js submit examples/basic-run.json --start
```

The submit response includes a `run_id`. Copy it into the next commands:

```bash
node dist/src/cli.js status <run_id>
node dist/src/cli.js results <run_id>
node dist/src/cli.js export-review-packet <run_id>
```

Success means the status is `completed`, the results contain one completed item
per input, and the review packet is written beneath the run's local artefacts.

## Choose the right execution mode

| Mode       | Use it for                                            | Sends data to a provider? |
| ---------- | ----------------------------------------------------- | ------------------------- |
| `fake`     | First runs, integration checks and workflow testing   | No                        |
| `dry-run`  | Inspecting the exact work plan before approval        | No                        |
| `deepseek` | A separately approved, non-sensitive production batch | Yes                       |

Start with `fake`. Use `dry-run` when you want to inspect the provider payload
shape. Only use `deepseek` after the live checks below have passed.

## Work from a manifest

A manifest declares the items to process, transport, model limits, artefact
location and safety boundaries. Keep manifests in version control only when
they contain no confidential prompts, approval receipts or local-only paths.

Use this loop for ordinary batch work:

```bash
node dist/src/cli.js plan <manifest.json>
node dist/src/cli.js submit <manifest.json> --start
node dist/src/cli.js status <run_id>
node dist/src/cli.js results <run_id>
```

If `plan` returns blockers, fix them before submitting the run. A plan is not
approval and a successful run is not a publishing or deployment action.

## Install convenient local commands

The installer builds the project, creates CLI and MCP launchers in the chosen
directory, and writes local MCP configuration snippets. Review the script first
if you use a non-standard machine setup.

```bash
bash scripts/install-local.sh --install-dir "$HOME/bin" --print-config
deepseek-harness doctor
```

The installer does not write an API key. Add its printed MCP configuration to
your client only after checking the state and artefact paths are appropriate for
that machine.

## Connect an MCP client

After installation, verify the stdio server:

```bash
npm run mcp:smoke -- --command "$HOME/bin/deepseek-harness-mcp"
```

For Codex, generate the TOML snippet:

```bash
deepseek-harness mcp-config \
  --format codex-toml \
  --command "$HOME/bin/deepseek-harness-mcp"
```

The MCP server exposes the same operations as the CLI. It can prepare plans,
run permitted local work and return evidence; it does not become an approval,
publishing or deployment authority.

## Use live DeepSeek only with separate approval

Live runs are intentionally harder than fake or dry-run work. Before a live
call, you need all of the following:

- non-sensitive bulk egress;
- a `max_tokens` value plus run and daily cost ceilings;
- `canonical_writes: false` and `external_side_effects: false`;
- an owner-signed, one-use approval receipt bound to the final payload;
- the provider key and approval public key supplied to the process environment;
- an explicit `--allow-live` flag.

Generate an approval packet only after freezing the final manifest:

```bash
node dist/src/cli.js approval-packet <manifest.json>
node dist/src/cli.js plan <manifest.json> --allow-live
```

Keep keys, signed receipts, customer data and live output artefacts out of Git,
shell history and shared chat. The harness rejects missing or mismatched live
authority by design.

## Verify a checkout before relying on it

Run the following after pulling changes or before contributing:

```bash
npm run typecheck
npm test
npm run test:e2e
cargo test
```

`npm run test:e2e` drives the built CLI and MCP server as separate processes.
Use it when you need evidence that the installed surfaces still work together.

## Fix common first-run problems

### `doctor` reports an unexpected directory

Set the state and artefact environment variables before running the command,
then rerun `doctor` to confirm the resolved paths. Keep artefacts on a local,
writable volume with enough free space for inputs and outputs.

### A plan is blocked by privacy or approval checks

Use the fake transport while you resolve the manifest. Do not work around the
block by removing a safety field or placing a key in the manifest.

### MCP cannot start

Run the smoke command above with the full launcher path. If it fails, rebuild
the project and rerun the installer; then check that the generated configuration
points at the same launcher.

### You need heavy corpus work

Use the [heavy corpus workflow guide](corpus-heavy-workloads.md). Its model is
`ingest → plan → start/work → validate → reconcile → review`; work is sharded
and resumable rather than held in one long chat request.

## Know what the harness will not do

DeepSeek Harness does not publish content, deploy services, mutate GitHub,
write canonical Agent OS state, send messages, or approve its own live work.
Those boundaries are intentional: the harness produces local results and proof
artefacts for a separate human or control-plane decision.

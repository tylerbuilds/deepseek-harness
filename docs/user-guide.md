# DeepSeek Harness User Guide

DeepSeek Harness runs bounded batch work locally and leaves an evidence trail
you can inspect. The `v0.1.0` public npm package is prepared but has not been
published. Until the first registry publication, use the source installer
below; it exercises the same CLI and MCP launchers that the package smoke tests.

## First journey: install, quickstart, capabilities, MCP config

You need Node.js 24 or later, npm, and Git.

### 1. Install from the source checkout

```bash
git clone https://github.com/tylerbuilds/deepseek-harness.git
cd deepseek-harness
bash scripts/install-local.sh --install-dir "$HOME/bin" --profile core --print-config
export PATH="$HOME/bin:$PATH"
```

The source installer builds the project, creates the CLI and MCP launchers, and
prints configuration snippets. Review the script before using a non-standard
machine setup. It does not write an API key.

### 2. Prove a safe local install

```bash
deepseek-harness quickstart
```

The quickstart runs a fake canary with zero provider network calls and writes
local review artefacts. A successful response has `"ok": true`,
`"status": "ready"` and `"network_calls": 0`.

### 3. Discover capabilities

```bash
deepseek-harness capabilities
```

This returns the available workflows, safety boundaries, exit codes and MCP
profile definitions as JSON. Use `deepseek-harness capabilities --profile core`,
`deepseek-harness capabilities --profile corpus` or
`deepseek-harness capabilities --profile full` when documenting a specific
profile.

### 4. Generate MCP configuration

```bash
deepseek-harness mcp-config \
  --format codex-toml \
  --command "$HOME/bin/deepseek-harness-mcp" \
  --profile core
```

Append the generated Codex TOML to `~/.codex/config.toml`, or use the generated
JSON at `~/.config/deepseek-harness/mcp-server.json` with another MCP client.
The snippets contain local state, artefact and input paths only; they do not
contain `DEEPSEEK_API_KEY`.

## After the first registry publication

The following commands are intentionally future-only. They become available
after `deepseek-harness@0.1.0` has been published to the npm registry; they are
not evidence that publication has happened:

```bash
npm install --global deepseek-harness@0.1.0
npx --yes deepseek-harness@0.1.0 quickstart
```

The package uses the existing unscoped name `deepseek-harness`.

## Interactive Chat

Use chat for supervised coding and repository inspection in the current working
directory:

```bash
deepseek-harness chat
```

With no mode flag, chat selects the terminal UI only when both stdin and stdout
are TTYs. A pipe, redirect or other non-TTY invocation selects the plain
interface. Use `--plain` to force that classic, pipeline-friendly interface or
`--tui` to force the UI. Forced TUI mode fails with a structured
`tui_requires_tty` error unless both streams are TTYs.

```bash
deepseek-harness chat --plain
deepseek-harness chat --tui
deepseek-harness chat --list
deepseek-harness chat --resume SESSION_ID
deepseek-harness chat --model deepseek-v4-pro
deepseek-harness chat "inspect the failing tests"  # One-shot plain mode
```

`--resume` requires a session ID; use `--list` to find one. The default model
is `deepseek-v4-flash`; the supported escalation model is `deepseek-v4-pro`.

The TUI keeps the transcript visible while streaming reasoning and tool
activity. Its side panel shows the session ID, model, running cost and tokens,
and recent corpus jobs. During a mutation approval it shows the exact tool and
parameters: press `y` to allow that call once, `s` to allow that tool for the
rest of the session, or `n` to decline.

`Ctrl-C` cancels an active turn or clears the composer. `Ctrl-D` exits when the
composer is empty. The available slash commands are:

| Command | Action |
|---------|--------|
| `/help` | Show the slash commands |
| `/clear` | Clear the transcript |
| `/cost` | Show session cost and token usage |
| `/sessions` | List recent sessions |
| `/jobs` | Show recent corpus jobs |
| `/exit` | Exit chat |

Read-only tools can run without approval. File writes, exact edits, file
deletes and shell commands are mutation tools and require an interactive
approval. One-shot prompts and every non-TTY session fail closed: mutation
tools are denied instead of attempting to read approval input from a pipe.

Chat reads `DEEPSEEK_API_KEY` from the process environment. Keep the secret in
an environment or approved OS-keychain flow, inject it only when launching the
process, and never commit it to Git, manifests, documentation, logs or shell
history.

For books, OCR and translation, use the resumable `corpus` ingest and lifecycle
commands described in the [heavy corpus workflow guide](corpus-heavy-workloads.md).
Chat is a supervision and coding surface, not a place to paste an entire book
into one prompt.

## Choose an MCP profile

The MCP server exposes three bounded profiles:

| Profile | Tool groups | Use it for |
| --- | --- | --- |
| `core` | discovery, batch, safety, proof and benchmark | The default general-agent setup |
| `corpus` | discovery and corpus workflows | Corpus-only operators |
| `full` | all batch, safety, proof, benchmark and corpus tools | Agents that need both planes |

New `mcp-config` output defaults to `core`. Set `--profile core`,
`--profile corpus` or `--profile full` explicitly when generating JSON or
Codex TOML. The generated configuration carries the choice in
`DEEPSEEK_HARNESS_MCP_PROFILE`.

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

## Run a safe fake batch after discovery

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

## Reinstall or change the local profile

The installer builds the project, creates CLI and MCP launchers in the chosen
directory, and writes local MCP configuration snippets. Review the script first
if you use a non-standard machine setup.

```bash
bash scripts/install-local.sh --install-dir "$HOME/bin" --profile core --print-config
deepseek-harness doctor
```

The installer does not write an API key. Add its printed MCP configuration to
your client only after checking the state and artefact paths are appropriate for
that machine.

Use the lifecycle modes when maintaining a source installation:

```bash
bash scripts/install-local.sh --install-dir "$HOME/bin" --profile core --verify
bash scripts/install-local.sh --install-dir "$HOME/bin" --profile core --force
bash scripts/install-local.sh --install-dir "$HOME/bin" --profile core --uninstall
```

`--verify` runs the installed CLI doctor and a real MCP stdio smoke without
credentials. `--force` replaces only managed installer files and is the upgrade
or repair path. `--uninstall` removes those managed files while preserving state,
artefacts and unrelated operator files.

## Connect an MCP client

After installation, verify the stdio server:

```bash
npm run mcp:smoke -- --command "$HOME/bin/deepseek-harness-mcp"
```

For Codex, generate the TOML snippet:

```bash
deepseek-harness mcp-config \
  --format codex-toml \
  --command "$HOME/bin/deepseek-harness-mcp" \
  --profile core
```

The MCP server exposes the same operations as the CLI. It can prepare plans,
run permitted local work and return evidence; it does not become an approval,
publishing or deployment authority.

The optional `npm run mcp:inspect` command opens the MCP Inspector UI for
interactive debugging of the local stdio server. It may remain running until
you stop it, so it is never a CI or release gate and does not replace
`npm run mcp:smoke`, which remains the automated protocol smoke.

The installed-package release check is:

```bash
npm run package:smoke
```

It packs the current tree into a temporary prefix, installs that archive, then
checks the installed CLI, MCP launcher, zero-network quickstart and packaged
macOS Vision adapter. It does not publish anything.

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
npm run package:smoke
npm audit --audit-level=high
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

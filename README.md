# DeepSeek Harness

Local-first batch harness for high-throughput DeepSeek work. It is a worker
sidecar, not an approval system and not an Agent OS state writer.

## Status

- validates explicit run manifests;
- stores runs, items and events in local SQLite;
- supports fake and DeepSeek dry-run transports;
- refuses live DeepSeek calls unless a signed one-use receipt, egress, privacy, cost and side-effect gates pass;
- exposes a CLI and MCP stdio server over the same service layer;
- exports Agent OS readable state snapshots, Dispatch proposals and review packets;
- includes a gated scale-ramp command for measured concurrency tests;
- includes local agent canary, workload benchmark, privacy check, cost ledger,
  failure canary and model-comparison planning tools.
- includes a local corpus runner surface for manifest-backed shard ledgers,
  books, local OCR, translation memory/QA, JSONL datasets, long-form authoring,
  ffprobe media catalogues, preflight planning, supervision, reconciliation and
  cancellation.

## Start here

New to the harness? Follow the [user guide](docs/user-guide.md) for a safe fake
run, local CLI installation, MCP setup and the live-run approval boundary.
Operators should also read the [operator guide](docs/operator-guide.md).

The `v0.0.1` release is an MIT-licensed source release. It is intentionally not
published to npm: `package.json` remains private, and `npm run pack:check` is a
local archive-boundary check rather than a publication step. Clone the
repository and use the local installer when you want the CLI or MCP launchers
on your machine.

## Safety Contract

The harness may prepare and run batch inference artefacts. It must not write
canonical Agent OS state, apply repo changes, publish, deploy, send messages,
mutate GitHub, handle credentials, or approve its own output.

Live DeepSeek calls require:

- `egress_class: "non_sensitive_bulk"`;
- an owner-signed `approval_receipt` bound to the exact network payload, provider, model, egress and limits;
- `max_tokens` plus per-run and accumulated daily cost ceilings;
- `concurrency` within the local live cap;
- `canonical_writes: false`;
- `external_side_effects: false`;
- `DEEPSEEK_API_KEY` present in the process environment.
- `DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY` present for signature verification.

Free-form approval strings no longer authorise a live call. The harness stores a
one-use consumption record and a budget reservation before transport; if usage
is absent, the conservative reservation remains charged.

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
node dist/src/cli.js corpus ingest-text README.md --project readme-corpus --chunk-chars 30000 --overlap-chars 1000
node dist/src/cli.js corpus ingest-jsonl records.jsonl --project dataset-corpus --records-per-shard 1000
node dist/src/cli.js corpus ingest-book book.txt --project whole-book --chunk-chars 12000 --overlap-chars 1000
node dist/src/cli.js corpus ingest-ocr scans.pdf --project scans --engine auto --language en-GB
node dist/src/cli.js corpus ingest-translation source.txt --project source-fr --source-lang en --target-lang fr --glossary examples/translation-glossary.json --translation-memory translation-memory/source-fr.sqlite
node dist/src/cli.js corpus ingest-longform examples/longform-outline.json --project longform --minimum-words-per-section 800
node dist/src/cli.js corpus ingest-media media --project media-catalogue --recursive --max-files 5000
node dist/src/cli.js corpus plan examples/corpus-basic.json
node dist/src/cli.js corpus approval-packet examples/corpus-deepseek-fake.json
node dist/src/cli.js corpus start examples/corpus-basic.json
node dist/src/cli.js corpus start examples/corpus-basic.json --enqueue-only
node dist/src/cli.js corpus start examples/corpus-deepseek-fake.json
node dist/src/cli.js corpus supervise --once --max-jobs-per-cycle 4 --max-iterations-per-job 10
node dist/src/cli.js corpus status <job_id> --artifact-dir artifacts/corpus/<job_id>
node dist/src/cli.js corpus resume <job_id> --artifact-dir artifacts/corpus/<job_id>
node dist/src/cli.js corpus work <job_id> --artifact-dir artifacts/corpus/<job_id> --max-iterations 100 --interval-ms 0
node dist/src/cli.js corpus validate <job_id> --artifact-dir artifacts/corpus/<job_id>
node dist/src/cli.js corpus reconcile <job_id> --artifact-dir artifacts/corpus/<job_id>
node dist/src/cli.js corpus cancel <job_id> --artifact-dir artifacts/corpus/<job_id>
node dist/src/cli.js corpus translation-review-packet <job_id> --artifact-dir artifacts/corpus/<job_id>
node dist/src/cli.js corpus commit-translation-memory <job_id> --artifact-dir artifacts/corpus/<job_id> --review-receipt /secure/path/review-receipt.json
cargo run -p deepseek-harness-worker -- --manifest examples/basic-run.json --transport fake --concurrency 4 --output artifacts/rust-worker-basic-run.json
```

The default example uses the fake transport and performs no network calls.
The corpus runner supports deterministic text and JSONL ingest, chapter-aware
book analysis, real local image/PDF OCR, reviewed exact-match translation
memory, translation and long-form QA, curated ffprobe media catalogues,
preflight planning, crash-safe locks and bounded supervision. DeepSeek batch
processing still uses the existing fake, dry-run and live-gated transports.
JSONL ingest is streaming and file-backed; reconciliation streams without
materialising the corpus. Local/fake/dry-run workers churn bounded batches.
Live corpus calls require the normal signed receipt, API key, egress and cost
gates, must fit one signed batch, and cannot be queued or run by the persistent
supervisor.
Media transcodes, publishing, deploys and canonical Agent OS writes remain
outside the runner.

Operator docs:

- `docs/operator-guide.md`
- `docs/corpus-heavy-workloads.md`
- `docs/sprint-plan.md`

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
- `deepseek_harness_corpus_ingest_text`
- `deepseek_harness_corpus_ingest_jsonl`
- `deepseek_harness_corpus_ingest_ocr`
- `deepseek_harness_corpus_ingest_media`
- `deepseek_harness_corpus_ingest_translation`
- `deepseek_harness_corpus_ingest_book`
- `deepseek_harness_corpus_ingest_longform`
- `deepseek_harness_corpus_plan`
- `deepseek_harness_corpus_approval_packet`
- `deepseek_harness_corpus_start`
- `deepseek_harness_corpus_status`
- `deepseek_harness_corpus_resume`
- `deepseek_harness_corpus_work`
- `deepseek_harness_corpus_validate`
- `deepseek_harness_corpus_reconcile`
- `deepseek_harness_corpus_cancel`
- `deepseek_harness_corpus_translation_review_packet`
- `deepseek_harness_corpus_commit_translation_memory`
- `deepseek_harness_corpus_supervise`

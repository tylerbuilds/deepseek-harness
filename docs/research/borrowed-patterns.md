# Borrowed Patterns For The DeepSeek Harness

This note records what to borrow before adding more machinery. The goal is a
fast DeepSeek throughput engine that Codex, Agent OS or MCP clients can drive
without making the harness an approval authority.

## Current Decision

Use a Rust execution core behind the existing TypeScript CLI/MCP surface.

Do not rewrite the MCP layer in Rust yet. The current TypeScript MCP server is
working, tested and already registered in the repo contract. Rust should first
earn its place as a deterministic worker binary that can run the existing
manifest shape, emit compatible artifacts, and be called by the Node service.

## Sources To Borrow From

### MCP Rust SDK

Source: <https://github.com/modelcontextprotocol/rust-sdk>

Borrow later:

- `rmcp` as the preferred Rust MCP implementation if the MCP layer moves out of
  TypeScript;
- tool macros for strongly typed tool inputs;
- stdio transport patterns;
- resource exposure patterns for state snapshots and review packets.

Do not borrow yet:

- a premature full MCP rewrite. It adds protocol risk before the worker core has
  proven value.

### MCP Reference Servers

Source: <https://github.com/modelcontextprotocol/servers>

Borrow:

- clear tool names and narrow tool surfaces;
- stdio-first server shape;
- simple install snippets that MCP clients can run directly.

Do not borrow:

- broad filesystem or shell authority. This harness should remain a batch
  inference sidecar.

### LiteLLM

Sources:

- <https://github.com/BerriAI/litellm>
- <https://docs.litellm.ai/docs/routing>

Borrow:

- provider abstraction;
- explicit model/provider metadata;
- routing ideas such as weighted, rate-limit-aware, latency-aware and cost-aware
  selection;
- cost/accounting fields in run summaries;
- fallback policy as data, not hidden control flow.

Do not borrow:

- a proxy-server architecture as the default. This repo should stay local-first
  and operator-controlled unless a separate bridge PR proves a daemon is useful.

### Pydantic AI

Source: <https://github.com/pydantic/pydantic-ai>

Borrow:

- typed output contracts as a first-class concept;
- validation retry budgets;
- explicit durable-execution thinking for long-running workflows.

Do not borrow:

- an agent framework runtime. The harness is a worker, not the reasoning layer.

### llmq

Source: <https://github.com/iPieter/llmq>

Borrow:

- separation between job submission and result collection;
- resumable result retrieval;
- multiple result consumers;
- queue-oriented thinking for large batches.

Do not borrow:

- RabbitMQ or remote worker infrastructure in the default local harness. Start
  with SQLite and artifact files; add external queues only behind a new approval
  gate.

### Rust Async Rate Limiting

Source: <https://github.com/mindeng/async-rate-limiter>

Borrow:

- token-bucket style rate limiting;
- async-runtime friendly acquisition before calls;
- timeout-aware limit acquisition.

Preferred Rust stack:

- `tokio` for async runtime;
- `reqwest` for HTTP;
- `serde` / `serde_json` for manifest compatibility;
- `clap` for CLI;
- `anyhow` / `thiserror` for error boundaries;
- `rusqlite` or `sqlx` only once the Rust worker writes durable state directly.

## Proposed PR Sequence

### PR 1: DSH-10 Borrowed-Patterns Design

Docs only.

- record sources and what to borrow;
- update sprint plan;
- no runtime changes.

Proof:

- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

### PR 2: DSH-11 Rust Worker Core

Add a Rust workspace with a `deepseek-harness-worker` binary.

Minimum behaviour:

- read the existing manifest shape from JSON;
- support fake transport only;
- run a bounded concurrent batch;
- emit a JSON report compatible enough for Node to ingest later;
- no live DeepSeek calls;
- no SQLite writes yet unless this stays very small.

Proof:

- `cargo test`;
- `cargo run -p deepseek-harness-worker -- --manifest examples/basic-run.json --transport fake --concurrency 5`;
- existing `npm run typecheck`;
- existing `npm test`.

### PR 3: DSH-12 Node Bridge And Adaptive Worker

Bridge TypeScript CLI to the Rust binary.

Minimum behaviour:

- `node dist/src/cli.js worker-run ...` or equivalent;
- Rust report lands under `artifacts/`;
- adaptive concurrency chooses the next concurrency from observed throughput and
  error rate;
- retry/backoff is explicit and bounded.

Proof:

- Rust tests;
- Node tests;
- local fake worker run;
- `agent-os-repo-proof --repo . --level quick --run --json`.

## Non-Goals

- no live DeepSeek calls in the Rust worker until fake mode and bridge mode are
  proven;
- no daemon by default;
- no command-centre state writes;
- no repo apply, deploy, publish or send authority;
- no secrets in config, artifacts, tests or docs.

## Acceptance Standard

Each PR must be useful alone, easy to revert, and reviewable without trusting a
large cross-language diff. The TypeScript harness remains the user-facing
surface until the Rust worker has proven a better operational path.

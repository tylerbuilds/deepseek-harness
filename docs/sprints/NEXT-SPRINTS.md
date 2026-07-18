# Next Sprints

## Recently Implemented Locally

`DSH-BATCH-1-8` added the local agent utility pack:

- agent usability canary;
- workload benchmark pack;
- failure injection;
- cost and usage ledger;
- MCP utility macros;
- golden artefact tests;
- privacy classifier;
- fake/dry-run model comparison planning.

## DSH-12 Storage And Conformance Contract

Skills: `rust-cli-with-sqlite`, `testing-conformance-harnesses`.

Goal: prepare the storage and cross-runtime contract before giving the Rust
worker more authority.

Deliverables:

- sync strategy;
- recovery runbook;
- conformance plan;
- fixture/golden layout;
- coverage matrix.

Exit proof:

- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

## DSH-13 Public Security And Dependency Gate

Skills: `security-audit`, `secure-deps`.

Goal: public repo safety baseline after visibility changed to public.

Deliverables:

- security baseline;
- dependency review;
- public contribution/security posture;
- audit commands and known gaps.

Exit proof:

- `npm audit --audit-level=high`;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

## DSH-14 Installable MCP/CLI Bridge

Skills: `mcp-server-design`, `installer-workmanship`,
`agent-ergonomics-and-intuitiveness-maximization-for-cli-tools`.

Goal: make the harness installable instead of source-only.

Deliverables:

- local bin wrappers;
- MCP config snippet;
- `doctor` checks for Node, repo path and env posture;
- public README install section.

## DSH-15 Rust Worker Import Bridge

Skills: `rust-cli-with-sqlite`, `parallel-llm-batch-processing`,
`testing-conformance-harnesses`.

Goal: import Rust worker reports into the TypeScript store safely.

Deliverables:

- Node bridge command;
- report import lock;
- conformance tests against fixtures;
- no live DeepSeek in Rust yet.

## DSH-16 Adaptive Retry And Throughput

Skills: `parallel-llm-batch-processing`, `testing-metamorphic`,
`testing-golden-artifacts`.

Goal: make throughput adaptive and reliable.

Deliverables:

- bounded retry/backoff;
- adaptive concurrency selection;
- metamorphic tests proving item counts and ids survive concurrency changes;
- golden worker reports.

## DSH-17 OCR And Document Ingest Lane

Status: released in v0.0.1 for local image/PDF OCR. Future work is limited to
additional engines and fixtures; it does not expand external egress authority.

Skills: `mcp-server-design`, `parallel-llm-batch-processing`,
`testing-golden-artifacts`.

Goal: maintain the local screenshot/PDF OCR-to-document workflow without
weakening the existing DeepSeek API safety contract.

Context:

- Slack may be a useful capture surface, but it should not be treated as the
  OCR system of record.
- DeepSeek-OCR remains a separate model/runtime path, not a drop-in replacement
  for the current chat-completions transport.
- OCR inputs may contain private or sensitive text, so live external egress must
  stay blocked by default until the data classification and approval route are
  explicit.

Deliverables:

- benchmark corpus of screenshots and PDFs with expected Markdown outputs;
- baseline adapters for local OCR and DeepSeek-OCR via a local or controlled
  OpenAI-compatible endpoint;
- manifest extension proposal for file/image inputs, artifact paths, redaction
  notes and OCR confidence metadata;
- MCP macro design for "screenshots in, reviewable document out";
- QA report that compares OCR output against source images and flags uncertain
  lines, table/layout drift and missing text.

Exit proof:

- fixture-based OCR benchmark with golden Markdown artifacts;
- privacy/egress gate tests for image/PDF inputs;
- MCP smoke proving agents can discover the OCR lane without confusing it with
  text-only batch inference;
- no Slack, Drive, WordPress, repo-apply or external document writes without a
  separate approval route.

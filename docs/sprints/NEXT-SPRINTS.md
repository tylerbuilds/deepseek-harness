# Next Sprints

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

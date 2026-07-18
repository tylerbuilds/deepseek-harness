# Dependency Review — v0.0.1 — 2026-07-18

## Scope and outcome

This review covers the dependencies declared by the source release's npm and
Rust manifests. The project is a local CLI/MCP sidecar, not a hosted service.
`package.json` is intentionally private to npm and the Rust workspace is
configured with `publish = false`; no package publication is implied by this
review.

The Node audit was clean at review time. The Rust tests passed, but neither
`cargo audit` nor `cargo deny` is installed in this environment, so no Rust
advisory database result is claimed here.

## Node dependencies

Direct runtime dependencies:

- `@modelcontextprotocol/sdk`
- `zod`

Direct development dependencies:

- `@types/node`
- `typescript`

Checks:

```bash
npm audit --audit-level=high
npm ls --all --depth=2
```

Observed result: `npm audit --audit-level=high` reported zero vulnerabilities;
`npm ls --all --depth=2` resolved the lockfile without invalid or missing
required dependencies.

`@modelcontextprotocol/sdk` supplies the MCP protocol surface. `zod` keeps
manifest and receipt validation explicit. TypeScript and `@types/node` are
build-time dependencies.

## Rust dependencies

The fake worker depends on:

- `anyhow`
- `clap`
- `hex`
- `serde`
- `serde_json`
- `sha2`
- `tokio`

These dependencies support the local fake worker and its report format. The
worker is not a live provider client and is not published as a crate.

```bash
cargo test --locked
cargo audit
cargo deny check
```

`cargo test --locked` passed for this review. The two advisory-audit commands
were unavailable locally; run one of them in CI or a release environment before
making a future dependency or transport change.

## Dependency rules

- Do not add a dependency for a trivial helper.
- Keep live provider SDKs out until the existing guarded transport is shown to
  be insufficient.
- Avoid external queue, database or daemon dependencies in the local sidecar.
- Re-run the Node and Rust dependency checks when lockfiles or release
  boundaries change.

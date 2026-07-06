# Dependency Review - 2026-07-06

## Verdict

Current `main` dependency posture is acceptable for a pre-release public CLI/MCP
tool.

## Node Dependencies

Direct runtime dependencies:

- `@modelcontextprotocol/sdk`
- `zod`

Direct development dependencies:

- `@types/node`
- `typescript`

Audit result:

```bash
npm audit --audit-level=high
```

Result: `0` vulnerabilities.

## Dependency Notes

- `@modelcontextprotocol/sdk` brings a larger transitive tree than the harness
  itself, including HTTP/server packages used by the SDK. This is acceptable
  because MCP compatibility is core functionality.
- `zod` is justified for runtime manifest validation and keeps safety gates
  explicit.
- `typescript` and `@types/node` are standard build-time dependencies.

## Rust Dependencies

Rust dependencies are not on `main` yet. PR #2 proposes:

- `anyhow`
- `clap`
- `hex`
- `serde`
- `serde_json`
- `sha2`
- `tokio`

Preliminary review:

- These are mainstream Rust crates with clear purpose.
- They are appropriate for a fake worker CLI.
- Before merging Rust live transport or SQLite writes, add dependency audit
  tooling such as `cargo audit` or `cargo deny`.

## Resist-By-Default Rules

- Do not add a dependency for trivial helpers.
- Avoid long-running daemons or web server dependencies until the source-only
  CLI/MCP bridge is proven.
- Avoid external queue/database dependencies until SQLite/JSONL recovery is
  implemented.
- Do not add live provider SDKs until the current fetch/HTTP path is shown to be
  insufficient.

## Next Dependency Gates

- Add CI for `npm audit --audit-level=high`.
- Add Rust dependency audit after PR #2 lands.
- Review licences before choosing the repo licence.
- Re-run this review before first tagged release.

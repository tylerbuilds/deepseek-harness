# Contributing to DeepSeek Harness

Thanks for improving the harness. Keep changes small, documented and safe for
local-first use.

## Before you start

1. Open an issue for a substantial feature or behaviour change so the intended
   safety boundary is clear.
2. Work on a branch from `main`.
3. Never add API keys, approval receipts, customer prompts, local state,
   artefacts or translation-memory SQLite files to Git.

## Development loop

Use Node.js 24 or later, npm and the Rust toolchain:

```bash
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run mcp:smoke
npm run pack:check
cargo test --locked
```

Use fake or dry-run manifests for tests and examples. Do not make live provider
calls merely to validate a contribution.

## Pull requests

- Explain the user-facing behaviour and the safety impact.
- Update the user or operator documentation when commands, manifests or MCP
  tools change.
- Add focused coverage for a new public behaviour or a repaired regression.
- Keep generated runtime output out of the pull request.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).

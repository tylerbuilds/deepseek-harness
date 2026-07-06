# DSH-14 MCP Install Hard-Truth Audit - 2026-07-06

## Verdict Before This Slice

Not ready to call installable.

The MCP server could be started from source with `node dist/src/mcp.js`, but that
is not enough for real operator use. The missing pieces were:

- no committed local installer;
- no stable launcher command for MCP clients;
- no generated no-secret MCP config snippet;
- no SDK-based MCP smoke test;
- README tool list omitted `deepseek_harness_work`;
- no install proof command in the operator path.

## Target Ready State

Ready means:

- TypeScript builds successfully;
- `deepseek-harness` and `deepseek-harness-mcp` launchers can be installed;
- MCP config can be generated without secrets;
- an MCP client can connect, list tools and call `deepseek_harness_doctor`;
- local proof passes after install.

## Authority Boundary

- no live DeepSeek calls;
- no API key stored in config;
- no command-centre state write;
- no deploy, publish or send;
- local install writes only operator launchers and a no-secret config snippet.

## Proof Commands

```bash
npm run typecheck
npm test
npm run mcp:smoke
bash scripts/install-local.sh --install-dir "$HOME/bin" --force --print-config
npm run mcp:smoke -- --command "$HOME/bin/deepseek-harness-mcp"
agent-os-repo-proof --repo /Users/tyler/Code/control-plane/deepseek-harness --level quick --run --json
git diff --check
```

## Verdict After This Slice

Ready for local MCP use.

Installed locally on the operator machine:

- `/Users/tyler/bin/deepseek-harness`
- `/Users/tyler/bin/deepseek-harness-mcp`
- `/Users/tyler/.config/deepseek-harness/mcp-server.json`
- `/Users/tyler/.config/deepseek-harness/codex-mcp-server.toml`

The Codex MCP entry was added to `/Users/tyler/.codex/config.toml` using the
same no-secret state/artifact environment as the generated TOML snippet.

Proof run on 2026-07-06:

- `npm run typecheck`: pass
- `npm test`: pass, 12/12 tests
- `npm run mcp:smoke`: pass, 12 MCP tools listed and `doctor` ok
- `bash scripts/install-local.sh --install-dir /Users/tyler/bin --force --print-config`: pass
- `npm run mcp:smoke -- --command /Users/tyler/bin/deepseek-harness-mcp`: pass
- `npm audit --audit-level=high`: pass, 0 vulnerabilities
- `cargo test`: pass, 3/3 tests
- `agent-os-repo-proof --repo /Users/tyler/Code/control-plane/deepseek-harness --level quick --run --json`: pass
- `git diff --check`: pass
- tracked-file secret/path scan for state, artifacts, env files and common token patterns: pass

No live DeepSeek calls were made and no `DEEPSEEK_API_KEY` value was stored in
repo docs, generated snippets or Codex config.

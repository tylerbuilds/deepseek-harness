# Agent OS Integration

DeepSeek Harness is an Agent OS engineering harness. It can produce local proof
artefacts and read-model snapshots, but it is not a canonical state writer.

## Route

```text
Tyler/Codex -> MCP/CLI -> DeepSeek Harness -> local artefacts
Agent OS -> reads exported state/review packets -> decides next route
Codex -> reconciles outputs and final proof
```

## Boundaries

- Direct writes to protected private-workspace state are blocked by the harness.
- Live DeepSeek inference requires an owner-signed, one-use exact-payload receipt and `allow-live`.
- Local repo apply, deploy, publish, send, GitHub write and qmd refresh are out of scope.
- Agent OS owns queue state, canonical memory and closeout; the separate owner approval authority signs inference receipts.

## Read Model

Use:

```bash
node dist/src/cli.js state --output artifacts/deepseek-harness-state.json
```

The output schema is `deepseek-harness.state.v1`. Agent OS can ingest or mirror
that file through an approved route later.

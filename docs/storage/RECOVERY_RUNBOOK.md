# Recovery Runbook

## Symptoms

- `doctor` reports SQLite integrity failure.
- JSONL export cannot parse.
- A review packet is missing items that SQLite reports as completed.
- A worker report import is interrupted.
- Version markers or stable hashes do not match.

## Principles

- SQLite is the primary store for live local runs.
- JSONL is a recovery and inspection artefact.
- Imports are explicit recovery actions, never automatic startup behaviour.
- Do not overwrite a newer valid store with an older artefact.

## Steps

1. Stop active harness processes.
2. Acquire `.state/deepseek-harness.lock`.
3. Run `doctor` and future `integrity_check`.
4. Identify the freshest valid source:
   - SQLite if `integrity_check` passes.
   - Latest matching JSONL export if SQLite is corrupt.
   - Provider/review artefacts only if both stores are damaged.
5. Rebuild the target store in a temp path.
6. Compare record counts and stable hash.
7. Atomically replace the damaged target.
8. Export a fresh review packet or state snapshot.
9. Release the lock.

## Future Commands

```bash
node dist/src/cli.js doctor
node dist/src/cli.js state --output artifacts/deepseek-harness-state.json
node dist/src/cli.js export-review-packet <run_id>
node dist/src/cli.js export-jsonl --output artifacts/deepseek-harness-runs.jsonl
node dist/src/cli.js import-jsonl artifacts/deepseek-harness-runs.jsonl --rebuild-db .state/deepseek-harness.sqlite
```

The `export-jsonl` and `import-jsonl` commands are planned, not implemented in
the current main branch.

## Verification

- `PRAGMA integrity_check` returns `ok`.
- Run count matches between SQLite and JSONL.
- Item count matches between SQLite and JSONL.
- Stable hash matches for sorted records.
- `state` output includes the recovered runs.

## Manual Rollback

- Keep the damaged DB as `.state/deepseek-harness.sqlite.corrupt.<timestamp>`.
- Keep failed imports under `artifacts/recovery/`.
- Never delete provider output artefacts during recovery.

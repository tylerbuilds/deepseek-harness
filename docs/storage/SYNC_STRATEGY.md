# Sync Strategy

## Source Of Truth

- Primary: SQLite.
- Human/audit export: JSONL.
- Rationale: batch runs need fast status reads, resumable writes, and atomic
  item/event updates. JSONL is useful for inspection, Git-friendly review
  packets, backup and recovery, but it should not be the live write surface.

The TypeScript harness currently owns SQLite writes. The proposed Rust worker
must not write SQLite until its fake report contract is proven and the Node
bridge can import reports safely.

## Sync Direction

Use one-way sync only:

- SQLite to JSONL for exports, review packets and human-readable audit trails.
- JSONL to SQLite only for explicit recovery/import commands.

Do not perform two-way reconciliation in one command.

## Sync Triggers

- On command: `state`, `export-review-packet`, future `export-jsonl`.
- On exit: not required for normal runs; each item write should already be
  committed to SQLite by the owning runtime.
- Timer/throttle: not required for local CLI use. Add only if a daemon bridge is
  introduced later.

## Versioning

- DB marker: future `metadata` table row keyed by `state_version`.
- JSONL marker: first line or sidecar object with `schema_version`,
  `exported_at`, `source_db_path`, `run_id` where applicable, record count and
  stable hash.
- Report schemas:
  - `deepseek-harness.state.v1`
  - `deepseek-harness.review-packet.v1`
  - `deepseek-harness.worker-report.v1`

## Concurrency

- SQLite mode: WAL.
- Lock file path: `.state/deepseek-harness.lock`.
- Busy timeout: 5 seconds.
- Single writer per run. Parallel item work may fan out, but state writes should
  be serialized through the owning store layer.
- Rust worker report import should acquire the lock before importing into
  SQLite.

## SQLite Settings

Target settings for the future Rust store layer:

```rust
conn.pragma_update(None, "journal_mode", "WAL")?;
conn.pragma_update(None, "synchronous", "NORMAL")?;
conn.pragma_update(None, "wal_autocheckpoint", 1000)?;
conn.pragma_update(None, "foreign_keys", "ON")?;
conn.set_busy_timeout(std::time::Duration::from_secs(5))?;
```

Use `synchronous=FULL` only if we start storing non-reconstructible state. Current
state is reconstructible from manifests, provider results and artefacts.

## JSONL Exports

- Write to a temp file in the same directory.
- Flush and fsync the temp file.
- Atomically persist/rename over the target.
- Keep the previous file intact on failure.
- Include counts and stable hash so imports can verify the export.

## Failure Handling

- DB locked: retry until busy timeout, then exit non-zero with a clear lock
  error.
- JSONL parse error: do not import; report the exact line and preserve existing
  SQLite state.
- Interrupted export: old JSONL remains valid; retry the export.
- Mismatched counts or hashes: stop import and write a recovery diagnostic.
- Git commit error: keep files on disk and let the operator decide.

## Open Implementation Work

- Add `export-jsonl` and `import-jsonl` commands.
- Add `.state/deepseek-harness.lock`.
- Add stable hash calculation for exported run/item/event records.
- Add `PRAGMA integrity_check` to `doctor`.
- Add a report-import path for the Rust worker once PR #2 lands.

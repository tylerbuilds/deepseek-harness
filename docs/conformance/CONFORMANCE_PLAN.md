# Conformance Plan

This harness now has two intended implementations of the same batch contract:
the TypeScript CLI/MCP runtime and the proposed Rust worker core. Conformance
tests must make that contract mechanical before the Rust worker gains live
network or SQLite authority.

## Specification Source

The contract is repo-local:

- run manifest schema: `deepseek-harness.run.v1`
- state schema: `deepseek-harness.state.v1`
- review packet schema: `deepseek-harness.review-packet.v1`
- worker report schema: `deepseek-harness.worker-report.v1`

The TypeScript schema and fake transport are the current reference
implementation until a neutral JSON Schema fixture is added.

## Required Behaviour Matrix

| Requirement | Level | Reference | Test Status |
| --- | --- | --- | --- |
| Accept `deepseek-harness.run.v1` manifests with prompt items | MUST | TypeScript schema | Planned |
| Reject non-`non_sensitive_bulk` egress for external worker paths | MUST | TypeScript execution plan | Planned |
| Reject `canonical_writes: true` | MUST | TypeScript execution plan | Planned |
| Reject `external_side_effects: true` | MUST | TypeScript execution plan | Planned |
| Keep fake transport offline and zero-cost | MUST | TypeScript fake transport | Planned |
| Produce stable item ids in output reports | MUST | TypeScript review packets | Planned |
| Preserve item count across concurrency values | MUST | scale-ramp tests | Planned |
| Sort or otherwise deterministically compare item outputs | SHOULD | review packet export | Planned |
| Emit schema/version metadata in reports | SHOULD | state/review exports | Planned |

## Fixture Layout

```text
test/fixtures/manifests/
  basic-run.json
  json-object-run.json
  blocked-sensitive-run.json
test/fixtures/golden/
  basic-run.node.golden.json
  basic-run.rust.golden.json
docs/conformance/
  CONFORMANCE_PLAN.md
  DISCREPANCIES.md
  COVERAGE.md
```

## Harness Shape

1. Load a manifest fixture.
2. Run the TypeScript fake path.
3. Run the Rust fake path.
4. Normalise non-deterministic fields such as timestamps and absolute paths.
5. Compare:
   - item ids;
   - item count;
   - status counts;
   - fake digest/content shape;
   - authority flags.
6. Write a compliance summary.

## Coverage Accounting

| Area | MUST Clauses | SHOULD Clauses | Tested | Passing | Divergent | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Manifest acceptance/rejection | 4 | 0 | 0 | 0 | 0 | 0 |
| Fake output compatibility | 3 | 1 | 0 | 0 | 0 | 0 |
| Authority flags | 3 | 0 | 0 | 0 | 0 | 0 |
| Report metadata | 1 | 1 | 0 | 0 | 0 | 0 |

Current status: planned, not conformant yet. This is intentional until PR #2
lands and the cross-runtime fixture runner is added.

## Known Discrepancies To Decide

- TypeScript fake content and Rust fake content may hash slightly different
  payloads. The conformance layer should compare the contract shape first and
  only require byte-identical content after a shared digest spec is written.
- TypeScript currently persists SQLite state; Rust worker reports JSON only.
  This is an intentional phase boundary.

## Next Implementation Slice

- Add fixtures under `test/fixtures/`.
- Add a Node conformance runner that can invoke the Rust binary when present.
- Add golden normalisation for timestamps and paths.
- Fail CI if MUST clauses regress.

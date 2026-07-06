# Security Audit Baseline - 2026-07-06

## Verdict

GO for public source visibility with documented caveats.

This is not a SaaS launch gate. The project is a public local CLI/MCP harness,
with no auth, payments, hosted backend, user accounts, customer database or
browser surface in the current `main` branch.

## Context

- Phase: pre-release public repository.
- Scale: developer/operator tool.
- Markets: public GitHub source, no hosted service.
- Data sensitivity: source code and local non-sensitive test manifests only.
- Regulated industry: none in repo runtime.
- External provider use: DeepSeek API only when explicitly approved and
  configured by the operator.

## Evidence Commands

```bash
npm audit --audit-level=high
npm ls --all --depth=2
git ls-files | rg -n '(^artifacts/|^target/|^\\.state/|(^|/)\\.env|approval-packet|live-scale-ramp-approved|DEEPSEEK_API_KEY|sk-|gho_|api[_-]?key)' || true
rg -n "TODO|unsafe|eval\\(|exec\\(|spawn\\(|Authorization|Bearer|DEEPSEEK_API_KEY|password|secret|token|key" src test examples docs README.md package.json agentos.service.yml || true
```

Results:

- `npm audit --audit-level=high`: passed, `0` vulnerabilities.
- tracked-file secret/artefact scan: no matches for tracked artefacts, state,
  env files, approval packets or obvious token patterns.
- source keyword scan: expected references to `DEEPSEEK_API_KEY`, bearer auth
  construction in the live transport, and documented no-secret policy.

## Gate Table

| Gate | Status | Notes |
| --- | --- | --- |
| Auth/session | PASS | No auth/session surface. |
| Payments | PASS | No payments surface. |
| Data privacy | PASS | No hosted user data store; sensitive egress blocked for live DeepSeek. |
| Infrastructure | PASS | Local-only tool; no deploy target. |
| Application security | WARN | Live transport exists; approval/egress/cost gates are present and tested. |
| Supply chain | WARN | npm audit clean; Rust dependency review pending until PR #2 lands. |
| Observability/IR | WARN | Public `SECURITY.md` added; no release process yet. |
| Compliance/legal | WARN | Repository is public but has no explicit open-source licence on `main`. |
| Abuse/fraud | PASS | No public hosted API or account creation. |
| Business continuity | PASS | Source pushed to GitHub; local artefacts remain intentionally untracked. |

## Risk Register

| ID | Severity | Status | Finding | Mitigation |
| --- | --- | --- | --- | --- |
| SEC-001 | MEDIUM | Open | No explicit open-source licence on `main`; public source is not reusable as open source until a licence is chosen. | Add `LICENSE` after maintainer chooses MIT, Apache-2.0 or another intended licence. |
| SEC-002 | LOW | Mitigated | Live DeepSeek path could leak sensitive prompts if a bad manifest is forced through. | Existing gates require `non_sensitive_bulk`, real approval id, live flags, cost cap and API key presence. Tests cover blocked paths. |
| SEC-003 | LOW | Open | No CI security gate yet. | Add GitHub Actions for npm audit, tests, Rust tests once Rust PR lands, and public-safety scans. |

## Follow-Up

- Choose and add an explicit licence.
- Add CI for tests and audit commands.
- Re-run dependency audit after PR #2 adds Rust dependencies to `main`.
- Add conformance tests before Rust gains live DeepSeek or SQLite write
  authority.

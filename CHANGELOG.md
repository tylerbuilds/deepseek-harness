# Changelog

All notable changes to this project are documented here. This file records
release and release-candidate artefacts, not every commit or local proof run.

## [0.1.0] - 2026-07-18

Prepared the public npm CLI/MCP package release candidate. This version is not
published to npm; publication remains available only through the manual,
protected release workflow after the `v0.1.0` tag is reviewed.

### Added

- Public package metadata for the existing unscoped `deepseek-harness` name,
  with public access and npm provenance enabled.
- A `prepack` build gate, explicit archive boundary, and installed-package
  smoke covering the CLI, MCP server, quickstart, and macOS Vision adapter.
- A manual release workflow with exact tag/version matching, the full CI
  command set, npm pack boundary proof, one exact tarball plus SHA-256 checksum,
  GitHub Release attachment, and optional OIDC trusted publishing of that same
  tarball.
- Product onboarding for `quickstart`, `capabilities`, and the `core`,
  `corpus`, and `full` MCP profiles.
- A machine-readable DeepSeek V4 routing strategy: Flash for default throughput,
  Pro for bounded escalation, and an explicit comparison path for Cockpit clients.
- A self-contained source installation with verify, repair/upgrade and
  ownership-safe uninstall modes that preserve local state and artefacts.
- MCP tool annotations, structured discovery responses and protocol-level
  error signalling for agent clients.

### Changed

- CLI help and unknown-flag handling now fail before work starts, suggest close
  command matches and return stable machine-readable exit codes.
- Local SQLite state now records a schema version and refuses state created by
  a newer incompatible harness version before mutation.

### Security

- The source installer remains the current installation route until the first
  registry publication. No npm publication is claimed by this changelog.
- Live DeepSeek calls remain behind the existing signed authority, privacy,
  cost and side-effect gates.

## [0.0.1] - 2026-07-18

Initial public source release.

### Added

- Local-first CLI and MCP server for validated, bounded batch inference with
  fake and dry-run modes for safe workflow testing.
- Explicit approval, privacy, cost and side-effect gates for live DeepSeek
  batches; live authority is one-use and payload-bound.
- Resumable corpus workflows for books, JSONL datasets, OCR, translations,
  long-form authoring and media catalogues.
- Local installation, MCP smoke testing and end-to-end test surfaces.
- Public onboarding, contribution, security and community-health documentation.

### Security

- The source release excludes local runtime state, artefacts, translation
  memories, environment files and internal agent evidence.
- npm publication was intentionally disabled for this historical source
  release; the current `0.1.0` candidate has a separate manual publication
  path.

Representative implementation commits:

- [`9b5a17f`](https://github.com/tylerbuilds/deepseek-harness/commit/9b5a17fce1f63c35e5be5c02be15a4ee08cc4dba)
  adds the heavy corpus workload plane.
- [`2811170`](https://github.com/tylerbuilds/deepseek-harness/commit/2811170212c458979e66ac9f9ca2f2b83219b86e)
  hardens live-inference authority and budgets.
- [`42df8b5`](https://github.com/tylerbuilds/deepseek-harness/commit/42df8b5a847ecb3709f32ae7538cafbd434295b1)
  adds end-to-end verification.

[0.0.1]: https://github.com/tylerbuilds/deepseek-harness/releases/tag/v0.0.1

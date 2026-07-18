# Changelog

All notable changes to this project are documented here. This file records
released source artefacts, not every commit or local proof run.

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
- The package remains private to npm; this release is source-first and does not
  enable package publication.

Representative implementation commits:

- [`9b5a17f`](https://github.com/tylerbuilds/deepseek-harness/commit/9b5a17fce1f63c35e5be5c02be15a4ee08cc4dba)
  adds the heavy corpus workload plane.
- [`2811170`](https://github.com/tylerbuilds/deepseek-harness/commit/2811170212c458979e66ac9f9ca2f2b83219b86e)
  hardens live-inference authority and budgets.
- [`42df8b5`](https://github.com/tylerbuilds/deepseek-harness/commit/42df8b5a847ecb3709f32ae7538cafbd434295b1)
  adds end-to-end verification.

[0.0.1]: https://github.com/tylerbuilds/deepseek-harness/releases/tag/v0.0.1

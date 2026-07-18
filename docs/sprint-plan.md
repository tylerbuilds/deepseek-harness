# DeepSeek Harness Roadmap

## v0.0.1

The first public source release includes the local CLI and MCP server, safe fake
and dry-run workflows, approval-gated live batches, and the corpus plane for
books, OCR, translations, JSONL datasets, long-form sections and media
catalogues.

## Non-negotiable boundaries

- Live DeepSeek calls require a separately issued, one-use receipt for the
  exact payload plus explicit live flags and cost limits.
- The harness does not publish, deploy, send messages, change GitHub or approve
  its own output.
- Local state, artefacts, translation memory and provider credentials stay out
  of Git.

## Next areas to validate

- Optional Rust execution parity behind the existing TypeScript CLI and MCP
  surface.
- Measured local throughput guidance across supported machines and source sizes.
- Additional OCR engines and fixtures without expanding egress authority.

See the [changelog](../CHANGELOG.md) for release history and the
[heavy corpus guide](corpus-heavy-workloads.md) for current supported workflows.

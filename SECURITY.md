# Security Policy

## Supported Versions

This project is pre-release. Security fixes target the default branch until the
first tagged release exists.

## Reporting A Vulnerability

Please open a private GitHub security advisory for this repository if available.
If that is not available, contact the maintainer through the GitHub profile for
`tylerbuilds`.

Do not include raw credentials, API keys, tokens, private prompts, customer data
or live provider responses in public issues.

## Scope

In scope:

- secret leakage risks;
- unsafe live DeepSeek execution paths;
- bypasses of approval, egress, cost or side-effect gates;
- MCP tool behaviours that expose secrets or mutate state unexpectedly;
- dependency vulnerabilities.

Out of scope:

- model output quality;
- prompt-injection claims without a concrete harness impact;
- social engineering against maintainers;
- denial-of-service against local development machines.

## Current Security Posture

- The harness is a local CLI/MCP sidecar.
- Live DeepSeek calls are disabled by default.
- Live calls require explicit approval metadata and caller flags.
- Raw API keys must be provided only through the process environment.
- `artifacts/`, `.state/`, `target/`, `.env` and logs are ignored by git.
- The harness must not write canonical Agent OS state, deploy, publish, send
  messages, approve its own output, or apply repo changes.

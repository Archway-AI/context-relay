# Public Scope

## One-Line Positioning

Context Relay keeps agent context lean without losing the evidence.

## Longer Positioning

Context Relay summarizes noisy agent context, stores the raw artifact, and gives
Claude Code, Codex, and API agents a way to retrieve the original output before
making correctness-sensitive decisions.

## Supported Surface

The CLI supports:
- `context-relay run -- <command>` for high-noise shell commands
- `context-relay raw -- <command>` for exact passthrough
- `context-relay retrieve <artifact-id>` for raw artifact recovery
- `context-relay stats` for raw, compressed, retrieval, fallback, and token
  accounting

The fixture set covers:
- passing test logs
- failing test logs
- large search output
- git status or diff output
- large JSON/tool result
- retrieval miss
- secret/PII detection

## Never Compress By Default

Context Relay must pass through:
- latest user prompts
- active edit targets
- exact diagnostics requested by the user
- auth and security diagnostics, with secret-redaction safeguards
- unknown output classes
- streaming output that cannot be safely buffered
- content where the summary would be larger than the raw output

Secrets and PII must be blocked or redacted, never summarized.

## Claims Boundary

Allowed claims:
- reduces token load on noisy fixtures when measurements show it
- preserves raw evidence behind summaries
- makes retrieval explicit and auditable
- defaults to passthrough when safety is uncertain

Disallowed claims without task-specific public evals:
- zero accuracy loss
- universal compression
- hosted ChatGPT or Claude web UI interception
- prompt-cache savings counted as compression savings
- memory-system behavior

## Release Gate

Do not publish a release until:
- the CLI works in under five minutes from a fresh checkout
- fixture pass rate is 100%
- retrieval round-trip pass rate is 100%
- false-success failures are zero
- security/privacy storage docs are complete
- token reduction is reported as measured fixture output, not promised as a
  general benchmark

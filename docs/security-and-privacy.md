# Security And Privacy Scope

Context Relay stores raw command and tool output so agents can retrieve exact
evidence behind compressed summaries. That storage boundary is the main safety
surface.

## Storage Model

The CLI uses a local-only artifact store by default.

Required properties:
- artifacts are scoped to the local workspace/session
- artifact IDs are opaque and non-guessable
- summaries include retrieval pointers, not embedded raw sensitive content
- raw artifacts have TTL metadata
- expired or missing artifacts fail closed, never summary-only
- corrupt artifacts fail closed with a clear error

## Retention

Default retention is intentionally short. Local artifacts expire after eight
hours unless the caller configures a different store policy.

The public CLI includes:
- default TTL
- explicit `context-relay cleanup` and `context-relay cleanup --all` commands
- fixture mode for permanent test artifacts only

## Sensitive Data

Secrets and PII are not compression candidates.

Required behavior:
- block or redact detected secrets before summary generation
- do not include secret-looking strings in retrieval markers
- preserve redaction metadata
- treat unknown detector failures as passthrough or hard fail, not summarize

Auth and security diagnostics are passthrough by default because exact text often
matters. If they contain secrets, secret-redaction safeguards still apply.

## Boundary Limits

Context Relay does not inspect or intercept hosted ChatGPT or Claude web UI
traffic.

The supported surfaces are:
- explicit CLI wrappers
- local SDK middleware
- local proxy mode
- MCP/tool retrieval surfaces where installed explicitly

## User Responsibilities

Before using Context Relay on sensitive output, understand:
- where raw artifacts live
- how long artifacts are retained
- how cleanup works
- what is redacted or blocked
- what remains the user's responsibility
- why retrieval can fail and what to do next

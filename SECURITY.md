# Security Policy

Context Relay stores raw command output locally so agents can retrieve exact
evidence behind summaries. Treat artifact stores as sensitive workspace data.

## Supported Versions

Security updates target the latest published `0.x` release until a stable `1.0`
policy is defined.

## Reporting A Vulnerability

Please open a private security advisory in GitHub for this repository.

Do not include secrets, credentials, private logs, or customer data in public
issues. If a reproduction needs sensitive output, redact it or provide a
synthetic fixture that demonstrates the behavior.

## Local Artifact Safety

- Raw artifacts are local by default.
- Artifact IDs are opaque and include TTL metadata.
- Secret-like output is blocked before storage when detected.
- `context-relay cleanup` removes expired artifacts.
- `context-relay cleanup --all` removes all artifacts and counters in the
  selected store.

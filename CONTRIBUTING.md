# Contributing

Context Relay is intentionally conservative. Contributions should preserve the
core contract: summaries are navigation aids, raw artifacts remain retrievable,
and safety boundaries win over token savings.

## Local Setup

Requirements:
- Node.js 22 or newer
- Git

Run:

```bash
npm test
npm run quickstart
```

No provider credentials, API keys, cloud services, or hosted agent accounts are
required for the test suite.

## Development Rules

- Keep the CLI dependency-free unless a dependency removes real complexity.
- Add fixtures or tests for every new compression, retrieval, or policy rule.
- Do not summarize output that looks secret-bearing or correctness-critical.
- Preserve child process exit codes.
- Keep raw artifact retrieval explicit and auditable.
- Do not add public claims about zero accuracy loss without eval evidence.

## Pull Request Checklist

- `npm test` passes.
- Fresh-clone quickstart still works.
- New public docs avoid local absolute paths, private issue links, secrets, and
  customer data.
- Limitations are updated when behavior changes.
- Release checklist is updated when packaging changes.

## Security Reports

Please do not open public issues for suspected secret leakage, unsafe artifact
storage, or retrieval bypasses. Use the private security reporting channel for
the repository once it is public. Until then, report privately to the
maintainers.

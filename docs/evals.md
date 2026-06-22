# Fixture Evals

Context Relay ships deterministic fixture evals so users can inspect the local
compression contract.

Run:

```bash
npm run eval
```

The eval writes [eval-results.json](eval-results.json) and checks four things:

- noisy output is summarized into fewer bytes than the raw output
- exact raw output can be retrieved from the artifact pointer
- child process exit codes are preserved
- secret-like output is blocked and not stored

These are launch-readiness fixtures, not a broad task-accuracy benchmark. They
do not prove zero accuracy loss for arbitrary agent work. They prove the local
contract on representative deterministic outputs.

## Current Results

| Case | Raw bytes | Summary bytes | Targeted retrieval bytes | Reduction after targeted retrieval | Exact retrieval | Exit code preserved |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| quickstart-log | 1,428 | 963 | 132 | 23.3% | Pass | Pass |
| search-style-output | 9,816 | 1,519 | 836 | 76.0% | Pass | Pass |
| json-tool-output | 2,455 | 1,025 | 150 | 52.1% | Pass | Pass |
| failing-log | 2,632 | 1,341 | 527 | 29.0% | Pass | Pass |

Secret-block fixture:

- blocked: Pass
- artifact created: No
- secret absent from relayed output: Pass

The committed JSON report is the source of truth for exact numbers because byte
counts can vary slightly by Node/npm environment and repository path length.

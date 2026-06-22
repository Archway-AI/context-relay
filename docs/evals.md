# Fixture Evals

Context Relay ships deterministic fixture evals so users can inspect the local
compression contract.

Run:

```bash
npm run eval
```

The eval writes [eval-results.json](eval-results.json) and checks five things:

- noisy output is summarized into fewer bytes than the raw output
- exact raw output can be retrieved from the artifact pointer
- targeted retrieval returns the expected evidence-line count
- child process exit codes are preserved
- secret-like output is blocked and not stored

The top-level reduction metric is split in two:

- **Summary-only reduction** compares raw output to the compact Context Relay
  summary. This is the apples-to-apples comparison against tools that advertise
  only summary compression.
- **After targeted retrieval** compares raw output to the summary plus the raw
  evidence slice retrieved by the agent. This is the stricter day-to-day metric.

These are deterministic fixture evals, not a broad task-accuracy benchmark.
They do not prove zero accuracy loss for arbitrary agent work. They prove the
local evidence contract on representative deterministic outputs.

## Current Results

Summary:

| Metric | Result |
| --- | ---: |
| Compression fixtures | 8 |
| Exact raw retrieval | 8/8 |
| Exit code preservation | 8/8 |
| Targeted retrieval oracle | 8/8 |
| Summary-only byte reduction | 32.6-97.0% |
| Byte reduction after targeted raw retrieval | 21.4-91.7% |
| Secret block | Pass |

Cases:

| Case | Raw bytes | Summary bytes | Targeted bytes | Summary-only reduction | After targeted retrieval | Accuracy gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| quickstart-log | 1,428 | 963 | 132 | 32.6% | 23.3% | Pass |
| search-style-output | 9,816 | 1,519 | 836 | 84.5% | 76.0% | Pass |
| large-test-log | 53,481 | 1,629 | 5,276 | 97.0% | 87.1% | Pass |
| typescript-diagnostics | 5,808 | 2,152 | 2,412 | 62.9% | 21.4% | Pass |
| git-diff-like-output | 8,833 | 1,200 | 377 | 86.4% | 82.1% | Pass |
| json-tool-output | 2,455 | 1,025 | 150 | 58.2% | 52.1% | Pass |
| large-json-tool-output | 24,860 | 1,430 | 623 | 94.2% | 91.7% | Pass |
| failing-log | 2,632 | 1,341 | 527 | 49.1% | 29.0% | Pass |

Secret-block fixture:

- blocked: Pass
- artifact created: No
- secret absent from relayed output: Pass

The committed JSON report is the source of truth for exact numbers because byte
counts can vary slightly by Node/npm environment and repository path length.

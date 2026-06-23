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
| Summary-only byte reduction | 36.6-97.1% |
| Byte reduction after targeted raw retrieval | 22.4-92.0% |
| Secret block | Pass |

Cases:

| Case | Raw bytes | Summary bytes | Targeted bytes | Summary-only reduction | After targeted retrieval | Accuracy gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| quickstart-log | 1,428 | 906 | 132 | 36.6% | 27.3% | Pass |
| search-style-output | 9,816 | 1,462 | 836 | 85.1% | 76.6% | Pass |
| large-test-log | 53,481 | 1,572 | 5,276 | 97.1% | 87.2% | Pass |
| typescript-diagnostics | 5,808 | 2,095 | 2,412 | 63.9% | 22.4% | Pass |
| git-diff-like-output | 8,833 | 1,143 | 377 | 87.1% | 82.8% | Pass |
| json-tool-output | 2,455 | 968 | 150 | 60.6% | 54.5% | Pass |
| large-json-tool-output | 24,860 | 1,373 | 623 | 94.5% | 92.0% | Pass |
| failing-log | 2,632 | 1,284 | 527 | 51.2% | 31.2% | Pass |

Secret-block fixture:

- blocked: Pass
- artifact created: No
- secret absent from relayed output: Pass

The committed JSON report is the source of truth for exact numbers because byte
counts can vary slightly by Node/npm environment and repository path length.

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
- secret-like output is blocked and stored only as a verified-redacted artifact

The top-level reduction metric is split in two:

- **Summary-only reduction** compares raw output to the compact Context Relay
  summary. This is the apples-to-apples comparison against tools that advertise
  only summary compression.
- **After targeted retrieval** compares raw output to the summary plus the raw
  evidence slice retrieved by the agent. This is the stricter day-to-day metric.

These are deterministic fixture evals, not a broad task-accuracy benchmark.
They do not prove zero accuracy loss for arbitrary agent work. They prove the
local evidence contract on representative deterministic outputs.

## Metrics

Numbers come from two surfaces. `context-relay stats` and `context-relay gain`
read the append-only local event log; `npm run eval` reports on the fixture
matrix and writes [eval-results.json](eval-results.json).

`runs` counts wrapped command events only: compressed, passthrough, raw, and
blocked runs. Retrievals are recorded as separate events and are not runs, so a
run-relative rate can exceed 1.

| Metric | Surface | Formula | Meaning |
| --- | --- | --- | --- |
| `compression_savings_pct` | `stats`, `gain` | alias of `gross_efficiency_percent` = `gross_saved_bytes / raw_bytes * 100` | Share of raw child-process bytes never relayed to the agent, before any raw evidence is retrieved back. The stricter net counterpart is `net_efficiency_percent`, which also subtracts retrieved bytes. This is an alias, not a second computation. |
| `retrieval_rate` | `stats`, `gain` | `retrievals / runs` | How often a run is followed by pulling raw evidence back out of an artifact. Low means summaries are usually sufficient; high means the summary is losing evidence agents need. |
| `blocked_rate` | `stats`, `gain` | `blocked / runs` | Share of runs whose output matched the secret or PII policy and was withheld. A rising rate means agent commands keep touching sensitive output. |
| `fallback_rate` | `stats`, `gain` | `fallbacks / runs` | Share of runs that fell back to raw passthrough because the artifact store write failed (`reasonCode` `CR_STORE_FAILED`). This is a store-health signal: a non-zero rate means compression was intended but could not be delivered. |
| `eval_pass_rate` | `npm run eval` | `eval_cases_passed / eval_cases` | Share of fixture cases where every assertion recorded for the case held. A compression case passes on exact retrieval, exit-code preservation, and the targeted-retrieval oracle; the secret case passes when output is blocked, no artifact is written, and the secret is absent from the relayed output. Per-case results are in the `case_passed` field. |

Rates are ratios rounded to three decimals, not percentages. When the
denominator is zero the metric reports `0` rather than `NaN` or `Infinity`, so a
store with no runs reports `0` on every rate.

### Descoped: `cache_savings`

`cache_savings` was named in the original metrics request and is deliberately
not implemented. Context Relay is a local shell wrapper: it spawns a child
process, writes the raw output to a local artifact, and relays a pointer. There
is no cache tier anywhere in that path: no prompt cache, no response cache, and
no reuse of a previous run's output, so there is no hit/miss population to
measure. The metric came from an API-middleware design that does not apply to a
local CLI. Do not re-add it unless a cache is added first.

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
| Eval pass rate | 1 (9/9 cases) |

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
- redacted artifact created: Yes
- secret absent from relayed output: Pass
- redacted artifact free of the secret: Pass

The committed JSON report is the source of truth for exact numbers because byte
counts can vary slightly by Node/npm environment and repository path length.

Re-running the eval on the same machine and Node version reproduces every
measured field. Only `generated_at` differs between runs, so compare reports
with that field excluded.

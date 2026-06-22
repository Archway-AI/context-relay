# Token Delta Table

Use measured fixture and sample-workflow numbers only. Do not generalize these into a
universal benchmark.

| Scenario | Raw bytes | Summary bytes | Retrieval bytes | Reduction before retrieval | Reduction after retrieval |
| --- | ---: | ---: | ---: | ---: | ---: |
| W5 quickstart fixture | 1,428 | about 0.96-0.98 KB | 44 | about 31-33% | about 28-30% |
| Larger agent-workflow sample | 24,012 | 5,556 | 289 | 76.9% | 75.7% |

Notes:
- Token estimates use the current Context Relay heuristic of about four bytes
  per token.
- The W5 quickstart fixture is intentionally small so the demo is readable.
  Summary bytes vary slightly because the envelope includes command metadata,
  current working directory, duration, and artifact id.
- The larger agent-workflow sample included shell-heavy tests, repo search, mocked JSON tool
  output, and a failing command.
- Retrieval is counted because correctness-sensitive agents should retrieve raw
  evidence when summaries are insufficient.

Safe launch phrasing:

> On our included fixtures, Context Relay reduces noisy output while preserving
> a local pointer to the raw artifact. Your workloads need their own evals.

Unsafe launch phrasing:

> Context Relay gives zero-accuracy-loss compression for every agent task.

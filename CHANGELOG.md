# Changelog

## Unreleased

- Adds `compression_savings_pct`, `retrieval_rate`, `blocked_rate`, and
  `fallback_rate` to `stats` and `gain`.
- Adds `eval_pass_rate` and per-case `case_passed` to the fixture eval report.
- Adds CLI coverage for search and `git status` summaries and for the shipped
  JSON tool fixture.
- Documents every reported metric and records `cache_savings` as descoped.

## 0.1.0

- Initial public Context Relay CLI.
- Adds reversible summaries for noisy command output.
- Stores raw artifacts locally with explicit retrieval pointers.
- Adds retrieval, inspect, stats, gain, discover, cleanup, dry-run, and raw
  passthrough modes.
- Adds secret-blocking safeguards for detected sensitive output.

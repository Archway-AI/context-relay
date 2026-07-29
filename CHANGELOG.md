# Changelog

## Unreleased

- Adds `compression_savings_pct`, `retrieval_rate`, `blocked_rate`, and
  `fallback_rate` to `stats` and `gain`.
- Adds `eval_pass_rate` and per-case `case_passed` to the fixture eval report.
- Adds CLI coverage for search and `git status` summaries and for the shipped
  JSON tool fixture.
- Documents every reported metric and records `cache_savings` as descoped.
- Retargets secret detection onto labeled assignments and known provider key
  shapes. Generic high-entropy token matching is removed, so git SHAs, UUIDs,
  checksums, and base64 blobs are no longer destroyed as false-positive secrets.
- Matches a credential keyword as a whole name part of its label, so prefixed
  environment-variable forms (`AWS_SECRET_ACCESS_KEY=`, `DB_PASSWORD=`,
  `GITHUB_TOKEN=`, `STRIPE_SECRET_KEY=`), JSON credentials
  (`"password": "..."`), and `Authorization: Bearer` headers are blocked.
  Accounting labels such as `tokens=0` stay unblocked.
- Blocks a labeled assignment only when its value could be a credential. Masked,
  empty, templated and placeholder values (`password=********`, `password: ""`,
  `${{ secrets.X }}`, `[FILTERED]`, `<redacted>`, `<your-api-key>`,
  `password: null`, `api_key=,`) are relayed instead of destroying the whole
  command output — including `git log` in this repository, whose own commit
  messages describe the label shapes being detected.
- Consumes quoted values whole, so a multi-word passphrase no longer leaves its
  tail behind after redaction, and covers an opening quote with no closing quote
  (`api_key="hunter2...`). On the blocked path every matched line is destroyed,
  not only the matched span.
- Blocks a credential whose value lives on the following line: YAML block
  scalars (`password: |`, `client-secret: >`, `password: |-`, `password: |2-`)
  and shell backslash continuations. The whole indented block is consumed, so
  multi-line secrets in helm values, Kubernetes manifests and workflow YAML no
  longer relay in full.
- Fixes redaction ordering on the blocked path to PEM, then spans, then lines.
  The line pass previously ran first and sliced a quoted value that spanned a
  newline, letting its tail survive into a stored artifact marked as redacted.
- Relays presence and size markers that tools print instead of a credential:
  `(sensitive value)`, `16 bytes`, `(set)`, `undefined`, `unset`, `N/A`.
- Keeps a digest readable when it carries a short non-credential prefix
  (`sha=<40 hex>`), which the opaque-token pass previously destroyed.
- Blocked envelopes relay no content from the blocked output — command, exit
  code, counts and the artifact marker only.
- Exempts hex runs from generic redaction only at real digest lengths (32, 40,
  64), so hex secrets of other lengths, such as a 48-character HMAC signing key,
  are redacted instead of preserved.
- Blocked output now stores a verified-redacted, retrievable artifact instead of
  being discarded. Storage happens only when re-detection on the redacted text
  finds nothing; otherwise the run reports `CR_BLOCK_SECRET_UNSTORABLE` and
  stores nothing. Retrieval of a redacted artifact notes it on stderr.
- Preserves the child process exit code when the local artifact store is
  unavailable, and reports the degradation once on stderr as `CR_STORE_FAILED`.
- Matches a credential label without consuming the delimiter in front of it. The
  previous form ate that character, so a global replace resuming immediately
  after one match could not see the next label: two adjacent block scalars
  redacted only the first and left the second credential on disk, and a match
  that swallowed the preceding newline destroyed an innocent line above it.
- Blocks a YAML block scalar whose body starts after a blank line
  (`password: |` followed by an empty line). An empty block scalar still does not
  reach across into the next unindented key.
- Relays compact JSON placeholder literals such as `{"password": null}` and
  `{"api_key": "<value>"}`. Only the spaced forms were exempt, so the compact
  ones destroyed the whole output.
- Narrows the wrapper-placeholder exemption: `<...>` and `[...]` innards of 16 or
  more characters containing both a digit and a letter are no longer treated as
  documentation stand-ins, so `api_key=<hunter2realvalue123>` is blocked while
  `API_KEY=<your-api-key>` and `[FILTERED]` still relay. `${...}` template
  references are unaffected.
- Destroys orphaned continuation lines on the blocked path: lines indented
  deeper than a destroyed line, and lines continued from it by a shell
  backslash. Sibling keys at the same indent are preserved. Where a value
  continues by indentation or a backslash, this makes an under-consuming pattern
  a loss of context rather than a leak of residue into a stored artifact. It does
  not cover a value continued by a delimiter the indent rule cannot see — a
  heredoc body sits at equal indent and still reaches the artifact, on this and
  every prior version. See `docs/limitations.md`.

## 0.1.0

- Initial public Context Relay CLI.
- Adds reversible summaries for noisy command output.
- Stores raw artifacts locally with explicit retrieval pointers.
- Adds retrieval, inspect, stats, gain, discover, cleanup, dry-run, and raw
  passthrough modes.
- Adds secret-blocking safeguards for detected sensitive output.

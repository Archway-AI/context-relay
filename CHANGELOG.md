# Changelog

## Unreleased

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

## 0.1.0

- Initial public Context Relay CLI.
- Adds reversible summaries for noisy command output.
- Stores raw artifacts locally with explicit retrieval pointers.
- Adds retrieval, inspect, stats, gain, discover, cleanup, dry-run, and raw
  passthrough modes.
- Adds secret-blocking safeguards for detected sensitive output.

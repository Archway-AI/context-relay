# Changelog

## Unreleased

- Narrows secret detection to labeled assignments and known provider key shapes.
  Generic high-entropy token matching is removed, so git SHAs, UUIDs, checksums,
  and base64 blobs are no longer destroyed as false-positive secrets.
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

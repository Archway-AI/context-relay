# Demo Terminal Transcript

This transcript is the source material for a launch GIF or short terminal clip.
It uses synthetic fixture output and a temporary local store.

## 1. Run

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo CONTEXT_RELAY_RUN_ID=demo \
  node bin/context-relay.js run --mode compress -- node examples/noisy-test-log.js
```

Representative output:

```text
CR compressed output
command: node examples/noisy-test-log.js
exit_code: 0
mode: reversible_summary
reason: CR_REVERSIBLE_SUMMARY
raw: [artifact:cr:cr_demo_... bytes=1428 tokens=357 reason=CR_REVERSIBLE_SUMMARY retrieve="context-relay retrieve cr_demo_..."]

summary:
raw_lines: 40
raw_estimated_tokens: 357
highlights:
- file1.ts:1:TODO item 1 status=ok
- file2.ts:2:TODO item 2 status=ok
- file3.ts:3:TODO item 3 status=ok
...
- file11.ts:11:TODO item 11 status=warning
```

## 2. Retrieve

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo \
  node bin/context-relay.js retrieve cr_demo_... --grep "TODO item 22"
```

Representative output:

```text
22:file22.ts:22:TODO item 22 status=warning
```

## 3. Stats

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo \
  node bin/context-relay.js stats
```

Measured W5 fixture output:

```json
{
  "runs": 1,
  "raw": 0,
  "compressed": 1,
  "passthrough": 0,
  "blocked": 0,
  "retrievals": 1,
  "retrieval_miss": 0,
  "raw_bytes": 1428,
  "sent_bytes": 966,
  "retrieval_bytes": 44
}
```

Interpretation:
- In clean W5 package-root runs, summary bytes landed around 0.96-0.98 KB
  because the envelope includes variable command metadata.
- Summary plus retrieval bytes were about 28-30% smaller than raw bytes in
  these small fixture runs.
- The retrieval step kept the raw evidence available for exact inspection.

These are fixture numbers, not general benchmark claims.

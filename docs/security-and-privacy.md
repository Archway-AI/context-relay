# Security And Privacy Scope

Context Relay stores raw command and tool output so agents can retrieve exact
evidence behind compressed summaries. That storage boundary is the main safety
surface.

## Storage Model

The shipped CLI stores artifacts as local JSON files under `~/.context-relay` by
default. `CONTEXT_RELAY_STORE_DIR` selects a different local store. Artifact
records include workspace and repository metadata, but retrieval is not scoped
or access-controlled by workspace or session; anyone who can read the selected
store can read its artifact files.

Artifact IDs contain randomly generated components. Stored artifacts include
expiry metadata and a SHA-256 content hash. CLI retrieval returns explicit
errors for missing, expired, schema-mismatched, or hash-mismatched artifacts.
Compressed output includes a retrieval pointer only after the artifact write
succeeds; if that write fails, the CLI reports the store failure and passes
through non-blocked output without compression.

## Retention

Artifacts have a fixed eight-hour expiry. The shipped CLI does not expose a TTL
configuration or a permanent fixture mode. Expiry prevents retrieval but does
not remove the JSON file automatically: `context-relay cleanup` removes expired
artifacts, and `context-relay cleanup --all` removes all artifacts and the local
event log from the selected store.

## Sensitive Data

The shipped policy is heuristic detection of documented secret shapes. It is not
complete secret prevention, and there is no separate general-purpose PII policy.
See [limitations.md](limitations.md#secret-detection) for covered shapes, known
false positives, and known gaps.

When the detector matches output, the CLI replaces detected material and whole
affected lines with `[REDACTED_SECRET]`, then runs the same detector over that
redacted text. If the detector no longer matches, the CLI stores the redacted
copy with redaction metadata. Its blocked envelope contains the redacted command,
execution/count metadata, and artifact pointer, but no content from the blocked
output. If the verification gate does not pass, the CLI stores and relays none
of the command output and reports `CR_BLOCK_SECRET_UNSTORABLE`. A blocked-path
store failure likewise does not fall back to relaying the unredacted output.

The `raw` command and `run --mode raw` stream output without secret filtering.
Use them only when the output is safe to show directly to the agent.

## Boundary Limits

Context Relay does not inspect or intercept hosted ChatGPT or Claude web UI
traffic.

The shipped surfaces are explicit CLI command wrapping and CLI artifact
retrieval. Optional `PreToolUse` hook installers provide automatic Bash command
wrapping for Claude Code and Codex. API-based agents can use Context Relay only
by invoking the CLI explicitly around tool execution.

SDK middleware, a local proxy, and MCP retrieval surfaces are future work; they
are not implemented in the shipped CLI.

## User Responsibilities

Before using Context Relay on sensitive output, review the selected store's
filesystem access, the fixed retention and cleanup behavior, the heuristic
secret-detection gaps, and the unfiltered `raw` escape hatch.
Correctness-sensitive work should retrieve the relevant artifact before relying
on a compressed summary, while the artifact remains available.

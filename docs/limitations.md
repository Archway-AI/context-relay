# Limitations

Context Relay is a local, explicit wrapper. It is not a general-purpose
compression layer for every agent context.

## Accuracy

Summaries are not a substitute for raw evidence. Agents should retrieve the
artifact before making correctness-sensitive decisions, especially for:
- failing tests
- compiler diagnostics
- migration output
- security findings
- customer-impacting logs
- final answers that cite exact output

Do not claim zero accuracy loss without task-specific evals.

## Secret Detection

Secret detection is heuristic. Context Relay blocks common labeled secrets,
`sk-...` values, JWT-like values, private-key headers, and opaque token-like
strings, but it cannot guarantee complete secret discovery.

Use `raw` only for commands whose output is safe to show directly to an agent.

## Storage

Raw artifacts are stored locally. Anyone with filesystem access to the selected
store can read the raw artifact files.

Default store:

```text
~/.context-relay
```

Use `CONTEXT_RELAY_STORE_DIR` for project-local or temporary stores. Use
`cleanup` for expired artifacts and `cleanup --all` to remove all artifacts and
event counters in that store.

## Surfaces Not Covered

Context Relay does not intercept:
- hosted ChatGPT web traffic
- hosted Claude web traffic
- model-provider prompt caches
- agent memory stores

Supported surfaces are explicit local CLI wrappers first. SDK middleware and
local proxy modes are future work.

## Current Implementation Gaps

- Artifact storage is local JSON files, not encrypted storage.
- Cleanup is local-store only.
- Summaries are deterministic heuristics, not model-generated eval summaries.
- There is no hosted artifact browser.
- There is no default-on shell interception.
- API-agent request/response middleware is not implemented yet.

## Public Claims Boundary

Allowed:
- measured byte/token reduction on provided fixtures
- raw evidence remains retrievable
- retrieval, fallback, blocked, and byte counters are auditable locally

Not allowed:
- universal token savings
- zero accuracy loss
- full secret prevention
- automatic ChatGPT or Claude subscription-plan maximization
- production readiness without your own evals

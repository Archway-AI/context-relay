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

Secret detection is heuristic and shape-based. Context Relay blocks labeled
assignments (`api_key=`, `secret:`, `token=`, `password=`) and known provider key
shapes: `sk-...`, Stripe `sk_live_`/`sk_test_`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/
`ghr_` and `github_pat_`, AWS `AKIA`/`ASIA` key ids, Slack `xox*-`, Google
`AIza...`, GitLab `glpat-`, JWT-like values, and private-key headers. It cannot
guarantee complete secret discovery.

When output is blocked, the raw text is not relayed. Instead Context Relay
redacts it and stores the redacted copy as an artifact — but only after
re-running detection over the redacted text finds nothing. That verification gate
is what makes the stored copy safe; output that cannot pass it is dropped
entirely, with reason code `CR_BLOCK_SECRET_UNSTORABLE`.

Explicit non-goal: bare unlabeled opaque strings are **not** blocked. Detection
deliberately does not treat generic high-entropy tokens as secrets, because git
SHAs, UUIDs, checksums, npm integrity hashes, and base64 blobs are routine
command output and destroying them removes the evidence the tool exists to
preserve. A random-looking string echoed on its own, with no label and no
recognizable key prefix, will pass through.

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
- Claude Code shell wrapping is opt-in through `context-relay init --claude`.
- Codex shell wrapping is opt-in through `context-relay init --codex` and
  requires hook trust review before non-managed hooks run.
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

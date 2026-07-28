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
assignments where the credential keyword is a whole *name part* of the label —
so `AWS_SECRET_ACCESS_KEY=`, `DB_PASSWORD=`, `GITHUB_TOKEN=` and
`STRIPE_SECRET_KEY=` are covered, not only the bare `api_key=` form. Recognised
keywords are `api_key`/`apikey`, `access_key`, `private_key`, `secret`, `token`,
`password`, `passwd`, `pwd`, `credential`/`credentials` and `authorization`, in
any case, joined by `_`, `-` or `.`. JSON and quoted forms
(`"password": "..."`) and `Authorization: Bearer <token>` headers are covered as
well, and quoted values are consumed whole, so a multi-word passphrase leaves no
tail behind.

Known provider key shapes are also blocked: `sk-...`, Stripe
`sk_live_`/`sk_test_`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and
`github_pat_`, AWS `AKIA`/`ASIA` key ids, Slack `xox*-`, Google `AIza...`,
GitLab `glpat-`, JWT-like values, and private-key headers. It cannot guarantee
complete secret discovery.

Label forms knowingly left uncovered, so that a *destructive* action does not
fire on ordinary output:

- A keyword that is only a substring of a name part rather than a whole part.
  `tokens=0` and `raw_estimated_tokens: 5231` are accounting labels, not
  credentials, and are deliberately not blocked.
- A bare `key=` or `auth:` label with no other credential keyword. Both are far
  too common in ordinary configuration and status output.
- An `sk-` key glued to the tail of a longer word (`...disk-<20 chars>`). The
  leading word boundary is kept on this one shape, because `sk-` is a
  three-character low-entropy prefix and dropping it would turn ordinary
  hyphenated words into blocking false positives. Every other prefixed shape is
  matched even when embedded inside a longer token.

When output is blocked, the raw text is not relayed. Instead Context Relay
redacts it and stores the redacted copy as an artifact — but only after
re-running detection over the redacted text finds nothing. That verification gate
is what makes the stored copy safe; output that cannot pass it is dropped
entirely, with reason code `CR_BLOCK_SECRET_UNSTORABLE`.

On the blocked path, redaction destroys every *line* that matched, not just the
matched span. A pattern that under-consumes a value would otherwise leave a
residue that no longer looks like a secret, so it would pass the gate and be
written to disk. Lines that did not match are preserved, so the artifact stays
useful as evidence.

The blocked envelope itself relays **no content** from the blocked output — only
the command, exit code, line and token counts, and the artifact marker.
Retrieving the artifact is the single deliberate way to read the redacted text.

Hex runs are exempt from generic redaction only at real digest lengths — exactly
32, 40 or 64 characters (md5, SHA-1/git SHA, SHA-256). Hex secrets of other
lengths, such as a 48-character HMAC signing key, are redacted rather than
preserved.

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

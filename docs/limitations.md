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
tail behind. An opening quote with no closing quote — a truncated
`api_key="hunter2...` line — is covered too.

A label whose value lives on the **following** line is covered as well: YAML
block scalars (`password: |`, `client-secret: >`, `password: |-`, `password: |2-`)
and shell backslash continuations (`PASSWORD=\`). This is how multi-line secrets —
SSH keys, certificates, PEM bodies — are written in helm values, Kubernetes
manifests, docker-compose files and CI workflow YAML. The whole indented block is
consumed, not just the introducer, so no part of the value survives redaction.

A labeled assignment is blocked only when its **value could be a credential**.
Values that are, by construction, not credentials are relayed:

- CI template references: `${VAR}`, `${{ secrets.MY_KEY }}`
- masks: `password=********`, `password: ""`
- filtered-log markers and documentation placeholders: `[FILTERED]`,
  `<redacted>`, `<your-api-key>`
- empty and literal values: `api_key=,`, `"password": "..."`, `password: null`
- presence and size markers printed instead of a credential:
  `password = (sensitive value)` (terraform), `password:  16 bytes` (kubectl),
  `AWS_SECRET_ACCESS_KEY=(set)`, `API_KEY=undefined`, `client_secret: N/A`
- an auth scheme word followed by prose rather than a token:
  `Authorization: Bearer are all detected`

Blocking these is not a harmless over-reaction — it destroys the whole command's
output. It also makes the tool block on documentation *about* itself: this
repository's own commit messages name the label shapes above, so an unguarded
pattern turns `git log` in this repository into `CR_BLOCK_SECRET`. The guard
requires a value to contain at least one alphanumeric character and to be
something other than a placeholder in its entirety, which costs no coverage —
`token: <x>REALSECRETVALUE` is still blocked, and so is every real-shaped value
on every label listed above.

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
- **A real value wrapped whole in placeholder punctuation.** The value guard
  above is syntactic: `api_key=[value]`, `api_key=<value>` and
  `api_key=${resolved}` are relayed even when the text inside the brackets is a
  live credential rather than a documentation stand-in. The pre-change baseline
  blocked these. Glued forms are still blocked — `token: <x>REALSECRET`,
  `password=****hunter2real` and nested brackets all match — so the gap is
  confined to a credential that is, character for character, indistinguishable
  from a placeholder.
- **Plural label forms.** `api_keys: [...]`, `"passwords": [...]` and
  `secrets: [...]` are not blocked. The singular keyword must be a whole name
  part, and the trailing `s` prevents that. This matches the pre-change baseline;
  it is named here rather than fixed, because the plural forms in practice carry
  list values (`[...]`), which the value guard above already treats as a
  placeholder, so adding them to the keyword list would not block the shapes that
  motivate it.
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

On the blocked path, redaction runs in a fixed order — PEM blocks, then spans,
then lines — and destroys every *line* that ends up holding a redaction, not just
the matched span. The order matters in both directions. Running the line pass
first would slice a match that spans a newline: for a quoted value written across
two lines the first line was destroyed and the tail survived as residue that no
longer looked like a secret, so it passed the gate and reached disk. Running only
the span pass would leave the tail of a value the pattern under-consumed, on its
own line. Lines with no redaction on them are preserved, so the artifact stays
useful as evidence.

The blocked envelope itself relays **no content** from the blocked output — only
the command, exit code, line and token counts, and the artifact marker.
Retrieving the artifact is the single deliberate way to read the redacted text.

Hex runs are exempt from generic redaction only at real digest lengths — exactly
32, 40 or 64 characters (md5, SHA-1/git SHA, SHA-256). Hex secrets of other
lengths, such as a 48-character HMAC signing key, are redacted rather than
preserved. A digest carrying a short non-credential prefix (`sha=<40 hex>`) keeps
the exemption; a credential-shaped prefix (`token=`, `sig=`, `hmac=`) does not.

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

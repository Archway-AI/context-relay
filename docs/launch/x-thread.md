# Conservative X Thread Draft

## Post 1

Agents do not need 40k tokens of logs.

They need the lines that matter, plus a way to retrieve the raw output when
they are unsure.

Context Relay keeps agent context lean without losing the evidence.

## Post 2

The first version is intentionally small:

- wrap noisy commands
- summarize output
- store the raw artifact locally
- retrieve exact lines when needed
- track raw, summary, retrieval, and blocked bytes

No hosted UI interception. No magic memory layer.

## Post 3

Example:

```bash
context-relay run -- npm test
context-relay retrieve cr_demo_... --grep "failed"
context-relay stats
```

Summaries help the agent navigate. Retrieval keeps exact evidence available.

## Post 4

On the included W5 quickstart fixture:

- raw: 1,428 bytes
- summary: about 0.96-0.98 KB
- retrieved evidence: 44 bytes
- reduction after retrieval: about 28-30%

On a larger agent-workflow sample, reduction after retrieval was 75.7%.

These are measured examples, not universal claims.

## Post 5

Important limits:

- secret detection is heuristic
- raw artifacts are local files
- raw mode bypasses filtering by design
- this does not intercept hosted ChatGPT or Claude web UIs
- no zero-accuracy-loss claim without your own evals

## Post 6

The contract is simple:

Summarize bulky artifacts into pointers.
Preserve critical evidence raw.
Retrieve exact output before correctness-sensitive decisions.

Repo: https://github.com/Archway-AI/context-relay

Install:

```bash
npm install -g @archwayai/context-relay
```

## Short Single-Post Version

Agents do not need 40k tokens of logs. They need the lines that matter, plus a
way to retrieve raw output when unsure.

Context Relay wraps noisy commands, summarizes output, stores raw artifacts
locally, and exposes explicit retrieval plus stats.

No universal compression claims. No hosted UI interception. Just a small,
testable CLI contract.

Repo: https://github.com/Archway-AI/context-relay

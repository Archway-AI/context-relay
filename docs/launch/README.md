# Launch Assets

This folder contains the conservative public launch package for Context Relay.

Use these assets only after the public repository is ready:
- README quickstart works from a fresh clone.
- Tests pass without provider credentials.
- Limitations are visible before benchmark-style claims.
- A maintainer is assigned for post-launch triage.

## Assets

- `terminal-transcript.md`: demo transcript showing `run`, `retrieve`, and
  `stats`.
- `token-deltas.md`: measured fixture and sample-workflow byte/token deltas.
- `x-thread.md`: conservative X launch thread draft.
- `triage.md`: first-week issue triage owner and response plan.

## Launch Angle

Agents do not need 40k tokens of logs. They need the lines that matter, plus a
way to retrieve the raw output when they are unsure.

Context Relay keeps agent context lean without losing the evidence.

## Claims Boundary

Do not claim:
- zero accuracy loss
- universal compression
- hosted ChatGPT or Claude web UI interception
- production readiness without user-side evals
- subscription-plan maximization as a guaranteed outcome

Allowed claims:
- measured reduction on the included fixtures
- raw artifact retrieval is explicit
- summaries are navigation aids, not source-of-truth evidence
- local CLI works without provider credentials

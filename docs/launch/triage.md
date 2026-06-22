# Post-Launch Triage

## Owner

Launch owner: Mike Weber.

Escalation context: security-sensitive reports, claim-boundary questions, and
anything involving raw artifact leakage should be moved out of public issue
threads before investigation.

Owner responsibilities for the first week:
- review new issues daily
- label reports as bug, docs, security, feature, or question
- reproduce bugs against `npm test` and `npm run quickstart`
- keep claims conservative in replies
- move security-sensitive reports out of public discussion

## Labels

Recommended first labels:
- `bug`
- `docs`
- `feature`
- `security`
- `question`
- `good first issue`
- `needs reproduction`
- `claim-boundary`

## First Response Templates

### Bug

Thanks for the report. Please include:
- Node.js version
- operating system
- command run
- expected behavior
- actual behavior
- whether `npm test` passes
- whether the output may contain secrets

Do not paste secrets or private logs. Redact or use a synthetic reproduction.

### Feature

Thanks. Context Relay is intentionally conservative right now. Please describe:
- the agent workflow
- output type and size
- why explicit retrieval is still safe
- what should pass through unchanged

### Security

Thanks for flagging this. Please do not post exploit details, credentials, or
private output publicly. A maintainer will move this to the private security
channel before investigation.

## Triage SLA

For launch week:
- security reports: same day acknowledgement
- reproducible bugs: two business days
- docs fixes: best effort
- broad feature requests: collect until the first post-launch planning pass

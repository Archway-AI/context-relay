# Trusted Publishing Setup

Context Relay should publish from GitHub Actions using npm Trusted Publishing
instead of a long-lived `NPM_TOKEN`.

## npm Package Settings

After the first package record exists on npm, configure a trusted publisher:

- Publisher: GitHub Actions
- Organization: `Archway-AI`
- Repository: `context-relay`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

## GitHub Environment

Create a GitHub environment named `npm` and require manual approval before
deployment. The publish workflow already uses this environment.

## Release Flow

1. Confirm `npm test` passes.
2. Confirm `npm run quickstart` passes.
3. Confirm `npm run eval` passes.
4. Confirm `npm run pack:dry-run` includes only intended files.
5. Run the `Publish` workflow with `dry_run: true`.
6. Run the `Publish` workflow with `dry_run: false` after release approval.
7. Smoke test from a clean machine:

```bash
npm install -g @archwayai/context-relay
context-relay --help
```

## Token Fallback

Use a granular npm automation token only if Trusted Publishing cannot be used.
If a token is required, store it in the publishing repository's GitHub
environment secrets, restrict it to this package, and rotate it after use.

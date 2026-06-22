# Releasing

This project is set up to publish `@archwayai/context-relay` to npm.

## Local Release Checks

Run these from a fresh clone before publishing:

```bash
npm test
npm run quickstart
npm run eval
npm run pack:dry-run
npm run publish:dry-run
```

Also check that public docs and package contents do not include local paths,
private issue links, secrets, customer data, or maintainer-only planning notes.

## npm Trusted Publishing

Use npm Trusted Publishing from GitHub Actions instead of a long-lived
`NPM_TOKEN` whenever possible.

Package settings:

- Publisher: GitHub Actions
- Organization: `Archway-AI`
- Repository: `context-relay`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

GitHub settings:

- Create an environment named `npm`.
- Require manual approval for that environment.

## Publish Flow

1. Run the `Publish` workflow with `dry_run: true`.
2. Check the tarball file list in the workflow log.
3. Run the `Publish` workflow with `dry_run: false` after approval.
4. Smoke test from a clean machine:

```bash
npm install -g @archwayai/context-relay
context-relay --help
```

## Token Fallback

Use a granular npm automation token only if Trusted Publishing is blocked. If a
token is required, store it in the publishing repository's GitHub environment
secrets, restrict it to this package, and rotate it after use.

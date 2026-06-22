# Release Checklist

Use this before publishing a package release.

## Required Checks

- [ ] `npm test` passes from a fresh clone.
- [ ] `npm run quickstart` works without credentials.
- [ ] `node bin/context-relay.js --help` lists all supported commands.
- [ ] `node bin/context-relay.js cleanup --all` removes the selected demo store.
- [ ] `npm pack --dry-run` includes only intended package files.
- [ ] `npm publish --dry-run --access public` succeeds for
      `@archwayai/context-relay`.
- [ ] Public docs contain no local absolute paths, private issue links, secrets,
      customer names, or private repository names.
- [ ] Known limitations are prominent in `docs/limitations.md`.
- [ ] Security and privacy storage behavior is documented.
- [ ] License, contributing guide, and code of conduct are present.

## Fixture Gates

- [ ] Passing noisy output summarizes and retrieves.
- [ ] Failing output preserves non-zero exit code.
- [ ] Search output summarizes by file.
- [ ] JSON/tool output summarizes shape, counts, and warning examples.
- [ ] Missing artifact retrieval fails closed.
- [ ] Expired artifact retrieval fails closed.
- [ ] Secret-like output is blocked before artifact storage.
- [ ] Raw mode behavior is documented as an explicit bypass.

## Release Notes

Release notes must include:
- exact version
- supported Node.js version
- storage location and cleanup command
- limitations and claims boundary
- measured fixture numbers only, not broad accuracy claims

## Post-Release Smoke

Run in a new temporary directory:

```bash
npm test
npm run quickstart
npm pack --dry-run
npm publish --dry-run --access public
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-release node bin/context-relay.js cleanup --all
```

For automated publishing, prefer npm Trusted Publishing over a long-lived
`NPM_TOKEN`. See [trusted-publishing.md](trusted-publishing.md).

# context-relay

- A machine's global `context-relay` can be a symlink to this checkout. When it is, an edit in this working tree changes Bash output for every agent session on that machine at once, so make changes in a worktree.
- Done: `npm run verify` (tests, quickstart, evals). CI runs `npm run release:check`.
- Publishing to npm is public (`publish.yml`, run by hand); ask the maintainer first. This repo is public: no private paths, issue links, secrets or customer data in docs.

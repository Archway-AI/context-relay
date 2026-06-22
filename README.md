# Context Relay

[![CI](https://github.com/Archway-AI/context-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Archway-AI/context-relay/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@archwayai/context-relay.svg)](https://www.npmjs.com/package/@archwayai/context-relay)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Context Relay keeps agent context lean without losing the evidence.

It is a tiny local CLI for the stuff agents are bad at budgeting: test logs,
search output, build noise, diffs, and chunky JSON. It stores raw output in a
local artifact store, returns a compact summary, and gives the agent a pointer
for exact retrieval when details matter.

## Install

Context Relay requires Node.js 22 or newer and has no runtime dependencies.

Install the package after the first npm release:

```bash
npm install -g @archwayai/context-relay
context-relay --help
```

Run from source:

```bash
npm test
npm run quickstart
node bin/context-relay.js --help
```

Both paths run without provider credentials, hosted services, or API keys.

## Why It Exists

Agent workflows often produce output that is useful but too bulky to keep in
the active prompt: test logs, build output, repository search, diffs, and JSON
tool responses. Dropping that output loses evidence. Pasting all of it wastes
tokens and makes the next step harder to inspect.

The contract is deliberately plain:

1. Summarize bulky output into a compact, scannable form.
2. Store the raw output locally with an opaque artifact ID.
3. Relay a retrieval pointer so the exact evidence can be recovered before any
   correctness-sensitive decision.

## Five-Minute Quickstart

From a clone of this repository:

```bash
npm test
npm run quickstart
```

Or run the demo manually:

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo CONTEXT_RELAY_RUN_ID=demo \
  node bin/context-relay.js run --mode compress -- node examples/noisy-test-log.js
```

The output includes a marker like:

```text
raw: [artifact:cr:cr_demo_... retrieve="context-relay retrieve cr_demo_..."]
```

Retrieve the exact raw output when you need evidence:

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo \
  node bin/context-relay.js retrieve <artifact-id> --grep "TODO item 7"
```

Inspect metadata without returning raw content:

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo \
  node bin/context-relay.js inspect <artifact-id>
```

Check local counters:

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo \
  node bin/context-relay.js stats
```

Clean expired artifacts:

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo \
  node bin/context-relay.js cleanup
```

Remove the whole local demo store:

```bash
CONTEXT_RELAY_STORE_DIR=/tmp/context-relay-demo \
  node bin/context-relay.js cleanup --all
```

## CLI

```bash
context-relay run [--mode auto|compress|dry-run|raw] -- <command>
context-relay raw -- <command>
context-relay retrieve <artifact-id> [--range start:end] [--grep pattern]
context-relay inspect <artifact-id>
context-relay stats
context-relay cleanup [--all]
```

Modes:
- `auto`: pass through small output and summarize noisy output.
- `compress`: force a reversible summary for the command output.
- `dry-run`: show what Context Relay would do while still printing raw output.
- `raw`: stream the child process directly.

`raw` is an explicit escape hatch. It does not apply Context Relay secret
filtering to child output, so only use it for commands that are safe to show to
the agent.

## Storage

By default, raw artifacts live in:

```text
~/.context-relay
```

Set `CONTEXT_RELAY_STORE_DIR` to use a project-local or temporary store.
Artifacts include TTL metadata and default to an eight-hour retention window.

Use `cleanup` to remove expired artifacts, or `cleanup --all` to remove all
local Context Relay artifacts and event counters in the selected store.

## What It Is Good For

- Test, build, search, diff, log, and JSON/tool output that would otherwise
  flood an agent context window.
- Reversible summaries where the raw evidence remains available.
- Local CLI workflows for Claude Code, Codex, and API-based agents that can run
  shell commands and then retrieve raw artifacts.

## What It Is Not

- A hosted ChatGPT or Claude web UI interceptor.
- A memory system of record.
- A lossy compressor for user instructions or active edit targets.
- A guarantee of zero accuracy loss across arbitrary tasks.

See [docs/architecture.md](docs/architecture.md) and [docs/limitations.md](docs/limitations.md)
before using Context Relay in a serious workflow.

## Fixture Evals

Run the deterministic fixture evals:

```bash
npm run eval
```

Current committed results:

| Case | Raw bytes | Summary bytes | Targeted retrieval bytes | Reduction after targeted retrieval |
| --- | ---: | ---: | ---: | ---: |
| quickstart-log | 1,428 | 963 | 132 | 23.3% |
| search-style-output | 9,816 | 1,519 | 836 | 76.0% |
| json-tool-output | 2,455 | 1,025 | 150 | 52.1% |
| failing-log | 2,632 | 1,341 | 527 | 29.0% |

All four fixture cases pass exact raw retrieval and exit-code preservation. The
secret fixture is blocked and does not create an artifact. See
[docs/evals.md](docs/evals.md) and
[docs/eval-results.json](docs/eval-results.json).

## Examples And Fixtures

- [examples/noisy-test-log.js](examples/noisy-test-log.js) emits deterministic
  noisy shell output for quickstart demos.
- [examples/tool-json.js](examples/tool-json.js) emits representative JSON tool
  output.
- [fixtures/tool-output.json](fixtures/tool-output.json) is a static fixture for
  documentation and experiments.

## Development

```bash
npm test
npm run quickstart
npm run eval
npm run pack:dry-run
npm run publish:dry-run
node bin/context-relay.js --help
node bin/context-relay.js run --mode compress -- node examples/tool-json.js
```

The test suite uses only Node.js built-ins and local temporary directories.

Release automation is documented in [docs/releasing.md](docs/releasing.md) and
[docs/trusted-publishing.md](docs/trusted-publishing.md). The repository is set
up for npm Trusted Publishing from GitHub Actions, so routine releases should
not require a long-lived npm token.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

# Architecture Notes

Context Relay is intentionally small. It is a local command wrapper for agent
workflows, not a new shell, proxy, daemon, or memory system.

## The Contract

Context Relay does three things:

1. Captures noisy command output.
2. Returns a compact summary plus an artifact pointer.
3. Lets the agent retrieve exact raw output before acting on details.

The summary is a map. The artifact is the evidence.

## Defaults

Context Relay should pass through output when it is not confident that
summarizing is useful or safe.

It should never summarize:

- secrets or likely credentials
- active user instructions
- source text the user asked to inspect exactly
- security or auth diagnostics where exact wording matters
- short output where the wrapper would add more bytes than it saves

## Why Local Files

The first storage backend is boring on purpose: JSON files under
`~/.context-relay`, or under `CONTEXT_RELAY_STORE_DIR` when set.

That keeps the tool easy to inspect, easy to delete, and usable without hosted
services or API keys. It also makes the tradeoff explicit: raw artifacts are
local files, so anyone with filesystem access to the store can read them.

## Claims Boundary

Good claims:

- reduces prompt load on noisy fixtures and command output
- keeps raw evidence retrievable
- preserves child process exit codes
- makes compression/retrieval visible in local stats

Bad claims:

- universal token savings
- zero accuracy loss
- complete secret prevention
- hosted ChatGPT or Claude web interception
- automatic subscription-plan maximization

Bring your own evals for your own workflows.

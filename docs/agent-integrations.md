# Agent Integrations

Context Relay can be used explicitly as a CLI, or installed into agent harnesses
that know how to route shell commands.

## Claude Code

Claude Code supports `PreToolUse` hooks for Bash. Context Relay uses that hook to
rewrite eligible noisy commands before they run.

Install:

```bash
context-relay init --claude
context-relay status
```

What gets changed:

- `~/.claude/settings.json` gets a Bash `PreToolUse` command hook:
  `context-relay hook claude`
- `~/.claude/CONTEXT_RELAY.md` is written with short operating instructions.
- `~/.claude/CLAUDE.md` gets an `@CONTEXT_RELAY.md` reference if missing.

The hook rewrites allowlisted finite commands such as `git status`, `git diff`,
`npm test`, `npm run build`, `pnpm test`, `rg`, `grep`, and type-check/build
commands into:

```bash
context-relay run --mode auto -- bash -lc '<original command>'
```

It skips commands that are interactive, long-running, auth-shaped, already
wrapped, mutating, or too complex to rewrite safely. Examples include `ssh`,
`sudo`, `curl`, `gh auth`, `git push`, `git commit`, `npm init`,
`npm run dev`, `jest --watch`, `claude`, `codex`, shell control operators,
heredocs, command substitutions, or multi-line shell input.

The hook does not grant command permission. Claude Code still owns the approval
decision for the rewritten Bash tool call.

Uninstall:

```bash
context-relay uninstall --claude
```

## Codex

Codex supports lifecycle hooks, including `PreToolUse` for Bash. Context Relay
uses that hook to rewrite eligible noisy commands before they run.

Install:

```bash
context-relay init --codex
context-relay status
```

What gets changed:

- `~/.codex/CONTEXT_RELAY.md` is written with short operating instructions.
- `~/.codex/AGENTS.md` gets a managed block that references the file.
- `~/.codex/hooks.json` gets a Bash `PreToolUse` command hook:
  `context-relay hook codex`

The hook uses the same conservative rewrite policy as the Claude Code hook. It
only wraps finite allowlisted commands, skips interactive or mutating commands,
and returns Codex's required `permissionDecision: "allow"` with `updatedInput`
when it rewrites a supported tool call.

Codex requires non-managed hooks to be reviewed and trusted before they run. Use
`/hooks` in Codex after install if Codex reports a hook review warning.

Manual use still works when you do not want the hook:

```bash
context-relay run --mode auto -- <command>
context-relay run --mode compress -- <command>
context-relay retrieve <artifact-id> --grep <pattern>
context-relay raw -- <command>
```

Uninstall:

```bash
context-relay uninstall --codex
```

## API-Based Agents

API agents can use Context Relay today by wrapping tool execution explicitly:

```bash
context-relay run --mode auto -- <tool command>
```

That reduces the bytes sent back to the model while preserving a local raw
artifact pointer for retrieval. A local OpenAI/Anthropic-compatible proxy or SDK
middleware is not implemented yet.

The intended future shape:

```bash
context-relay proxy --port 8797
```

Then SDK users would point their model client at the local proxy and let it
compress large tool results before forwarding messages. This needs separate
threat modeling, evals, streaming behavior tests, and provider compatibility
tests before it belongs in the public quickstart.

## Design Lessons

Two existing projects shaped this integration design:

- RTK shows the right Claude Code primitive: a Bash `PreToolUse` hook that returns
  an `updatedInput` command, plus a small awareness doc so the agent understands
  the rewritten output.
- Headroom shows the right install ergonomics: managed config changes, clear
  provider boundaries, status checks, and reversible setup.
- Codex's official hooks docs show the equivalent `PreToolUse` hook and the
  required `permissionDecision: "allow"` shape for `updatedInput` rewrites.

Context Relay borrows those patterns, but keeps the first release narrower:
Claude Code and Codex automatic Bash wrapping, explicit CLI use everywhere else.

// Shared "find the real subcommand" logic for git and the npm family, used by TWO
// independent call sites that must never diverge:
//   - commandKey (lib/cli.js) - stats attribution, so `git -C <path> log` groups with
//     plain `git log` instead of a bogus `git -C` bucket.
//   - isAllowedCommandShape (lib/integrations.js) - the PreToolUse rewrite SAFETY gate,
//     which decides whether a command is wrapped at all. Global flags before the
//     subcommand (`git -C <path> log`, `npm --prefix ./app run build`) must not make this
//     gate mistake the flag for the subcommand.
//
// Both take an array of whitespace-separated tokens with index 0 = the executable name
// (or, in the gate's case, an untyped first token - it is never read here) and index 1+ =
// the remaining argv. Each function returns the index of the first token that looks like
// the real subcommand, skipping recognized global flags, or -1 if a flag is encountered
// that isn't one of the recognized forms - so a caller can conservatively fall back
// (reject, or key on the bare executable name) rather than guess.

const GIT_FLAGS_WITH_SEPARATE_ARG = new Set(["-C", "-c"]);
const GIT_FLAGS_WITH_INLINE_ARG = new Set(["--git-dir", "--work-tree", "--namespace", "--exec-path"]);
// NOTE (Copilot finding H): bare `--exec-path` (no `=`) is NOT a skippable global flag the
// way `--no-pager`/`--paginate`/etc. are - it's a TERMINAL query option. `git --exec-path
// log` prints the exec-path and exits 0 WITHOUT running `log` at all (confirmed live), so
// treating it as skippable here made findGitSubcommandIndex land on "log" and the safety
// gate key/gate the whole invocation as `git log` even though `log` never runs. Only the
// inline `--exec-path=<path>` form (GIT_FLAGS_WITH_INLINE_ARG above) is behaviorally
// transparent - it sets the option and continues on to the real subcommand (confirmed
// live: `git --exec-path=/tmp log` actually ran `log`). Do not add "--exec-path" back to
// this set.
const GIT_BARE_FLAGS = new Set(["--no-pager", "--paginate", "--bare", "--literal-pathspecs"]);

export function findGitSubcommandIndex(command) {
  let index = 1;
  while (index < command.length) {
    const arg = command[index];
    if (!arg.startsWith("-")) {
      return index;
    }
    if (arg.includes("=")) {
      const flag = arg.slice(0, arg.indexOf("="));
      if (GIT_FLAGS_WITH_INLINE_ARG.has(flag)) {
        index += 1;
        continue;
      }
      return -1;
    }
    if (GIT_FLAGS_WITH_SEPARATE_ARG.has(arg)) {
      index += 2;
      continue;
    }
    if (GIT_BARE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

// Same idea for the npm family (npm/pnpm/yarn/bun): `npm --prefix ./app run build` should
// find `run build`, not `--prefix`. Flag MEANINGS diverge across these tools even though
// the surface syntax looks identical, so semantics are executable-specific rather than one
// shared table - most notably `-w`, which is npm's value-taking `-w <workspace-name>`
// (verified: `npm -w foo run build` runs the "foo" workspace's script) but pnpm's BOOLEAN
// `--workspace-root` toggle (verified: `pnpm -w run build` errors "--workspace-root may
// only be used inside a workspace" rather than consuming "run" as a value - i.e. treating
// it as value-taking silently swallows the real subcommand). Each set below is populated
// from what was actually run and observed for that executable, not assumed from npm's
// behavior:
//   - npm: `-w`/`--workspace <name>` takes a value, in both the separate-argument AND the
//     inline `=` form (both verified to run the named workspace's script); `--prefix
//     <dir>` likewise both forms (verified); `-C <dir>` is a real, if undocumented,
//     separate-argument alias for changing directory (verified it actually changes the
//     resolved project directory, not merely accepted and ignored).
//   - pnpm: `-w`/`--workspace-root` is bare/boolean (see above); `--prefix <dir>` takes a
//     value in both forms and `-C <dir>` as a separate argument (both verified); pnpm's
//     documented long form of `-C` is `--dir <path>` (separate-argument only).
//   - yarn (classic) and bun: neither has a `-C`, `--prefix`, or `-w`/`--workspace` global
//     flag in this position (verified: `yarn -C <dir> run build` and
//     `bun --prefix <dir> run build` are NOT accepted as directory flags - yarn misreads
//     the value as a command name, bun tries to resolve it as a module); their directory
//     flag is `--cwd <dir>`, which is INLINE-ONLY for bun - `bun --cwd=<dir> run build`
//     verified to correctly change directory and run the script, but the separate-argument
//     form `bun --cwd <dir> run build` chdirs and then prints `bun run` usage without
//     running the script (exit 0), and `bun --cwd <dir> test` fails with `error: Script not
//     found "test"` - bun's arg parser doesn't consume the next token as `--cwd`'s value
//     the way npm/pnpm/yarn's separate-argument flags do, so treating it as value-taking
//     there would swallow the real subcommand exactly like the pnpm `-w` bug above. yarn's
//     `--cwd` was verified to work in both the separate-argument and inline forms. Workspace
//     selection on both is a different mechanism entirely (yarn's `workspace <name>`
//     SUBCOMMAND, bun's `--filter`/`-F`), not a global flag, so no workspace flag belongs in
//     either table.
// An executable with no entry below, or a flag not listed for its executable, is treated
// as unrecognized: findNpmSubcommandIndex returns -1 rather than guessing whether it's a
// toggle or a value-taker - the same conservative "fail closed" contract as
// findGitSubcommandIndex.
const NPM_FAMILY_FLAGS = {
  npm: {
    separateArg: new Set(["--prefix", "-C", "-w", "--workspace"]),
    inlineArg: new Set(["--prefix", "-w", "--workspace"]),
  },
  pnpm: {
    separateArg: new Set(["--prefix", "-C", "--dir"]),
    inlineArg: new Set(["--prefix"]),
    bare: new Set(["-w", "--workspace-root"]),
  },
  yarn: {
    separateArg: new Set(["--cwd"]),
    inlineArg: new Set(["--cwd"]),
  },
  bun: {
    separateArg: new Set(),
    inlineArg: new Set(["--cwd"]),
  },
};
const NPM_FAMILY_COMMON_BARE_FLAGS = new Set(["--silent", "-s"]);

export function findNpmSubcommandIndex(command, executable) {
  const flags = NPM_FAMILY_FLAGS[executable];
  if (!flags) {
    return -1;
  }
  const separateArg = flags.separateArg ?? new Set();
  const inlineArg = flags.inlineArg ?? new Set();
  const bare = flags.bare ?? new Set();
  let index = 1;
  while (index < command.length) {
    const arg = command[index];
    if (!arg.startsWith("-")) {
      return index;
    }
    if (arg.includes("=")) {
      const flag = arg.slice(0, arg.indexOf("="));
      if (inlineArg.has(flag)) {
        index += 1;
        continue;
      }
      return -1;
    }
    if (separateArg.has(arg)) {
      index += 2;
      continue;
    }
    if (bare.has(arg) || NPM_FAMILY_COMMON_BARE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

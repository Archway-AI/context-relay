// "Find the real subcommand" logic for git and the npm family, used ONLY by commandKey
// (lib/cli.js) for STATS ATTRIBUTION - bucketing `git -C <path> log` alongside plain
// `git log` instead of a bogus `git -C` bucket.
//
// Change 3 (design narrowing, see PR history): this table used to be shared with the
// PreToolUse rewrite SAFETY gate (isAllowedCommandShape in lib/integrations.js), which
// forced it to be exactly right about every tool's flag semantics - a wrong guess there
// could make a mutating command look safe to wrap. The gate no longer flag-skips at all
// (it matches a small number of exact positional shapes instead - see
// lib/integrations.js); this file now has exactly one consumer, and that consumer only
// MAY guess. A wrong guess here miscounts a stats bucket and nothing else - commandKey's
// caller never decides whether to wrap or execute anything based on this result. Sharing
// one finder between a stats path that may guess and a safety path that must not is what
// dragged this level of flag-skipping into the gate in the first place; keeping this file
// single-purpose is what keeps that from happening again.
//
// Each function takes an array of whitespace-separated tokens (index 0 = the executable
// name, index 1+ = argv) and returns the index of the first token that looks like the real
// subcommand, skipping recognized global flags - or -1 if an unrecognized flag is hit, so
// the caller can fall back to keying on the bare executable name rather than guess further.

const GIT_FLAGS_WITH_SEPARATE_ARG = new Set(["-C", "-c"]);
const GIT_FLAGS_WITH_INLINE_ARG = new Set(["--git-dir", "--work-tree", "--namespace", "--exec-path"]);
// Bare `--exec-path` (no `=`) is a TERMINAL query option, not a passthrough flag: `git
// --exec-path log` prints the exec-path and exits 0 WITHOUT running `log` at all (confirmed
// live), so treating it as skippable would key it as `git log` even though `log` never
// runs. Only the inline `--exec-path=<path>` form is behaviorally transparent (confirmed
// live: it actually runs the trailing subcommand), so only that form is in
// GIT_FLAGS_WITH_INLINE_ARG above.
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
// only be used inside a workspace" rather than consuming "run" as a value). Each set below
// is populated from what was actually run and observed for that executable:
//   - npm: `-w`/`--workspace <name>` and `--prefix <dir>` take a value (separate-argument
//     AND inline `=` forms, both verified); `-C <dir>` is a real, undocumented
//     separate-argument alias for changing directory (verified).
//   - pnpm: `-w`/`--workspace-root` is bare/boolean (see above); `--prefix <dir>` takes a
//     value in both forms and `-C <dir>` as a separate argument (both verified); pnpm's
//     documented long form of `-C` is `--dir <path>` (separate-argument only).
//   - yarn (classic) and bun: neither has a `-C`, `--prefix`, or `-w`/`--workspace` global
//     flag in this position (verified: yarn misreads the value as a command name, bun
//     tries to resolve it as a module); their directory flag is `--cwd <dir>`, which is
//     INLINE-ONLY for bun (verified: the separate-argument form chdirs but then fails to
//     run the real subcommand at all) and works in both forms for yarn.
// An executable with no entry below, or a flag not listed for its executable, is treated
// as unrecognized: findNpmSubcommandIndex returns -1 rather than guessing.
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

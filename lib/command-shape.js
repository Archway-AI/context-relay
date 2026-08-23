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
const GIT_BARE_FLAGS = new Set(["--no-pager", "--paginate", "--bare", "--literal-pathspecs", "--exec-path"]);

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
// find `run build`, not `--prefix`.
const NPM_FLAGS_WITH_SEPARATE_ARG = new Set(["--prefix", "-C", "-w"]);
const NPM_FLAGS_WITH_INLINE_ARG = new Set(["--workspace"]);
const NPM_BARE_FLAGS = new Set(["--silent", "-s"]);

export function findNpmSubcommandIndex(command) {
  let index = 1;
  while (index < command.length) {
    const arg = command[index];
    if (!arg.startsWith("-")) {
      return index;
    }
    if (arg.includes("=")) {
      const flag = arg.slice(0, arg.indexOf("="));
      if (NPM_FLAGS_WITH_INLINE_ARG.has(flag)) {
        index += 1;
        continue;
      }
      return -1;
    }
    if (NPM_FLAGS_WITH_SEPARATE_ARG.has(arg)) {
      index += 2;
      continue;
    }
    if (NPM_BARE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

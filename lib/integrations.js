import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_MARKER = "@CONTEXT_RELAY.md";
const CODEX_MARKER = "@CONTEXT_RELAY.md";
const MANAGED_START = "# --- Context Relay managed block ---";
const MANAGED_END = "# --- end Context Relay managed block ---";

// The sentinel this installer - and only this installer - writes at the end of every hook
// command it generates (see resolveHookCommand below). Ownership recognition (Change 1)
// is exact token equality on this string, nothing else: no basename check, no interpreter
// check, no path comparison. Those were all patterns with an unenumerated complement -
// there is always another shape ('/usr/bin/node' '/opt/evil/context-relay.js' hook claude)
// that satisfies the pattern without being ours. A token only we emit has no complement to
// enumerate.
const MANAGED_HOOK_SENTINEL = "--managed-by=context-relay";

// bash's default IFS is $' \t\n'. JS `\s` matches far more - vertical tab, form feed, and
// assorted Unicode spaces - so any analyzer that splits a raw command string on `\s` sees
// word boundaries bash does not. The rewrite gate hit this first (see the long explanation
// on evaluateCommandShape below); the ownership parser has the same bash-equivalence
// requirement for a HIGHER-stakes reason: misclassifying a foreign hook here DELETES it
// from the user's settings file, it does not merely wrap a command. On the GATE path \r and
// \n are refused upstream by hasUnsupportedShellShape (its only caller is
// rewriteShellCommand); on THIS path nothing refuses them - a settings.json command reaches
// the parser byte-for-byte. They are simply never separators here, and a command carrying
// one can only BREAK the exact-equality matches below (the legacy string, the final
// hook/provider/sentinel triple), never manufacture one - so it fails closed as foreign.
// Space and tab are the whole separator set either way, for different reasons.
// These two analyzers deliberately answer different questions and parse different
// grammars - they share this SEMANTIC, not an abstraction.
const SHELL_BLANK_PATTERN = /[ \t]/;

// Characters bash treats as literal inside an UNQUOTED word. See the long explanation at the
// bare branch of parseShellQuotedTokens - this is an allowlist so an unanticipated shell
// metacharacter fails closed (returns null -> "foreign") rather than being read literally.
const BARE_TOKEN_PATTERN = /^[A-Za-z0-9._/=-]+$/;

// JS String.trim() strips VT/FF/NBSP too, so trimming with it before an exact sentinel
// comparison re-opens at the string's ENDS exactly what SHELL_BLANK_PATTERN closes in its
// interior: "<VT>context-relay hook claude" trims to the exact legacy string and is
// deleted, while bash would exec a program literally named "<VT>context-relay".
function trimShellBlanks(value) {
  return value.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

// git and npm/pnpm/yarn/bun each have exactly one shape rule below (matchGitShape /
// matchNpmFamilyShape); everything else needs its own named rule (matchCargoShape,
// matchDenoShape, matchNodeShape, matchMakeShape, matchJestShape). There is no catch-all
// "this executable is generally trusted" set any more - see the dispatcher at the bottom of
// evaluateCommandShape (Change 4). find/grep/rg/tsc/pytest used to be wrapped with ANY
// arguments purely for being named in such a set; none of them has a shape rule now, so
// none of them is ever wrapped. If one needs to come back, it needs a real shape rule, not
// a name added to a bag of trusted executables.
const NPM_FAMILY_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "bun"]);

const FINITE_PACKAGE_SUBCOMMANDS = new Set(["build", "check", "lint", "test", "typecheck", "type-check"]);
const FINITE_BUN_SUBCOMMANDS = new Set(["test"]);
const FINITE_CARGO_SUBCOMMANDS = new Set(["build", "check", "clippy", "test"]);
const FINITE_DENO_SUBCOMMANDS = new Set(["check", "lint", "test"]);
const FINITE_YARN_SUBCOMMANDS = new Set(["build", "check", "lint", "test", "typecheck", "type-check"]);

const SKIP_COMMANDS = new Set([
  "claude",
  "codex",
  "context-relay",
  "curl",
  "gh",
  "htop",
  "less",
  "more",
  "nano",
  "open",
  "scp",
  "ssh",
  "sudo",
  "tail",
  "top",
  "vim",
  "vi",
  "watch",
  "wget",
]);

const AUTH_PATTERNS = [
  /\blogin\b/i,
  /\bauth\b/i,
  /\btoken\b/i,
  /\bsecret\b/i,
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\bcredential/i,
];

const INTERACTIVE_OR_LONG_RUNNING_PATTERNS = [
  /\b--watch\b/i,
  /\bwatch\b/i,
  /\bdev\b/i,
  /\bserve\b/i,
  /\bserver\b/i,
  /\bstart\b/i,
  /\binit\b/i,
  /\bcreate\b/i,
  /\bpublish\b/i,
  /\brelease\b/i,
  /\bpreview\b/i,
  /\bdaemon\b/i,
  /\brepl\b/i,
];

// `branch` is deliberately ABSENT (Copilot round 9): trailing arguments flip it to a
// MUTATION -
// `git branch -D old`, `git branch new-name`, `git branch -m old new` all matched here and
// were wrapped, contradicting the "mutating commands are skipped" contract in
// docs/agent-integrations.md. Compressing a destructive branch operation's stderr (e.g.
// "not fully merged") immediately upstream of a forced cleanup is the concrete harm. Bare
// `git branch` / `--list` are genuinely read-only but their output is a short branch list
// with no compression value, so this is a deletion rather than a read-only flag grammar -
// an enumerated flag surface is exactly the churn this rewrite exists to remove.
//
// DO NOT read the remaining members as "read-only under arbitrary trailing arguments."
// Round 9 of this PR asserted exactly that here and round 10 falsified it. Four of the
// members below have ARGV-CONTROLLED write or exec flags, verified against git 2.49.0:
//   grep  -O<cmd> / --open-files-in-pager=<cmd>  execs <cmd> with the matched files as argv
//                  (`git grep --open-files-in-pager=echo TODO` prints the filenames)
//   diff | log | show  --output=<file>           creates/truncates <file>
// (`--textconv`, `--ext-diff`, `--show-signature` only ENABLE helpers named by config, not
// by the command line, so they are a weaker class; bare `git status` refreshes .git/index,
// which is git's ordinary read path, not something trailing arguments flip.)
//
// What IS true, and is the only thing this set's `parts[1]` rule may rest on: the wrap never
// executes anything the caller was not already going to run. preToolUseHook returns "" when
// the gate refuses, so a refusal passes the command through untouched rather than blocking
// it - the gate is a COMPRESSION-ELIGIBILITY filter, not a security boundary. The defect in
// the four members above is therefore a violation of the documented "mutating commands are
// skipped" contract and compression of a mutating command's evidence, never altered
// execution. The structural fix - a per-subcommand SAFE-flag allowlist, which fails CLOSED
// on flags git adds later, unlike a dangerous-flag denylist - is tracked in ARC-2109.
const SAFE_GIT_SUBCOMMANDS = new Set([
  "blame",
  "diff",
  "grep",
  "log",
  "ls-files",
  "show",
  "status",
]);
const SHELL_CONTROL_OPERATOR_PATTERN = /&&|\|\||[|;&]/;

// Redirection is a third way (alongside expansion and control operators) that bash changes
// argv content after this process sees the string. `git -C 2>f log push` contains no
// EXPANSION_RISK_PATTERN character and no SHELL_CONTROL_OPERATOR_PATTERN token - it
// tokenizes to the exact safe `git -C <dir> log` shape, with `2>f` masquerading as the
// directory argument. Bash strips `2>f` as a file-descriptor-2 redirect before building
// argv, leaving the real command `git -C log push` - a mutating `git push`, not the read
// this shape was allowed for. Any bare `<`/`>` (plain, doubled, or preceded by a digit or
// `&` for fd-duplication/numbered-fd forms) is refused outright, the same way `hasExpansionRisk`
// refuses globbing: no shape below has a slot for a redirect target, so there is nothing to
// special-case per form.
const SHELL_REDIRECTION_PATTERN = /[<>]/;

// Change 2 (round 7 root cause): a tokenizer can preserve argv boundaries but never
// cardinality. This is the GENERAL shape every round-7+ finding on this gate has been an
// instance of - CARDINALITY-AFFECTING SHELL SYNTAX: any construct bash resolves AFTER this
// process sees the string, changing how many real arguments a command has (expansion,
// redirection, and whatever the next one turns out to be). Recognize the class, not just
// the instances found so far, or the next round rediscovers it as case #4. Concretely:
// `git -C {repo,push} log` tokenizes to 4 words and looks like the safe
// `git -C <dir> log` shape - but brace expansion turns it into 5 real arguments
// (`git -C repo push log`) once bash actually runs it, and bash runs `-C repo push log`:
// `push`, not `log`. Unquoted variables (`git -C $REPO log`) and globs (`git -C repo* log`)
// have the identical property - the argument COUNT depends on something this process
// cannot evaluate (an environment variable's contents, a filesystem glob match) without
// literally invoking a shell. No tokenizer, however correct, can see through that: it can
// only tell you what the string looks like split into words BEFORE those expansions run.
// The only sound fix is to refuse outright, before any shape is even considered, on any
// character that can change argument count or quoting after this string leaves this
// process: backslash and both quote characters (escaping/quoting change word boundaries),
// `{`/`}` (brace expansion), `$` (parameter/command substitution), and `*`, `?`, `[`/`]`
// (pathname expansion). Once none of those EXPANSION forms can be present, plain
// whitespace-splitting the residue is bash-equivalent for word boundaries specifically -
// but word boundaries are not the only thing bash can change before argv is built.
// Redirection (`<`, `>`, and their doubled/numbered-fd/fd-duplication forms) is a
// SEPARATE parsing step that strips tokens from the command line entirely rather than
// moving a boundary between them; it is refused independently, see
// SHELL_REDIRECTION_PATTERN above and hasUnsupportedShellShape.
const EXPANSION_RISK_PATTERN = /[\\'"{}$*?[\]]/;

function hasExpansionRisk(command) {
  return EXPANSION_RISK_PATTERN.test(command);
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The hook a PreToolUse handler executes runs as a detached subprocess that does NOT
// inherit the invoking shell's PATH (e.g. a login-shell nvm PATH). A bare "context-relay
// hook claude" therefore silently fails to resolve on any machine where context-relay was
// installed via `npm link` from a local clone, rather than a global npm install onto a
// PATH directory. Resolve an absolute, self-contained command instead: the running node
// binary (process.execPath) plus this package's actual CLI entry script, derived from this
// module's own location rather than process.argv[1] (which differs between the npm-link
// shim and a direct `node bin/context-relay.js` invocation).
function resolveCliScriptPath() {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(libDir, "..", "bin", "context-relay.js");
}

export function resolveHookCommand(provider) {
  return `${shellQuote(process.execPath)} ${shellQuote(resolveCliScriptPath())} hook ${provider} ${MANAGED_HOOK_SENTINEL}`;
}

// Parses a command line generated by shellQuote() (single-quote-wrapped tokens, with an
// embedded quote written as the '\'' idiom) back into its argv tokens, plus bare
// (unquoted) tokens for anything not quoted at all. Returns null on anything that doesn't
// match this narrow, known shape - callers must treat null as "identity can't be
// established" and fail closed (see isManagedHookCommand below), never guess.
// Exported for the round-11 differential test only (this package has no `exports`/`main`
// field - its interface is the `context-relay` binary, so lib/ is not a declared API).
export function parseShellQuotedTokens(command) {
  const tokens = [];
  let index = 0;
  const length = command.length;
  while (index < length) {
    while (index < length && SHELL_BLANK_PATTERN.test(command[index])) {
      index += 1;
    }
    if (index >= length) {
      break;
    }
    if (command[index] !== "'") {
      const start = index;
      while (index < length && !SHELL_BLANK_PATTERN.test(command[index])) {
        index += 1;
      }
      const token = command.slice(start, index);
      // ALLOWLIST, not a denylist of shell metacharacters (Copilot round 11). A bare token is
      // one this command line did NOT quote, so bash may still act on its contents - expand,
      // split, redirect, substitute - while this parser reads it literally. Any such
      // disagreement on the ownership path DELETES a foreign hook, so the accepted set is
      // restricted to characters bash treats as literal.
      //
      // Copilot proposed the denylist /[\\'"\r\n;&|<>()#`]/. Measured against HEAD, it closes
      // 5 of the 11 known-claimed forms and MISSES six: $VAR, *, ~, {a,b}, ?, and !. Rejected
      // for the same reason ARC-2109 rejects dangerous-flag denylists - naming the dangerous
      // things fails OPEN on the one you forgot, naming the permitted things fails CLOSED.
      //
      // The set is exactly what the generator emits bare (`hook`, the provider word, and
      // `--managed-by=context-relay`: letters, digits, `-`, `=`) plus `.` `/` `_`, which
      // matchPreSentinelHookShape needs to parse an unquoted absolute path for STATUS
      // surfacing. All three are shell-literal. Interpreter and script path are emitted
      // through shellQuote's single-quoted branch, so they are unaffected by this.
      if (!BARE_TOKEN_PATTERN.test(token)) {
        return null;
      }
      tokens.push(token);
      continue;
    }
    let token = "";
    let sawClosingQuote = false;
    while (index < length && command[index] === "'") {
      index += 1;
      const closeIndex = command.indexOf("'", index);
      if (closeIndex === -1) {
        return null;
      }
      token += command.slice(index, closeIndex);
      index = closeIndex + 1;
      sawClosingQuote = true;
      if (command[index] === "\\" && command[index + 1] === "'") {
        token += "'";
        index += 2;
      }
    }
    if (!sawClosingQuote || (index < length && !SHELL_BLANK_PATTERN.test(command[index]))) {
      return null;
    }
    tokens.push(token);
  }
  return tokens;
}

// Change 1: ownership recognition by SENTINEL IDENTITY, not shape inference. Every hook
// command this tool generates ends in the literal token "--managed-by=context-relay" (see
// resolveHookCommand above) - a token no other program has any reason to emit. Recognition
// is exact token equality on that sentinel (plus the "hook <provider>" pair immediately
// before it, so a claude entry is never claimed by a codex check or vice versa) - nothing
// about the interpreter, the script path, or its basename is inspected at all. The prior
// basename-matching design (a 4-token shape ending in a script literally named
// "context-relay.js") was a PATTERN, and every pattern has a complement nothing enumerates:
// '/usr/bin/node' '/opt/evil/context-relay.js' hook claude satisfied that shape without
// being this tool's hook, and `uninstall` deleted it as if it were. A sentinel only this
// installer emits has no such complement - impersonating it requires literally writing the
// same marker a foreign tool has no reason to write.
//
// Exactly ONE legacy form is still recognized, for one release: the pre-absolute-path bare
// string "context-relay hook <provider>", a strict 3-token exact match. The OLD 4-token
// absolute-path legacy shape (recognized by a prior round purely by basename, with no
// sentinel) is deliberately NOT recognized here, by this function, any more - that shape is
// exactly what produced the impersonation finding this rewrite exists to close, so treating
// it as "ours" for OWNERSHIP purposes (uninstall, or anything else destructive) would just
// reopen the hole under a different name. This function is the one every destructive path
// goes through (via isManagedHookCommand), so it stays exact: sentinel, or the one bare
// legacy string, nothing else.
//
// `init` is a narrower problem than "is this ours" - it is "is this the same hook I am
// about to write, one sentinel version behind" - and it has two more facts available than
// this function does: the exact interpreter and script path it just resolved for itself
// (process.execPath + resolveCliScriptPath()). A pre-sentinel hook invoking that SAME pair
// cannot be a different install; it is self-evidently this install's own prior hook. See
// isSamePathPreSentinelHook below, used ONLY by the init merge path
// (stripManagedPreToolUseEntries's includeSuperseded option), never by uninstall. A
// pre-sentinel hook at any OTHER path stays exactly as ambiguous as it was before this
// change - `init` leaves it alone and appends a fresh sentinel entry alongside it (see
// mergeClaudeSettings), and `status` surfaces it under ambiguousPreSentinelHooks so it does
// not sit there as a silent, unexplained double-wrap.
export function classifyHookCommand(command, provider) {
  if (typeof command !== "string") {
    return "foreign";
  }
  const trimmed = trimShellBlanks(command);
  if (trimmed === `context-relay hook ${provider}`) {
    return "legacy";
  }
  const tokens = parseShellQuotedTokens(trimmed);
  if (!tokens) {
    return "foreign";
  }
  const sentinel = tokens.at(-1);
  const providerWord = tokens.at(-2);
  const hookWord = tokens.at(-3);
  if (sentinel === MANAGED_HOOK_SENTINEL && providerWord === provider && hookWord === "hook") {
    return "managed";
  }
  return "foreign";
}

// Used by init/uninstall's upsert-and-strip logic: both the current sentinel form and the
// one-release legacy bare form count as "ours" for removal/replacement purposes. Use
// classifyHookCommand directly where the distinction matters (status reporting an
// upgradeable legacy hook rather than silently treating it as equivalent to the current
// form).
export function isManagedHookCommand(command, provider) {
  const classification = classifyHookCommand(command, provider);
  return classification === "managed" || classification === "legacy";
}

// Recognizes the SHAPE of a pre-sentinel absolute-path hook - interpreter, script path,
// "hook", provider, four tokens, no trailing sentinel - without any judgment about whether
// it is ours. Used two ways below: (1) isSamePathPreSentinelHook narrows this to the one
// case init may safely act on, and (2) statusAgents uses it unnarrowed, purely to surface a
// command that LOOKS like an old install's hook (or, just as easily, Copilot's
// '/opt/evil/context-relay.js' finding - this function cannot and does not try to tell the
// two apart) so a human notices it instead of it sitting there unexplained.
function matchPreSentinelHookShape(command, provider) {
  if (typeof command !== "string") {
    return null;
  }
  const tokens = parseShellQuotedTokens(trimShellBlanks(command));
  if (!tokens || tokens.length !== 4) {
    return null;
  }
  const [interpreter, scriptPath, hookWord, providerWord] = tokens;
  if (hookWord !== "hook" || providerWord !== provider) {
    return null;
  }
  // Require the script-path token to at least LOOK like a pre-sentinel hook this installer
  // could have generated - an absolute path ending in this package's actual script
  // basename - before treating a 4-token "... hook <provider>" shape as a migration
  // candidate at all. Without this, an unrelated foreign command like
  // "echo context-relay hook claude" (interpreter "echo", bare relative scriptPath
  // "context-relay") satisfies the shape and gets surfaced in status.ambiguousPreSentinelHooks
  // as if it might be an old install of this tool, purely noise for something this tool
  // never had any hand in generating. This is a coarse plausibility filter, not an identity
  // check - isSamePathPreSentinelHook below still does the real, exact, both-tokens
  // comparison before anything destructive/self-healing happens; this only trims what gets
  // surfaced as "worth a human's attention" in the first place.
  const scriptBasename = path.basename(resolveCliScriptPath());
  if (!path.isAbsolute(scriptPath) || path.basename(scriptPath) !== scriptBasename) {
    return null;
  }
  return { interpreter, scriptPath };
}

// The one place a pre-sentinel hook is treated as ours: init only, and only when its script
// command carries the EXACT interpreter + script-path pair this install just generated
// (process.execPath + resolveCliScriptPath()). process.execPath is already an absolute,
// symlink-resolved pathname, while parseShellQuotedTokens deliberately accepts relative
// bare tokens; path.resolve would therefore broaden ownership to a foreign relative token
// that this installer never emitted. Byte equality on both generated tokens keeps this the
// "same install, one sentinel version behind" case. Never used for uninstall or any other
// destructive decision; see isManagedHookCommand for the check those use instead, which
// does not recognize this shape at all.
function isSamePathPreSentinelHook(command, provider) {
  const match = matchPreSentinelHookShape(command, provider);
  if (!match) {
    return false;
  }
  return match.interpreter === process.execPath && match.scriptPath === resolveCliScriptPath();
}

function firstToken(command) {
  const match = command.trim().match(/^([A-Za-z0-9_./:-]+)/);
  if (!match) {
    return "";
  }
  return path.basename(match[1]);
}

function hasUnsupportedShellShape(command) {
  return (
    command.includes("\n") ||
    command.includes("\r") ||
    command.includes("<<") ||
    command.includes("$(") ||
    command.includes("`") ||
    SHELL_CONTROL_OPERATOR_PATTERN.test(command) ||
    SHELL_REDIRECTION_PATTERN.test(command)
  );
}

// Change 2: no flag-skipping loop here at all - see EXPANSION_RISK_PATTERN above for why a
// tokenizer, however correct, is the wrong tool for a SAFETY decision. By the time a
// command reaches here it has already survived both hasUnsupportedShellShape (redirection,
// control operators, heredocs, command substitution) and hasExpansionRisk, so it contains
// none of \ ' " { } $ * ? [ ] < >; a plain whitespace split is bash-equivalent for what's left.
//
// Change 4: every branch below returns a PROOF object naming the exact shape that allowed
// the wrap, or null. There is no final "this executable is generally trusted" branch - an
// executable with no matching rule always returns null. `-c`, `--exec-path`, `--git-dir`,
// `--prefix`, `-w`, `--cwd`, and every other git/npm-family global flag are refused BY
// CONSTRUCTION: no shape below has a slot for a flag in that position, so a command
// carrying one simply fails to match anything, the same way an unrecognized executable
// does. There is no blocklist of dangerous flags to keep in sync with git/npm's own flag
// surface - the allowlist is closed by omission, not by enumeration.
function matchGitShape(parts) {
  if (parts.length >= 2 && SAFE_GIT_SUBCOMMANDS.has(parts[1])) {
    return { shape: "git-sub", subcommand: parts[1] };
  }
  // The single flagged exception (per the design brief): `git -C <dir> <safe-sub> ...rest`.
  // This estate's worktree-based conventions make `-C` common enough to carry as a named
  // exception; nothing else does, including `-c` (alias/config injection - see the deleted
  // SECURITY special case this replaces) and `--git-dir`/`--exec-path`/etc (no shape rule
  // matches them at all any more, so they refuse the same way an entirely unknown flag
  // does - there is no reason to special-case one alias-hijack vector when the other five
  // global flags are just as absent from the allowlist).
  if (parts.length >= 4 && parts[1] === "-C" && SAFE_GIT_SUBCOMMANDS.has(parts[3])) {
    return { shape: "git-C-sub", subcommand: parts[3] };
  }
  return null;
}

function npmFamilyBareSet(executable) {
  if (executable === "bun") {
    return FINITE_BUN_SUBCOMMANDS;
  }
  if (executable === "yarn") {
    return FINITE_YARN_SUBCOMMANDS;
  }
  return FINITE_PACKAGE_SUBCOMMANDS; // npm, pnpm
}

// `npm|pnpm|yarn|bun (run)? <finite-script>` EXACTLY - two or three tokens, nothing more.
// No leading global flag (`--prefix`, `-C`, `-w`, `--workspace`, `--cwd`, `--dir`, ...) has
// a shape rule to match against, so all of them - and any trailing argument after the
// script name - refuse by construction rather than by naming each flag this family has
// ever grown across four different tools with four different flag semantics.
//
// yarn is deliberately excluded from the "run" (3-token) branch: pre-unification, yarn was
// bare-only (`yarn <script>`, never `yarn run <script>`) - findNpmSubcommandIndex located a
// subcommand and checked it against FINITE_YARN_SUBCOMMANDS directly, and "run" itself was
// never a member of that set, so `yarn run test` was never wrapped. Folding all four tools
// into one shape function would have silently widened yarn to accept the "run" form too
// (npm/pnpm/bun already had it) - an unintended behavior change in a rewrite whose entire
// purpose is narrowing, not widening. Keeping this narrower than npm/pnpm/bun preserves the
// exact pre-existing surface for yarn.
function matchNpmFamilyShape(parts, executable) {
  const bareSet = npmFamilyBareSet(executable);
  if (parts.length === 2 && bareSet.has(parts[1])) {
    return { shape: `${executable}-finite`, subcommand: parts[1] };
  }
  if (parts.length === 3 && parts[1] === "run" && executable !== "yarn" && FINITE_PACKAGE_SUBCOMMANDS.has(parts[2])) {
    return { shape: `${executable}-run-finite`, subcommand: parts[2] };
  }
  return null;
}

function matchCargoShape(parts) {
  if (parts.length === 2 && FINITE_CARGO_SUBCOMMANDS.has(parts[1])) {
    return { shape: "cargo-finite", subcommand: parts[1] };
  }
  return null;
}

function matchDenoShape(parts) {
  if (parts.length === 2 && FINITE_DENO_SUBCOMMANDS.has(parts[1])) {
    return { shape: "deno-finite", subcommand: parts[1] };
  }
  return null;
}

function matchNodeShape(parts) {
  if (parts.length === 2 && parts[1] === "--test") {
    return { shape: "node-test" };
  }
  return null;
}

function matchMakeShape(parts) {
  if (parts.length > 1 && parts.every((part) => !part.includes("="))) {
    return { shape: "make" };
  }
  return null;
}

function matchJestShape(parts) {
  if (!parts.some((part) => part === "--watch" || part === "--watchAll")) {
    return { shape: "jest" };
  }
  return null;
}

// The single dispatcher every rule above is reached through. An executable with no branch
// here - find, grep, rg, tsc, pytest included - was previously wrapped with ANY argument
// list purely for appearing in a `SAFE_COMMANDS` set, with no shape check at all: the same
// permissive posture that produced six rounds of findings against git/npm. None of them has
// a shape rule now, so none of them is ever wrapped; there is no name left to add a
// command back to, only a proof-returning rule to write for it.
function evaluateCommandShape(trimmed, executable) {
  if (INTERACTIVE_OR_LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return null;
  }
  // JS `\s` splits on far more than bash's default word-separating whitespace: form feed,
  // vertical tab, and various Unicode space characters all match `\s` but are NOT in bash's
  // default IFS ($' \t\n'). `git -C repo<VT>log push` (a literal vertical-tab byte, not the
  // two-character escape) would split HERE into five safe-looking tokens
  // (`git`,`-C`,`repo`,`log`,`push`) - matching the allowed `git -C <dir> log` shape at
  // position 3 - while bash keeps the vertical tab inside the directory word and actually
  // runs `git -C 'repo<VT>log' push`, a mutating push. \r and \n are already refused
  // upstream by hasUnsupportedShellShape, so only space and tab need to remain as
  // separators here for bash-equivalence.
  const parts = trimmed.split(/[ \t]+/);
  if (executable === "git") {
    return matchGitShape(parts);
  }
  if (NPM_FAMILY_EXECUTABLES.has(executable)) {
    return matchNpmFamilyShape(parts, executable);
  }
  if (executable === "cargo") {
    return matchCargoShape(parts);
  }
  if (executable === "deno") {
    return matchDenoShape(parts);
  }
  if (executable === "node") {
    return matchNodeShape(parts);
  }
  if (executable === "make") {
    return matchMakeShape(parts);
  }
  if (executable === "jest") {
    return matchJestShape(parts);
  }
  return null;
}

function isAllowedCommandShape(command, executable) {
  return evaluateCommandShape(command, executable) !== null;
}

export function rewriteShellCommand(command, options = {}) {
  // .trim() strips JS-whitespace (including the same VT/FF/Unicode-space characters
  // evaluateCommandShape's split now excludes) from the ENDS only - analyzed and confirmed
  // benign, not just unexamined: shellQuote() below re-embeds the ORIGINAL, untrimmed
  // command when a rewrite happens, so bash still receives exactly what the caller passed;
  // the trim only affects which shape gets MATCHED against, and a leading/trailing
  // JS-whitespace character stuck to the first/last real token can only ever turn that
  // token into a nonexistent executable name or trailing garbage on an already-read-only
  // shape - never a hidden extra safe-looking word the way an INTERIOR occurrence could.
  const trimmed = command.trim();
  if (!trimmed) {
    return { changed: false, reason: "empty" };
  }
  if (hasUnsupportedShellShape(command)) {
    return { changed: false, reason: "unsupported-shell-shape" };
  }
  // Change 2, before any allowlist check: refuse outright on any character that can change
  // argument cardinality or quoting once this string reaches a real shell (brace expansion,
  // unquoted variables, globs, escapes, quotes). See EXPANSION_RISK_PATTERN above.
  if (hasExpansionRisk(trimmed)) {
    return { changed: false, reason: "expansion-risk" };
  }

  const executable = firstToken(trimmed);
  if (!executable) {
    return { changed: false, reason: "unknown-executable" };
  }
  if (SKIP_COMMANDS.has(executable)) {
    return { changed: false, reason: "skip-command" };
  }
  if (!isAllowedCommandShape(trimmed, executable) && !options.force) {
    return { changed: false, reason: "not-allowlisted" };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { changed: false, reason: "sensitive-command" };
  }

  const mode = options.mode || "auto";
  const rewritten = `context-relay run --mode ${mode} -- bash -lc ${shellQuote(command)}`;
  return { changed: true, command: rewritten, reason: "rewritten" };
}

export async function claudeHook(stdin, options = {}) {
  return preToolUseHook(stdin, { ...options, provider: "claude" });
}

export async function codexHook(stdin, options = {}) {
  return preToolUseHook(stdin, { ...options, provider: "codex" });
}

async function preToolUseHook(stdin, options = {}) {
  let payload;
  try {
    payload = JSON.parse(stdin || "{}");
  } catch {
    return "";
  }

  const toolInput = payload.tool_input;
  const command = toolInput?.command;
  if (!toolInput || typeof command !== "string") {
    return "";
  }

  const rewrite = rewriteShellCommand(command, options);
  if (!rewrite.changed) {
    return "";
  }

  const hookSpecificOutput = {
      hookEventName: "PreToolUse",
      updatedInput: {
        ...toolInput,
        command: rewrite.command,
      },
  };
  if (options.provider === "codex") {
    hookSpecificOutput.permissionDecision = "allow";
  }

  return `${JSON.stringify({ hookSpecificOutput })}\n`;
}

function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

// Override vars are CONTEXT_RELAY_CLAUDE_HOME / CONTEXT_RELAY_CODEX_HOME (CODEX_HOME as a
// secondary fallback for codex) - NOT CLAUDE_CONFIG_DIR, which this codebase never reads
// and which silently leaves manual testing writing to the real ~/.claude/settings.json.
function claudeDir() {
  return process.env.CONTEXT_RELAY_CLAUDE_HOME || homePath(".claude");
}

function codexDir() {
  return process.env.CONTEXT_RELAY_CODEX_HOME || process.env.CODEX_HOME || homePath(".codex");
}

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeText(filePath, content, dryRun) {
  if (dryRun) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function removeFile(filePath, dryRun) {
  if (dryRun) {
    return;
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function hasExactMarkerLine(content, marker) {
  return content.split(/\r?\n/).some((line) => line.trim() === marker);
}

function appendMarker(content, marker) {
  if (hasExactMarkerLine(content, marker)) {
    return content.endsWith("\n") ? content : `${content}\n`;
  }
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${marker}\n`;
}

function removeMarkerLine(content, marker) {
  const next = content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== marker)
    .join("\n")
    .trimEnd();
  return next ? `${next}\n` : "";
}

function buildClaudeAwareness() {
  return `# Context Relay

Context Relay wraps noisy shell output with compact summaries and local raw-artifact retrieval.

- If a Bash command is automatically rewritten through Context Relay, treat the summary as a navigation aid, not as the full evidence.
- Before making correctness-sensitive claims from compressed output, run the shown \`context-relay retrieve <artifact-id>\` command with \`--grep\` or \`--range\` when a targeted raw slice is enough.
- Use \`context-relay raw -- <command>\` or rerun the original command if exact streaming output is required.
`;
}

function buildCodexAwareness() {
  return `# Context Relay

Context Relay wraps noisy shell output with compact summaries and local raw-artifact retrieval.

- If a Bash command is automatically rewritten through Context Relay, treat the summary as a navigation aid, not as the full evidence.
- Before making correctness-sensitive claims from compressed output, run the shown \`context-relay retrieve <artifact-id>\` command with \`--grep\` or \`--range\` when a targeted raw slice is enough.
- Use \`context-relay raw -- <command>\` when exact streaming output is required.
`;
}

// Shared by both the upsert path (mergeClaudeSettings/mergeCodexHooks) and the removal
// path (removeClaudeHook/removeCodexHook): strips every hook entry that
// isManagedHookCommand recognizes as ours out of a PreToolUse array, dropping any "Bash"
// entry left with zero hooks ONLY when we actually removed a managed hook from it, and
// leaving every non-matching entry (foreign hooks, non-"Bash" matchers) untouched.
//
// Copilot finding D: an earlier version filtered hooks per-entry with .map(), then dropped
// ANY entry afterward whose hooks array had length 0 - regardless of whether that entry's
// hooks were ever touched by the managed-hook filter. That final blanket
// `.filter((entry) => ... entry.hooks.length > 0)` ran over every entry unconditionally,
// including ones the .map() step returned completely unchanged (any non-"Bash" matcher, or
// a "Bash" entry with none of our hooks in it). A foreign entry that simply arrived with an
// empty `hooks` array - or one whose hooks survived filtering just fine but happened to be
// length 0 for an unrelated reason - got silently deleted on every `init`/`uninstall`, even
// though this function never removed anything from it. Data-loss on a routine command, and
// on a DIFFERENT tool's config besides. The fix: only ever drop an entry when this function
// itself actually removed at least one managed hook from it AND nothing is left afterward.
// An entry that was already empty, or whose hooks the managed-hook filter left completely
// unmodified, must survive byte-identical - returned as the exact original object, not even
// a shallow copy.
//
// options.includeSuperseded (default false) additionally strips a pre-sentinel hook that
// isSamePathPreSentinelHook recognizes as THIS SAME INSTALL's own prior hook, one sentinel
// version behind - so it gets replaced in place by the fresh entry appended right after,
// rather than left to sit alongside it as a silent double-wrap. This is passed true ONLY by
// the init/merge call sites (mergeClaudeSettings, mergeCodexHooks): init is the one caller
// with a resolved script path to compare against and something safe to replace the entry
// with. The removal call sites (removeClaudeHook, removeCodexHook) never pass it - a
// pre-sentinel hook, same path or not, is exactly the ambiguous shape uninstall must never
// delete, so it is left at its default of false there.
function stripManagedPreToolUseEntries(preToolUse, provider, options = {}) {
  const includeSuperseded = Boolean(options.includeSuperseded);
  const result = [];
  for (const entry of preToolUse) {
    if (entry?.matcher !== "Bash" || !Array.isArray(entry.hooks)) {
      result.push(entry);
      continue;
    }
    const filteredHooks = entry.hooks.filter((hook) => {
      if (hook?.type !== "command") {
        return true;
      }
      if (isManagedHookCommand(hook?.command, provider)) {
        return false;
      }
      return !(includeSuperseded && isSamePathPreSentinelHook(hook?.command, provider));
    });
    if (filteredHooks.length === entry.hooks.length) {
      // Nothing of ours was in this entry - survive byte-identical, whether hooks was
      // already empty or fully populated with only foreign hooks.
      result.push(entry);
      continue;
    }
    // We actually removed at least one managed hook. Only NOW is dropping the entry for
    // being empty correct - and only if it actually IS empty afterward.
    if (filteredHooks.length > 0) {
      result.push({ ...entry, hooks: filteredHooks });
    }
  }
  return result;
}

function parseAgentConfig(existing) {
  let value;
  try {
    value = JSON.parse(existing);
  } catch {
    return { kind: "invalid", error: "contains malformed JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", error: "must contain a JSON object" };
  }
  return { kind: "valid", value };
}

async function readAgentConfig(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return { content, state: parseAgentConfig(content) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { content: "", state: { kind: "missing" } };
    }
    throw error;
  }
}

function mutableConfigValue(config, provider) {
  if (config.kind === "valid") {
    return config.value;
  }
  if (config.kind === "missing") {
    return {};
  }
  throw new Error(`${provider} configuration is invalid: ${config.error}`);
}

function mergeClaudeSettings(config, hookCommand) {
  const settings = mutableConfigValue(config, "Claude Code");
  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  // Upsert, not dedup-or-append: remove every entry matching our own managed hook (per
  // isManagedHookCommand), PLUS a pre-sentinel hook from this exact same install (per
  // isSamePathPreSentinelHook - includeSuperseded: true, init-only, see
  // stripManagedPreToolUseEntries) - and then unconditionally append the freshly generated
  // command. The latter is what closes the double-wrap defect: without it, a machine
  // carrying a pre-sentinel hook this tool itself wrote before it gained the sentinel would
  // end up with BOTH the old form and the new sentinel form firing on every Bash call, the
  // old one rewriting the command before the new one ever sees it.
  const nextPreToolUse = [
    ...stripManagedPreToolUseEntries(preToolUse, "claude", { includeSuperseded: true }),
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: hookCommand }],
    },
  ];
  return `${JSON.stringify({ ...settings, hooks: { ...hooks, PreToolUse: nextPreToolUse } }, null, 2)}\n`;
}

function removeClaudeHook(config) {
  if (config.kind === "missing") {
    return "";
  }
  const settings = mutableConfigValue(config, "Claude Code");
  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const nextPreToolUse = stripManagedPreToolUseEntries(preToolUse, "claude");
  const nextHooks = { ...hooks };
  if (nextPreToolUse.length > 0) {
    nextHooks.PreToolUse = nextPreToolUse;
  } else {
    delete nextHooks.PreToolUse;
  }
  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length > 0) {
    nextSettings.hooks = nextHooks;
  } else {
    delete nextSettings.hooks;
  }
  return `${JSON.stringify(nextSettings, null, 2)}\n`;
}

function buildCodexManagedBlock() {
  return `${MANAGED_START}
${CODEX_MARKER}
${MANAGED_END}
`;
}

function codexManagedBlockPattern(flags = "m") {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escape(MANAGED_START)}\\r?\\n${escape(CODEX_MARKER)}\\r?\\n${escape(MANAGED_END)}(?:\\r?\\n)?`,
    flags,
  );
}

function hasCodexManagedBlock(content) {
  return codexManagedBlockPattern().test(content);
}

function mergeManagedBlock(content, block) {
  const pattern = codexManagedBlockPattern();
  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block}`;
}

function removeManagedBlock(content) {
  const pattern = codexManagedBlockPattern("gm");
  return content.replace(pattern, "").trimEnd() + (content.trim() ? "\n" : "");
}

function mergeCodexHooks(config, hookCommand) {
  const payload = mutableConfigValue(config, "Codex");
  const hooks = payload.hooks && typeof payload.hooks === "object" ? payload.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  // Upsert, not dedup-or-append - see the matching comment in mergeClaudeSettings: this also
  // supersedes a pre-sentinel hook from this exact same install (includeSuperseded: true),
  // replacing it in place instead of double-wrapping alongside it.
  const nextPreToolUse = [
    ...stripManagedPreToolUseEntries(preToolUse, "codex", { includeSuperseded: true }),
    {
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          statusMessage: "Wrapping noisy shell output with Context Relay",
        },
      ],
    },
  ];
  return `${JSON.stringify({ ...payload, hooks: { ...hooks, PreToolUse: nextPreToolUse } }, null, 2)}\n`;
}

function removeCodexHook(config) {
  if (config.kind === "missing") {
    return "";
  }
  const payload = mutableConfigValue(config, "Codex");
  const hooks = payload.hooks && typeof payload.hooks === "object" ? payload.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const nextPreToolUse = stripManagedPreToolUseEntries(preToolUse, "codex");
  const nextHooks = { ...hooks };
  if (nextPreToolUse.length > 0) {
    nextHooks.PreToolUse = nextPreToolUse;
  } else {
    delete nextHooks.PreToolUse;
  }
  const nextPayload = { ...payload };
  if (Object.keys(nextHooks).length > 0) {
    nextPayload.hooks = nextHooks;
  } else {
    delete nextPayload.hooks;
  }
  return `${JSON.stringify(nextPayload, null, 2)}\n`;
}

export async function installClaude(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const root = claudeDir();
  const settingsPath = path.join(root, "settings.json");
  const awarenessPath = path.join(root, "CONTEXT_RELAY.md");
  const claudeMdPath = path.join(root, "CLAUDE.md");
  const hookCommand = resolveHookCommand("claude");
  const { content: existingSettings, state: settingsConfig } = await readAgentConfig(settingsPath);
  const nextSettings = mergeClaudeSettings(settingsConfig, hookCommand);
  const existingClaudeMd = await readText(claudeMdPath);
  const nextClaudeMd = appendMarker(existingClaudeMd, CLAUDE_MARKER);

  await writeText(settingsPath, nextSettings, dryRun);
  await writeText(awarenessPath, buildClaudeAwareness(), dryRun);
  await writeText(claudeMdPath, nextClaudeMd, dryRun);

  return {
    target: "claude",
    dryRun,
    files: [
      { path: settingsPath, action: existingSettings === nextSettings ? "unchanged" : "write" },
      { path: awarenessPath, action: "write" },
      { path: claudeMdPath, action: existingClaudeMd === nextClaudeMd ? "unchanged" : "write" },
    ],
    hook: hookCommand,
  };
}

export async function installCodex(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const root = codexDir();
  const awarenessPath = path.join(root, "CONTEXT_RELAY.md");
  const agentsPath = path.join(root, "AGENTS.md");
  const hooksPath = path.join(root, "hooks.json");
  const hookCommand = resolveHookCommand("codex");
  const existingAgents = await readText(agentsPath);
  const nextAgents = mergeManagedBlock(existingAgents, buildCodexManagedBlock());
  const { content: existingHooks, state: hooksConfig } = await readAgentConfig(hooksPath);
  const nextHooks = mergeCodexHooks(hooksConfig, hookCommand);

  await writeText(awarenessPath, buildCodexAwareness(), dryRun);
  await writeText(agentsPath, nextAgents, dryRun);
  await writeText(hooksPath, nextHooks, dryRun);

  return {
    target: "codex",
    dryRun,
    files: [
      { path: awarenessPath, action: "write" },
      { path: agentsPath, action: existingAgents === nextAgents ? "unchanged" : "write" },
      { path: hooksPath, action: existingHooks === nextHooks ? "unchanged" : "write" },
    ],
    hook: hookCommand,
  };
}

export async function statusAgents(args) {
  const allowed = new Set(["--json"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`unknown status option: ${arg}`);
    }
  }
  const rootClaude = claudeDir();
  const rootCodex = codexDir();
  const { state: claudeConfig } = await readAgentConfig(path.join(rootClaude, "settings.json"));
  const claudeMd = await readText(path.join(rootClaude, "CLAUDE.md"));
  const codexAgents = await readText(path.join(rootCodex, "AGENTS.md"));
  const { state: codexConfig } = await readAgentConfig(path.join(rootCodex, "hooks.json"));

  // Reports "legacy" (present-but-upgradeable) as distinct from "managed" (current
  // sentinel form) rather than folding both into a single silently-equivalent boolean. A
  // bare legacy hook is recognized for migration, but can silently fail when a detached
  // hook subprocess cannot resolve context-relay on PATH; only the self-contained managed
  // form proves automatic wrapping is configured to run. The legacy form is also only ONE
  // release away from becoming unrecognizable foreign matter (see classifyHookCommand), so
  // status must preserve both distinctions.
  //
  // Also collects ambiguousPreSentinelHooks: any command classifyHookCommand calls
  // "foreign" but which is nonetheless shaped exactly like a pre-sentinel hook
  // (matchPreSentinelHookShape - interpreter, script path, "hook", provider). init only
  // rewrites one of these in place when its interpreter + script pair matches THIS
  // install's generated pair (isSamePathPreSentinelHook); any other pair is left untouched
  // by both init and uninstall, which is correct but must not be silent - a stuck entry like that
  // produces the double-wrap defect (two Bash hooks firing, one rewriting the command
  // before the other ever sees it) with no visible explanation otherwise. This list is
  // exactly that explanation.
  function summarizeHooks(preToolUse, provider) {
    let installed = false;
    let automaticWrapping = false;
    let upgradeable = false;
    const ambiguousPreSentinelHooks = [];
    for (const entry of preToolUse ?? []) {
      if (entry?.matcher !== "Bash") {
        continue;
      }
      for (const hook of entry.hooks ?? []) {
        if (hook?.type !== "command") {
          continue;
        }
        const classification = classifyHookCommand(hook?.command, provider);
        if (classification === "managed") {
          installed = true;
          automaticWrapping = true;
        } else if (classification === "legacy") {
          installed = true;
          upgradeable = true;
        } else if (matchPreSentinelHookShape(hook?.command, provider)) {
          ambiguousPreSentinelHooks.push(hook.command);
        }
      }
    }
    return { installed, automaticWrapping, upgradeable, ambiguousPreSentinelHooks };
  }

  const emptyHookSummary = () => ({
    installed: false,
    automaticWrapping: false,
    upgradeable: false,
    ambiguousPreSentinelHooks: [],
  });

  const claudeHooks = claudeConfig.kind === "valid"
    ? summarizeHooks(claudeConfig.value.hooks?.PreToolUse, "claude")
    : emptyHookSummary();
  const codexHooks_ = codexConfig.kind === "valid"
    ? summarizeHooks(codexConfig.value.hooks?.PreToolUse, "codex")
    : emptyHookSummary();

  return {
    claude: {
      directory: rootClaude,
      configState: claudeConfig.kind,
      hookInstalled: claudeHooks.installed,
      hookUpgradeable: claudeHooks.upgradeable,
      awarenessLinked: hasExactMarkerLine(claudeMd, CLAUDE_MARKER),
      automaticShellWrapping: claudeHooks.automaticWrapping,
      ambiguousPreSentinelHooks: claudeHooks.ambiguousPreSentinelHooks,
    },
    codex: {
      directory: rootCodex,
      configState: codexConfig.kind,
      hookInstalled: codexHooks_.installed,
      hookUpgradeable: codexHooks_.upgradeable,
      awarenessLinked: hasCodexManagedBlock(codexAgents),
      automaticShellWrapping: codexHooks_.automaticWrapping,
      ambiguousPreSentinelHooks: codexHooks_.ambiguousPreSentinelHooks,
    },
  };
}

export async function uninstallAgents(args) {
  const options = {
    claude: false,
    codex: false,
    dryRun: false,
  };
  for (const arg of args) {
    if (arg === "--claude") {
      options.claude = true;
    } else if (arg === "--codex") {
      options.codex = true;
    } else if (arg === "--all") {
      options.claude = true;
      options.codex = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown uninstall option: ${arg}`);
    }
  }
  if (!options.claude && !options.codex) {
    options.claude = true;
    options.codex = true;
  }

  const results = [];
  if (options.claude) {
    const root = claudeDir();
    const settingsPath = path.join(root, "settings.json");
    const claudeMdPath = path.join(root, "CLAUDE.md");
    const awarenessPath = path.join(root, "CONTEXT_RELAY.md");
    const { content: existingSettings, state: settingsConfig } = await readAgentConfig(settingsPath);
    const existingClaudeMd = await readText(claudeMdPath);
    const nextSettings = removeClaudeHook(settingsConfig);
    const nextClaudeMd = removeMarkerLine(existingClaudeMd, CLAUDE_MARKER);
    if (settingsConfig.kind !== "missing") {
      await writeText(settingsPath, nextSettings, options.dryRun);
    }
    await writeText(claudeMdPath, nextClaudeMd, options.dryRun);
    await removeFile(awarenessPath, options.dryRun);
    results.push({
      target: "claude",
      dryRun: options.dryRun,
      files: [
        { path: settingsPath, action: existingSettings === nextSettings ? "unchanged" : "write" },
        { path: claudeMdPath, action: existingClaudeMd === nextClaudeMd ? "unchanged" : "write" },
        { path: awarenessPath, action: "remove" },
      ],
    });
  }
  if (options.codex) {
    const root = codexDir();
    const agentsPath = path.join(root, "AGENTS.md");
    const awarenessPath = path.join(root, "CONTEXT_RELAY.md");
    const hooksPath = path.join(root, "hooks.json");
    const existingAgents = await readText(agentsPath);
    const nextAgents = removeManagedBlock(existingAgents);
    const { content: existingHooks, state: hooksConfig } = await readAgentConfig(hooksPath);
    const nextHooks = removeCodexHook(hooksConfig);
    await writeText(agentsPath, nextAgents, options.dryRun);
    if (hooksConfig.kind !== "missing") {
      await writeText(hooksPath, nextHooks, options.dryRun);
    }
    await removeFile(awarenessPath, options.dryRun);
    results.push({
      target: "codex",
      dryRun: options.dryRun,
      files: [
        { path: agentsPath, action: existingAgents === nextAgents ? "unchanged" : "write" },
        { path: hooksPath, action: existingHooks === nextHooks ? "unchanged" : "write" },
        { path: awarenessPath, action: "remove" },
      ],
    });
  }
  return results;
}

export async function installAgents(args) {
  const options = {
    claude: false,
    codex: false,
    dryRun: false,
  };
  for (const arg of args) {
    if (arg === "--claude") {
      options.claude = true;
    } else if (arg === "--codex") {
      options.codex = true;
    } else if (arg === "--all") {
      options.claude = true;
      options.codex = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown init option: ${arg}`);
    }
  }
  if (!options.claude && !options.codex) {
    options.claude = true;
    options.codex = true;
  }
  const results = [];
  if (options.claude) {
    results.push(await installClaude(options));
  }
  if (options.codex) {
    results.push(await installCodex(options));
  }
  return results;
}

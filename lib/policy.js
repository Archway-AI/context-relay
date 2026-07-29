// THE BRACKETS ARE LOAD-BEARING. `hasSecret(redactSecrets(x)) === false` is the gate
// that decides whether blocked evidence may be stored at all, and this placeholder is
// what every redaction leaves behind — so the placeholder itself must never look like
// a secret. The guard is the closing `]`, NOT the underscore: a label pattern needs to
// reach a `:` or `=` through `[A-Za-z0-9_.-]*`, and `]` is outside that class, so
// `[REDACTED_SECRET]: value` and `[REDACTED_SECRET]=value` cannot match. Renaming this
// to a bracketless token (e.g. `REDACTED_SECRET`) would make the placeholder
// self-detecting and fail the gate on every block, destroying all evidence.
// Guarded by the "placeholder invariant" test in test/cli.test.js.
export const REDACTION_PLACEHOLDER = "[REDACTED_SECRET]";

// A credential label is a whole *name part* of an identifier. `AWS_SECRET_ACCESS_KEY`
// splits on `_`/`-`/`.` into AWS / SECRET / ACCESS / KEY, so SECRET is a label and the
// whole assignment is a secret. `tokens=0` and `raw_estimated_tokens: 5` do NOT contain
// `token` as a whole part, so CR's own accounting output stays unblocked.
//
// This replaces `\b(?:...|secret|...)\b`, which could never fire inside
// `AWS_SECRET_ACCESS_KEY`: `_` is a word character, so the boundary never exists.
// That gap silently passed every prefixed env-var credential through to agent context.
const LABEL_KEYWORD =
  "api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd|pwd|credentials?|authorization";
// The leading guard is a zero-width LOOKBEHIND, not a consuming alternation. The old
// `(?:^|[^A-Za-z0-9_.-])` ate the delimiter in front of the label, and that single
// consumed character caused two failures:
//   1. Adjacent secrets. A global replace resumes at `lastIndex`, so after a match that
//      ended by consuming a newline, the very next label had no delimiter left to eat
//      and `^` could not help (these patterns are `gi`, never `m`, so `^` only matches
//      at offset 0). `password: |\n  A\napi_key: |\n  B` redacted the first block and
//      left the second one whole — as residue that is no longer secret-shaped, so it
//      passed the storability gate and reached disk.
//   2. Preceding-line collateral. Swallowing the newline merged the previous line into
//      the placeholder, and the line pass then destroyed a line holding no secret.
// A lookbehind is satisfied at offset 0, which is exactly what the `^` branch provided.
const LABEL_NAME = `(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9]+[_.-])*(?:${LABEL_KEYWORD})(?:[_.-][A-Za-z0-9]+)*`;
// Value forms that cannot be a credential no matter what label precedes them: CI
// template references, angle/bracket documentation placeholders, mask runs, and the
// JSON/YAML empty literals. `[FILTERED]` covers this module's own
// REDACTION_PLACEHOLDER, so already-redacted text is not re-detected.
// The parenthesised and word forms are what real tools print when they deliberately
// withhold a credential: terraform's `(sensitive value)`, kubectl's `16 bytes`,
// `env`-style presence markers, and the language-level empty literals.
//
// The `<...>` and `[...]` wrapper forms are NARROWED: a documentation placeholder is
// short and wordy (`<your-api-key>`, `[FILTERED]`, `<redacted>`), whereas a credential
// that merely happens to be wrapped is long and mixes digits with letters. Innards that
// are 16+ characters AND contain both a digit and a letter are therefore NOT exempt, so
// `api_key=<hunter2realvalue123>` blocks while `API_KEY=<your-api-key>` still relays.
//
// LOAD-BEARING: `REDACTION_PLACEHOLDER` is `[REDACTED_SECRET]`, whose innards are 15
// characters with no digit — under BOTH thresholds, so the placeholder stays exempt. If
// this narrowing ever made the placeholder self-detecting, `hasSecret(redactSecrets(x))`
// would be true for every block and every blocked artifact would be destroyed instead of
// stored. The "placeholder invariant" test pins that.
//
// The `${...}` / `${{ ... }}` alternative is deliberately left wide: a CI template
// reference is a pointer to a credential, never a literal one.
const WRAPPED_PLACEHOLDER_GUARD = (inner, close) =>
  `(?!(?=${inner}{16,}${close})(?=${inner}*[0-9])(?=${inner}*[A-Za-z]))`;
const PLACEHOLDER_VALUE =
  "\\$\\{\\{?[^}]*\\}\\}?" +
  `|<${WRAPPED_PLACEHOLDER_GUARD("[^<>]", ">")}[^<>]*>` +
  `|\\[${WRAPPED_PLACEHOLDER_GUARD("[^\\[\\]]", "\\]")}[^\\[\\]]*\\]` +
  "|\\*+|null|nil|none|true|false" +
  "|undefined|unset|empty|redacted|hidden|n/a" +
  "|\\(\\s*(?:sensitive(?:\\s+value)?|set|unset|none|empty|redacted|hidden|null|n/a)\\s*\\)" +
  "|[0-9]+\\s*(?:bytes?|chars?|characters?)";

// VALUE PLAUSIBILITY GUARD. Round 2 widened the label pattern to catch prefixed
// env-var credentials and, in doing so, made it fire on everything that follows a
// credential label — including values that are by construction NOT credentials. The
// cost is not cosmetic: a labeled-but-masked line makes CR destroy the whole output.
// `git log` in this repository blocked on itself, because its own commit messages
// describe the label shapes being detected (`AWS_SECRET_ACCESS_KEY=,`,
// `"password": "..."`, `Authorization: Bearer are all detected`).
//
// Two conditions, applied to EVERY value alternative below rather than once up front,
// because the alternation backtracks: a guard placed only before the alternation is
// sidestepped by whichever branch consumes a shorter span.
//   1. the value must contain at least one alphanumeric character — kills `,`, `...`,
//      `""` and `********`;
//   2. the value must not be a placeholder *in its entirety* — kills `[FILTERED]`,
//      `<redacted>`, `<your-api-key>`, `${VAR}`, `${{ secrets.X }}`, `null`. Requiring
//      the WHOLE value keeps `token: <x>REALSECRETVALUE` detected.
// Every real credential contains alphanumerics and none is wrapped whole in `<>`/`[]`,
// so the guard costs zero detection coverage; the "still blocks real-shaped values
// after the placeholder guard" test pins that claim against every guarded label.
// The alnum lookahead is scoped per alternative — inside the quotes for a quoted
// value, up to the next space for a bare one — so a quoted multi-word passphrase
// still qualifies while `password: ""` does not.
// The trailing class carries `}` and `]` as well as whitespace/`,`/`;`/`)`, because a
// compact JSON literal has no space before its closer: `{"password": null}` reached the
// exemption with `null}` and the `}` fell outside the class, so the exemption never
// fired and CR destroyed the output. `{"password": null }` — one space — relayed. Both
// relayed on `origin/main`, so this was a destructive false positive introduced here.
const NOT_PLACEHOLDER = `(?!\\s*(?:${PLACEHOLDER_VALUE})\\s*\\\\?["']?(?:[\\s,;)}\\]]|$))`;

// Values are consumed WHOLE. A quoted value that stops at the first space leaves the
// tail of a passphrase behind as non-secret-shaped residue, which then passes the
// storability gate and gets written to disk. The `Bearer`/`Basic` alternative exists
// because `Authorization: Bearer <token>` has no `=`/`:` between scheme and token;
// its token carries an 8-character floor, so prose such as "Authorization: Bearer are
// all detected" is not a destructive block, and the catch-all refuses to start on a
// bare scheme word so it cannot sidestep that floor by matching `Bearer` alone.
// Quotes may be backslash-escaped: a credential embedded in a `node -e "..."` script
// reaches `redactCommandArg` as `\"password\": \"...\"`, and a bare `["']?` stops at
// the backslash, leaving the value to the catch-all alternative — which consumes the
// lone `\` and leaks the credential into the displayed `command:` line.
// The final alternative is a last resort for an OPENING quote with no closer:
// `api_key="hunter2...` on a truncated line. Every earlier alternative needs a closing
// quote, and the catch-all cannot start on a quote character, so without it this
// pattern was strictly weaker than the pre-change baseline on that one shape.
const LABEL_VALUE =
  "(?:" +
  `\\\\?"${NOT_PLACEHOLDER}(?=[^"\\\\]*[A-Za-z0-9])[^"\\\\]*\\\\?"` +
  `|\\\\?'${NOT_PLACEHOLDER}(?=[^'\\\\]*[A-Za-z0-9])[^'\\\\]*\\\\?'` +
  `|(?:Bearer|Basic|Token|Digest)\\s+${NOT_PLACEHOLDER}(?=[^"'\\s]*[A-Za-z0-9])[^"'\\s]{8,}` +
  `|(?!(?:Bearer|Basic|Token|Digest)\\b)${NOT_PLACEHOLDER}(?=[^"'\\s]*[A-Za-z0-9])[^"'\\s]+` +
  `|\\\\?["']${NOT_PLACEHOLDER}(?=[^\\s]*[A-Za-z0-9])[^\\s]+` +
  ")";
const LABELED_ASSIGNMENT_PATTERN = new RegExp(
  `${LABEL_NAME}(?:\\\\?["'])?\\s*[:=]\\s*${LABEL_VALUE}`,
  "i",
);

// CONTINUATION INTRODUCERS: the label is on one line and the credential is on the
// next. A YAML block scalar (`key: |`, `key: >`, `key: |-`, `key: |2-`) is how every
// multi-line secret — SSH keys, certs, PEM bodies — is written in helm values, k8s
// manifests, docker-compose and workflow YAML, i.e. the "browse CI configs" surface.
// Round 3's value-plausibility guard rejects a bare `|`/`>` because it holds no
// alphanumeric, and the indented body carries no label of its own, so nothing else
// fired and the credential relayed in full — a regression against both the baseline
// and round 2.
//
// The match must consume the WHOLE indented block, not just the introducer. Stopping
// at the introducer would strand the body as non-secret-shaped residue that passes the
// storability gate and reaches disk — the failure mode F2 fixed for quoted values.
// For the same reason this is listed FIRST in SECRET_PATTERNS: `password: |2-` does
// contain an alphanumeric, so the labeled-assignment pattern would otherwise consume
// the introducer alone and leave the body behind.
const CONTINUATION_VALUE_PATTERN = new RegExp(
  `${LABEL_NAME}(?:\\\\?["'])?[ \\t]*[:=][ \\t]*(?:` +
    // YAML block scalar: introducer (with optional chomping/indent indicators and a
    // trailing comment), then every following indented line.
    `[|>][0-9+-]*[ \\t]*(?:#[^\\n]*)?\\r?\\n` +
    // YAML allows blank (or whitespace-only) lines at the head of a block scalar, and
    // `password: |\n\n  <secret>` relayed in full because the introducer branch went
    // straight from the newline to `[ \t]+`. This cannot run away on an EMPTY block:
    // the next element still demands an indented, non-blank line, so
    // `password: |\n\nunindented: value` fails the whole branch rather than reaching
    // across into the following key.
    `(?:[ \\t]*\\r?\\n)*` +
    `[ \\t]+${NOT_PLACEHOLDER}(?=[^\\n]*[A-Za-z0-9])\\S[^\\n]*(?:\\r?\\n|$)` +
    `(?:[ \\t]+\\S[^\\n]*(?:\\r?\\n|$))*` +
    // Shell backslash continuation: any further continued lines, then the last one.
    `|\\\\[ \\t]*\\r?\\n(?:[ \\t]*\\S[^\\n]*\\\\[ \\t]*\\r?\\n)*` +
    `[ \\t]*${NOT_PLACEHOLDER}(?=[^\\n]*[A-Za-z0-9])\\S[^\\n]*` +
    ")",
  "i",
);

// `Bearer <token>` with no `Authorization:` prefix. A digit is required so that prose
// such as "Bearer authentication" cannot trigger a *destructive* block.
const BEARER_TOKEN_PATTERN = /\b(?:bearer|basic)\s+(?=[A-Za-z0-9_\-.=+/]*[0-9])[A-Za-z0-9_\-.=+/]{16,}/i;

// Detection patterns: positive key shapes only. Deliberately NON-global — a /g regex
// carries `lastIndex` across `.test()` calls and silently alternates true/false.
// Generic "any 32+ opaque token" entropy matching was removed on purpose: git SHAs,
// UUIDs, npm integrity hashes and base64 blobs are routine agent output, and a
// destroy/redact action needs more precision than entropy can deliver.
//
// Word boundaries on the prefixed shapes below are deliberately asymmetric. The
// leading `\b` is dropped wherever the prefix is distinctive enough that an embedded
// match is a real key rather than a false positive (`payload QUJDghp_...`), and the
// trailing `\b` is dropped everywhere because a key with extra trailing alphanumerics
// was otherwise missed entirely.
const SECRET_PATTERNS = [
  // Label whose value lives on the following line(s). MUST precede the labeled
  // assignment: an introducer such as `|2-` would otherwise be consumed alone.
  CONTINUATION_VALUE_PATTERN,
  // Labeled assignment: AWS_SECRET_ACCESS_KEY=..., "password": "...", token = ...
  LABELED_ASSIGNMENT_PATTERN,
  // Bare auth-scheme header value
  BEARER_TOKEN_PATTERN,
  // OpenAI / Anthropic style. The leading \b is KEPT here on purpose: `sk-` is a
  // three-character, low-entropy prefix, and dropping the boundary would make
  // ordinary hyphenated words ("ramdisk-configuration-backup") a blocking false
  // positive. Known gap: an sk- key glued to the tail of a longer word is missed.
  /\bsk-[A-Za-z0-9_-]{20,}/,
  // Stripe
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  // GitHub fine-grained PAT
  /github_pat_[A-Za-z0-9_]{22,}/,
  // AWS access key id
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  // Slack
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  // Google API key
  /AIza[0-9A-Za-z_-]{35}/,
  // GitLab PAT
  /glpat-[A-Za-z0-9_-]{20,}/,
  // JWT
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // PEM private key header
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

// Redaction-only: scrub the whole PEM block, not just the header line. Detection sees
// the header; redaction must remove the body or the redacted copy still holds the key.
const PEM_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

// Redaction-only: opaque 32+ char runs. Broader than detection is safe (the reverse
// would break the `hasSecret(redactSecrets(x)) === false` gate); pure-hex digests and
// UUIDs are excluded so real evidence (SHAs, ids) survives redaction intact.
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_+=-]{32,}\b/g;
// Only REAL digest lengths are exempt: md5 (32), sha1/git sha (40), sha256 (64).
// Exempting any hex run of 32+ let a 48-hex HMAC/signing secret survive verbatim
// inside a stored blocked artifact and inside a displayed command argument.
const HEX_DIGEST_PATTERN = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// `=` is inside OPAQUE_TOKEN_PATTERN's character class, so `sha=<40 hex>` matches as a
// single run and the digest exemption never sees pure hex — the sha was destroyed even
// though the space-delimited `commit <sha>` form survived. A single leading `name=` may
// be stripped before re-testing, EXCEPT when the name is itself credential-shaped: a
// digest-length hex value under a plural or otherwise unmatched credential label must
// keep being scrubbed.
const DIGEST_PREFIX_PATTERN = /^([A-Za-z0-9_+-]+=)([A-Za-z0-9_+-]+)$/;
const CREDENTIAL_PREFIX_PATTERN =
  /(?:api[_-]?keys?|access[_-]?keys?|private[_-]?keys?|secrets?|tokens?|passwords?|passwd|pwd|credentials?|authorization|sig|signature|hmac)/i;

const SECRET_FLAG_PATTERN = /^-{1,2}(?=[a-z0-9-]*(?:api-?key|secret|token|password|auth|credential))[a-z0-9-]+(?:=.*)?$/i;

export function isSafeOpaqueToken(token) {
  if (HEX_DIGEST_PATTERN.test(token) || UUID_PATTERN.test(token)) {
    return true;
  }
  const prefixed = DIGEST_PREFIX_PATTERN.exec(token);
  if (!prefixed || CREDENTIAL_PREFIX_PATTERN.test(prefixed[1])) {
    return false;
  }
  return HEX_DIGEST_PATTERN.test(prefixed[2]) || UUID_PATTERN.test(prefixed[2]);
}

function globalCopy(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

export function hasSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// The span pass, parameterised only by what a match is replaced WITH. `redactSecrets`
// keeps its exact previous behaviour (`replaceWith` is a constant function, and the
// placeholder holds no `$`, so a function replacer and a string replacer are equivalent
// here). `redactSecretLines` needs the same passes with a newline-preserving
// replacement so it can keep an index-aligned view of the original lines.
function applySpanRedactions(text, replaceWith) {
  // PEM blocks first: the shaped-pattern pass would otherwise only take the header.
  let redacted = text.replace(PEM_BLOCK_PATTERN, replaceWith);
  for (const pattern of SECRET_PATTERNS) {
    // Global copies: replacing only the first occurrence would leave later keys intact.
    redacted = redacted.replace(globalCopy(pattern), replaceWith);
  }
  redacted = redacted.replace(OPAQUE_TOKEN_PATTERN, (match) =>
    isSafeOpaqueToken(match) ? match : replaceWith(match),
  );
  return redacted;
}

const asPlaceholder = () => REDACTION_PLACEHOLDER;

// One placeholder per line the match covered. Two properties matter, and a plain
// `placeholder + "\n".repeat(n)` gets only the first:
//   1. line alignment — the redacted text has exactly as many lines as the input, which
//      is what makes the original-line lookups in `redactSecretLines` sound;
//   2. every line of a multi-line span carries the placeholder, so the line pass
//      destroys all of them. Emitting bare newlines instead moves any residue that
//      followed the match end onto a line of its own, where it no longer contains a
//      placeholder and survives — `api_key="A\napi_key="A` (unterminated quotes, so the
//      first match runs to the second line's quote) left the second credential on disk.
const asLineAlignedPlaceholder = (match) =>
  new Array(match.split("\n").length).fill(REDACTION_PLACEHOLDER).join("\n");

export function redactSecrets(text) {
  return applySpanRedactions(text, asPlaceholder);
}

/**
 * Blocked-path redaction: belt-and-braces over `redactSecrets`.
 *
 * Span-level redaction is only as good as how much of the value each pattern
 * consumes; anything it under-consumes survives as residue that is no longer
 * secret-shaped, so it passes the storability gate and reaches both disk and the
 * envelope. Destroying the whole *line* removes that entire failure class, at the
 * cost of some non-secret context on the affected lines only. Every other line is
 * preserved intact, so the artifact remains useful evidence.
 *
 * Order is PEM -> span -> line, and it is load-bearing in both directions.
 *
 * The span pass must run BEFORE the line pass. Running the line pass first slices a
 * match that spans a newline: for `password: "head\ntail"` the first line was destroyed
 * and `tail"` survived as residue that no longer matched anything, so the storability
 * gate passed it and it landed on disk inside an artifact stamped `redacted: true`.
 * `redactSecrets` alone always handled that text correctly; only the ordering was wrong.
 *
 * The line pass must still run AFTER, and its predicate covers both directions: a line
 * that still detects as a secret, and a line that merely *contains* a redaction. The
 * second half is what line-first ordering used to provide — a span that under-consumes
 * its value (`password=correct horse battery staple`) leaves a tail that is no longer
 * secret-shaped, and destroying the whole line is the only thing that removes it.
 *
 * Destroying only the matched line is still not enough, because a value can legitimately
 * live on the lines that FOLLOW its label. Whenever a pattern under-consumes such a
 * block, the orphaned continuation lines survive, stop being secret-shaped, pass the
 * storability gate and land on disk. So a further pass destroys the lines that BELONG to
 * a destroyed line:
 *
 *   - indentation: following lines indented strictly deeper than the destroyed line, up
 *     to the first line at equal-or-lower indent (blank lines do not end a block, they
 *     are just skipped). Sibling keys at the same indent are preserved, which is what
 *     keeps `database:` / `  password: x` / `  host: db-primary` readable evidence.
 *   - shell continuation: if the destroyed line's ORIGINAL text ended in a backslash the
 *     next line is the rest of that command, whatever its indent, and the rule cascades.
 *
 * Both rules read the ORIGINAL line, which the span pass has already overwritten — hence
 * the parallel arrays. Alignment is guaranteed by `asLineAlignedPlaceholder`, which
 * re-emits one placeholder per line the match covered, so the two splits have equal
 * length. The lookups are still written defensively.
 *
 * This converts "the regex must consume the value perfectly" into "the regex must be
 * roughly right", which is what a regex can actually deliver. It is scoped to the
 * BLOCKED path only; `redactSecrets` — which the storability gate and the compression
 * path depend on — is untouched.
 */
const INDENT_PATTERN = /^[ \t]*/;
const TRAILING_BACKSLASH_PATTERN = /\\[ \t]*\r?$/;

export function redactSecretLines(text) {
  const spanRedacted = applySpanRedactions(text, asLineAlignedPlaceholder);
  const originalLines = text.split("\n");
  const redactedLines = spanRedacted.split("\n");
  const originalAt = (index) => originalLines[index] ?? redactedLines[index] ?? "";

  const destroyed = redactedLines.map(
    (line) => hasSecret(line) || line.includes(REDACTION_PLACEHOLDER),
  );

  for (let index = 0; index < destroyed.length; index += 1) {
    if (!destroyed[index]) {
      continue;
    }

    // Shell continuation, cascading: `KEY=value \` then the rest of the command.
    for (
      let cursor = index;
      cursor + 1 < destroyed.length && TRAILING_BACKSLASH_PATTERN.test(originalAt(cursor));
      cursor += 1
    ) {
      destroyed[cursor + 1] = true;
    }

    // Indented block body belonging to the destroyed line.
    const indent = INDENT_PATTERN.exec(originalAt(index))[0].length;
    for (let cursor = index + 1; cursor < destroyed.length; cursor += 1) {
      const line = originalAt(cursor);
      if (line.trim() === "") {
        continue;
      }
      if (INDENT_PATTERN.exec(line)[0].length <= indent) {
        break;
      }
      destroyed[cursor] = true;
    }
  }

  return redactedLines
    .map((line, index) => (destroyed[index] ? REDACTION_PLACEHOLDER : line))
    .join("\n");
}

export function redactCommandArg(value, index, argv) {
  const previous = index > 0 ? argv[index - 1] : "";
  if (SECRET_FLAG_PATTERN.test(previous)) {
    return REDACTION_PLACEHOLDER;
  }
  if (SECRET_FLAG_PATTERN.test(value)) {
    return value.includes("=") ? value.replace(/=.*/, `=${REDACTION_PLACEHOLDER}`) : value;
  }
  return redactSecrets(value);
}

export function lineCount(text) {
  if (text.length === 0) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

export function classifyCommand(command, rawText, exitCode, requestedMode) {
  if (hasSecret(rawText)) {
    return {
      mode: "blocked",
      reasonCode: "CR_BLOCK_SECRET",
      // Informational: the blocked path in cli.js decides what is actually stored,
      // gated on re-detection over the redacted copy.
      shouldStore: true,
      shouldSummarize: false,
      redact: true,
    };
  }

  if (requestedMode === "raw") {
    return {
      mode: "passthrough",
      reasonCode: "CR_RAW_REQUESTED",
      shouldStore: false,
      shouldSummarize: false,
    };
  }

  const bytes = Buffer.byteLength(rawText, "utf8");
  const lines = lineCount(rawText);
  const executable = command[0] || "";
  const knownNoisy = /^(rg|grep|find|git|npm|pnpm|bun|pytest|node|tsc)$/.test(executable);
  const highNoise = bytes > 1200 || lines > 25;

  if (requestedMode === "dry-run") {
    return {
      mode: "passthrough",
      reasonCode: highNoise || knownNoisy ? "CR_DRY_RUN_WOULD_SUMMARIZE" : "CR_DRY_RUN_WOULD_PASS",
      shouldStore: false,
      shouldSummarize: false,
      dryRun: true,
    };
  }

  if (requestedMode === "compress" || highNoise) {
    return {
      mode: "reversible_summary",
      reasonCode: exitCode === 0 ? "CR_REVERSIBLE_SUMMARY" : "CR_REVERSIBLE_FAILURE_SUMMARY",
      shouldStore: true,
      shouldSummarize: true,
    };
  }

  return {
    mode: "passthrough",
    reasonCode: "CR_PASS_SMALL_OUTPUT",
    shouldStore: false,
    shouldSummarize: false,
  };
}

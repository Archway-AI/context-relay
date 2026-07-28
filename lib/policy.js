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
const LABEL_NAME = `(?:^|[^A-Za-z0-9_.-])(?:[A-Za-z0-9]+[_.-])*(?:${LABEL_KEYWORD})(?:[_.-][A-Za-z0-9]+)*`;
// Values are consumed WHOLE. A quoted value that stops at the first space leaves the
// tail of a passphrase behind as non-secret-shaped residue, which then passes the
// storability gate and gets written to disk. The `Bearer`/`Basic` alternative exists
// because `Authorization: Bearer <token>` has no `=`/`:` between scheme and token.
// Quotes may be backslash-escaped: a credential embedded in a `node -e "..."` script
// reaches `redactCommandArg` as `\"password\": \"...\"`, and a bare `["']?` stops at
// the backslash, leaving the value to the catch-all alternative — which consumes the
// lone `\` and leaks the credential into the displayed `command:` line.
const LABEL_VALUE =
  `(?:\\\\?"[^"\\\\]*\\\\?"|\\\\?'[^'\\\\]*\\\\?'|(?:Bearer|Basic|Token|Digest)\\s+[^"'\\s]+|[^"'\\s]+)`;
const LABELED_ASSIGNMENT_PATTERN = new RegExp(
  `${LABEL_NAME}(?:\\\\?["'])?\\s*[:=]\\s*${LABEL_VALUE}`,
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

const SECRET_FLAG_PATTERN = /^-{1,2}(?=[a-z0-9-]*(?:api-?key|secret|token|password|auth|credential))[a-z0-9-]+(?:=.*)?$/i;

export function isSafeOpaqueToken(token) {
  return HEX_DIGEST_PATTERN.test(token) || UUID_PATTERN.test(token);
}

function globalCopy(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

export function hasSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactSecrets(text) {
  // PEM blocks first: the shaped-pattern pass would otherwise only take the header.
  let redacted = text.replace(PEM_BLOCK_PATTERN, REDACTION_PLACEHOLDER);
  for (const pattern of SECRET_PATTERNS) {
    // Global copies: replacing only the first occurrence would leave later keys intact.
    redacted = redacted.replace(globalCopy(pattern), REDACTION_PLACEHOLDER);
  }
  redacted = redacted.replace(OPAQUE_TOKEN_PATTERN, (match) =>
    isSafeOpaqueToken(match) ? match : REDACTION_PLACEHOLDER,
  );
  return redacted;
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
 * PEM blocks are scrubbed first because they span lines.
 */
export function redactSecretLines(text) {
  const pemScrubbed = text.replace(PEM_BLOCK_PATTERN, REDACTION_PLACEHOLDER);
  const lineRedacted = pemScrubbed
    .split("\n")
    .map((line) => (hasSecret(line) ? REDACTION_PLACEHOLDER : line))
    .join("\n");
  // Still run the span pass: it catches shapes that only match across the full text.
  return redactSecrets(lineRedacted);
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

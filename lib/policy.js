export const REDACTION_PLACEHOLDER = "[REDACTED_SECRET]";

// Detection patterns: positive key shapes only. Deliberately NON-global — a /g regex
// carries `lastIndex` across `.test()` calls and silently alternates true/false.
// Generic "any 32+ opaque token" entropy matching was removed on purpose: git SHAs,
// UUIDs, npm integrity hashes and base64 blobs are routine agent output, and a
// destroy/redact action needs more precision than entropy can deliver.
const SECRET_PATTERNS = [
  // Labeled assignment (api_key=..., secret: ..., token = ..., password=...)
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[^"'\s]+/i,
  // OpenAI / Anthropic style
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  // Stripe
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  // GitHub fine-grained PAT
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  // AWS access key id
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  // Slack
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // GitLab PAT
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
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
const HEX_TOKEN_PATTERN = /^[0-9a-fA-F]{32,}$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SECRET_FLAG_PATTERN = /^-{1,2}(?=[a-z0-9-]*(?:api-?key|secret|token|password|auth|credential))[a-z0-9-]+(?:=.*)?$/i;

export function isSafeOpaqueToken(token) {
  return HEX_TOKEN_PATTERN.test(token) || UUID_PATTERN.test(token);
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

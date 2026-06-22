const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[^"'\s]+/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const SECRET_FLAG_PATTERN = /^-{1,2}(?=[a-z0-9-]*(?:api-?key|secret|token|password|auth|credential))[a-z0-9-]+(?:=.*)?$/i;
const STANDALONE_SECRET_VALUE_PATTERN = /^(?:sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_+=-]{32,})$/;

export function hasSecret(text) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return text
    .split(/[\s"'`]+/)
    .some((token) => STANDALONE_SECRET_VALUE_PATTERN.test(token));
}

export function redactSecrets(text) {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  }
  redacted = redacted.replace(/\b[A-Za-z0-9_+=-]{32,}\b/g, "[REDACTED_SECRET]");
  return redacted;
}

export function redactCommandArg(value, index, argv) {
  const previous = index > 0 ? argv[index - 1] : "";
  if (SECRET_FLAG_PATTERN.test(previous)) {
    return "[REDACTED_SECRET]";
  }
  if (SECRET_FLAG_PATTERN.test(value)) {
    return value.includes("=") ? value.replace(/=.*/, "=[REDACTED_SECRET]") : value;
  }
  if (STANDALONE_SECRET_VALUE_PATTERN.test(value)) {
    return "[REDACTED_SECRET]";
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
      shouldStore: false,
      shouldSummarize: false,
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

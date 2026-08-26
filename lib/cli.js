import process from "node:process";
import path from "node:path";
import { artifactMarker, ArtifactStore, estimateTokens } from "./artifact-store.js";
import { commandString, executeCapture, executeRaw, parseRunOptions } from "./command.js";
import { findGitSubcommandIndex, findNpmSubcommandIndex } from "./command-shape.js";
import { claudeHook, codexHook, installAgents, rewriteShellCommand, statusAgents, uninstallAgents } from "./integrations.js";
import { classifyCommand, hasSecret, lineCount, redactCommandArg, redactSecretLines } from "./policy.js";
import { dryRunReport, envelope, summarize } from "./summarize.js";

function usage() {
  return `Context Relay

Usage:
  context-relay run [--mode auto|compress|dry-run|raw] -- <command>
  context-relay raw -- <command>
  context-relay retrieve <artifact-id> [--range start:end] [--grep pattern]
  context-relay inspect <artifact-id>
  context-relay stats
  context-relay gain [--json]
  context-relay discover [--json]
  context-relay cleanup [--all]
  context-relay rewrite <shell-command>
  context-relay hook claude|codex
  context-relay init [--claude] [--codex] [--all] [--dry-run]
  context-relay status [--json]
  context-relay uninstall [--claude] [--codex] [--all] [--dry-run]
`;
}

function parseRetrievalOptions(args) {
  const artifactId = args[0];
  if (!artifactId) {
    throw new Error("missing artifact id");
  }
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--range") {
      options.range = args[index + 1];
      index += 1;
    } else if (option === "--grep") {
      options.grep = args[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown retrieve option: ${option}`);
    }
  }
  return { artifactId, options };
}

function applyRetrievalOptions(rawText, options) {
  if (options.range) {
    const match = options.range.match(/^(\d+):(\d+)$/);
    if (!match) {
      throw new Error("range must use start:end line numbers");
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const lines = rawText.split(/\r?\n/);
    return `${lines.slice(start - 1, end).join("\n")}\n`;
  }
  if (options.grep) {
    const pattern = new RegExp(options.grep);
    const matches = rawText
      .split(/\r?\n/)
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter((entry) => pattern.test(entry.line));
    return `${matches.map((entry) => `${entry.lineNumber}:${entry.line}`).join("\n")}\n`;
  }
  return rawText;
}

function parseJsonFlag(args, commandName) {
  const allowed = new Set(["--json"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`unknown ${commandName} option: ${arg}`);
    }
  }
  return args.includes("--json");
}

function formatBytes(value) {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function formatTokens(value) {
  return `${value.toLocaleString("en-US")} est. tokens`;
}

function executableName(command) {
  return path.basename(command[0] || "unknown");
}

// git/npm-family global flags that appear BEFORE the subcommand (e.g. `git -C /path log`)
// and would otherwise get mistaken for the subcommand itself, keying `git -C log` as
// `git -C` and leaving the reducer for `git log` unmatched. findGitSubcommandIndex and
// findNpmSubcommandIndex (lib/command-shape.js) are used ONLY here now - the PreToolUse
// rewrite gate (isAllowedCommandShape in lib/integrations.js) used to share this same
// flag-skipping logic, but a safety gate must never guess at a subcommand past an
// unrecognized flag, so it was rewritten to match a small number of exact positional
// shapes instead and no longer calls into lib/command-shape.js at all. commandKey is stats
// attribution, not a safety decision - a wrong guess here miscounts a bucket and nothing
// else, so it is the one place in this codebase where permissive flag-skipping still
// belongs. Do not reintroduce this table into the gate.
export function commandKey(command) {
  const executable = executableName(command);
  if (executable === "git") {
    const subcommandIndex = findGitSubcommandIndex(command);
    if (subcommandIndex !== -1 && command[subcommandIndex]) {
      return `git ${command[subcommandIndex]}`;
    }
    return executable;
  }
  if (["npm", "pnpm", "bun", "yarn"].includes(executable)) {
    const subcommandIndex = findNpmSubcommandIndex(command, executable);
    if (subcommandIndex !== -1) {
      if (command[subcommandIndex] === "run" && command[subcommandIndex + 1]) {
        return `${executable} run ${command[subcommandIndex + 1]}`;
      }
      if (command[subcommandIndex]) {
        return `${executable} ${command[subcommandIndex]}`;
      }
    }
  }
  if (["rg", "grep", "find", "pytest", "tsc", "node"].includes(executable)) {
    return executable;
  }
  return executable;
}

function runEvent(kind, { command, commandText, result, rawBytes, sentBytes, reasonCode }) {
  return {
    kind,
    command: commandText,
    executable: executableName(command),
    commandKey: commandKey(command),
    exitCode: result.code,
    reasonCode,
    rawBytes,
    sentBytes,
  };
}

let storeFailureNotified = false;

function notifyStoreFailure(error, detail) {
  if (storeFailureNotified) {
    return;
  }
  storeFailureNotified = true;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `CR_STORE_FAILED: local artifact store unavailable (${message})${detail ? `; ${detail}` : ""}\n`,
  );
}

// Telemetry must never change the child's observable outcome: a broken store degrades
// loudly on stderr instead of throwing past `process.exitCode = result.code`.
async function recordSafely(store, event) {
  try {
    await store.record(event);
  } catch (error) {
    notifyStoreFailure(error);
  }
}

function isRunEvent(event) {
  return event.kind !== "retrievals" && event.kind !== "retrieval_miss";
}

function analyzeCommandGroups(events) {
  const groups = new Map();
  for (const event of events) {
    if (!isRunEvent(event)) {
      continue;
    }
    const key = event.commandKey || event.executable || event.command || "unknown";
    const group = groups.get(key) || {
      command: key,
      runs: 0,
      compressed: 0,
      passthrough: 0,
      raw: 0,
      blocked: 0,
      raw_bytes: 0,
      sent_bytes: 0,
      compressed_raw_bytes: 0,
      passthrough_raw_bytes: 0,
      blocked_raw_bytes: 0,
      saved_bytes: 0,
      efficiency_percent: 0,
      examples: [],
    };
    group.runs += 1;
    group[event.kind] = (group[event.kind] || 0) + 1;
    group.raw_bytes += event.rawBytes || 0;
    group.sent_bytes += event.sentBytes || 0;
    if (event.kind === "compressed") {
      group.compressed_raw_bytes += event.rawBytes || 0;
    } else if (event.kind === "passthrough") {
      group.passthrough_raw_bytes += event.rawBytes || 0;
    } else if (event.kind === "blocked") {
      group.blocked_raw_bytes += event.rawBytes || 0;
    }
    if (event.command && group.examples.length < 3 && !group.examples.includes(event.command)) {
      group.examples.push(event.command);
    }
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .map((group) => {
      const saved = Math.max(0, group.raw_bytes - group.sent_bytes);
      return {
        ...group,
        saved_bytes: saved,
        saved_estimated_tokens: Math.ceil(saved / 4),
        efficiency_percent: group.raw_bytes > 0 ? Number(((saved / group.raw_bytes) * 100).toFixed(1)) : 0,
      };
    })
    .sort((a, b) => b.saved_bytes - a.saved_bytes);
}

function gainPayload(stats, events) {
  const commands = analyzeCommandGroups(events);
  return {
    summary: stats,
    top_commands: commands.filter((entry) => entry.saved_bytes > 0).slice(0, 8),
  };
}

function printGain(payload) {
  const stats = payload.summary;
  process.stdout.write("Context Relay gain\n");
  process.stdout.write(`runs: ${stats.runs} (${stats.compressed} compressed, ${stats.passthrough} passthrough, ${stats.blocked} blocked)\n`);
  process.stdout.write(`gross saved: ${formatBytes(stats.gross_saved_bytes)} (${formatTokens(stats.gross_saved_estimated_tokens)}) ${stats.gross_efficiency_percent}%\n`);
  process.stdout.write(`net saved after retrieval: ${formatBytes(stats.net_saved_bytes)} (${formatTokens(stats.net_saved_estimated_tokens)}) ${stats.net_efficiency_percent}%\n`);
  process.stdout.write(`retrievals: ${stats.retrievals}, retrieval bytes: ${formatBytes(stats.retrieval_bytes)}\n`);
  process.stdout.write(`compression savings: ${stats.compression_savings_pct}% (alias of gross efficiency)\n`);
  process.stdout.write(
    `rates per run: retrieval ${stats.retrieval_rate}, blocked ${stats.blocked_rate}, fallback ${stats.fallback_rate}\n`,
  );
  if (payload.top_commands.length === 0) {
    process.stdout.write("\nNo savings yet. Run a noisy command through `context-relay run --mode compress -- <command>` or install hooks with `context-relay init --all`.\n");
    return;
  }
  process.stdout.write("\nTop command savings:\n");
  for (const entry of payload.top_commands) {
    process.stdout.write(
      `- ${entry.command}: ${formatBytes(entry.saved_bytes)} saved (${formatTokens(entry.saved_estimated_tokens)}), ${entry.efficiency_percent}% across ${entry.runs} run(s)\n`,
    );
  }
}

function discoverPayload(stats, events, agentStatus) {
  const commands = analyzeCommandGroups(events);
  const highGain = commands.filter((entry) => entry.saved_bytes > 0 && entry.efficiency_percent >= 70).slice(0, 5);
  const reducerCandidates = commands
    .filter((entry) => entry.compressed > 0 && entry.compressed_raw_bytes >= 1200 && entry.efficiency_percent < 60)
    .slice(0, 5);
  const passthroughCandidates = commands
    .filter((entry) => entry.passthrough > 0 && entry.passthrough_raw_bytes >= 600)
    .slice(0, 5);
  const blocked = commands.filter((entry) => entry.blocked > 0).slice(0, 5);
  const setup = [];
  // A legacy bare hook is installed but does not wrap (it is the PATH-dependent form), so
  // `automaticShellWrapping` alone cannot phrase this - saying "not installed" contradicts
  // status, which reports hookInstalled: true. The remedy is the same either way; only the
  // description differs.
  for (const [provider, flag] of [["Claude Code", "claude"], ["Codex", "codex"]]) {
    const agent = agentStatus[flag];
    if (agent.automaticShellWrapping) {
      continue;
    }
    setup.push(
      agent.hookUpgradeable
        ? `${provider} hook is installed but needs migration. Run \`context-relay init --${flag}\`.`
        : `${provider} hook is not installed. Run \`context-relay init --${flag}\`.`,
    );
  }
  return {
    summary: {
      runs: stats.runs,
      gross_efficiency_percent: stats.gross_efficiency_percent,
      net_efficiency_percent: stats.net_efficiency_percent,
    },
    setup,
    high_gain: highGain,
    reducer_candidates: reducerCandidates,
    passthrough_candidates: passthroughCandidates,
    blocked,
  };
}

function printDiscover(payload) {
  process.stdout.write("Context Relay discover\n");
  process.stdout.write(`observed runs: ${payload.summary.runs}, gross efficiency: ${payload.summary.gross_efficiency_percent}%, net efficiency: ${payload.summary.net_efficiency_percent}%\n`);
  if (payload.setup.length > 0) {
    process.stdout.write("\nSetup gaps:\n");
    for (const item of payload.setup) {
      process.stdout.write(`- ${item}\n`);
    }
  }
  if (payload.high_gain.length > 0) {
    process.stdout.write("\nAlready working well:\n");
    for (const entry of payload.high_gain) {
      process.stdout.write(`- ${entry.command}: ${entry.efficiency_percent}% saved across ${entry.runs} run(s)\n`);
    }
  }
  if (payload.reducer_candidates.length > 0) {
    process.stdout.write("\nReducer candidates:\n");
    for (const entry of payload.reducer_candidates) {
      process.stdout.write(
        `- ${entry.command}: ${formatBytes(entry.compressed_raw_bytes)} compressed raw, ${entry.efficiency_percent}% saved. Add a command-aware reducer.\n`,
      );
    }
  }
  if (payload.passthrough_candidates.length > 0) {
    process.stdout.write("\nPassthrough candidates:\n");
    for (const entry of payload.passthrough_candidates) {
      process.stdout.write(`- ${entry.command}: ${formatBytes(entry.passthrough_raw_bytes)} passed through. Consider `);
      process.stdout.write("`--mode compress` if this output is noisy.\n");
    }
  }
  if (payload.blocked.length > 0) {
    process.stdout.write("\nSecret/PII blocks:\n");
    for (const entry of payload.blocked) {
      process.stdout.write(`- ${entry.command}: ${entry.blocked} blocked run(s)\n`);
    }
  }
  if (
    payload.setup.length === 0 &&
    payload.high_gain.length === 0 &&
    payload.reducer_candidates.length === 0 &&
    payload.passthrough_candidates.length === 0 &&
    payload.blocked.length === 0
  ) {
    process.stdout.write("\nNo local events yet. Install hooks with `context-relay init --all`, run a normal coding session, then come back.\n");
  }
}

async function runCommand(args, store) {
  const { mode: requestedMode, command } = parseRunOptions(args);
  const displayCwd = process.env.CONTEXT_RELAY_DISPLAY_CWD || process.cwd();
  if (requestedMode === "raw") {
    const code = await executeRaw(command);
    process.exitCode = code;
    return;
  }

  const result = await executeCapture(command);
  const policy = classifyCommand(command, result.rawText, result.code, requestedMode);
  const rawBytes = Buffer.byteLength(result.rawText, "utf8");
  const safeCommandText = commandString(command, redactCommandArg);

  if (policy.mode === "blocked") {
    // Evidence preservation with a structural safety property: store the redacted copy
    // only if re-running detection over it finds nothing. Otherwise destroy it, as before.
    // `redactSecretLines` (not `redactSecrets`) destroys every line that matched, so a
    // pattern that under-consumes a value cannot leave a non-secret-shaped residue that
    // slips past the gate below and lands on disk.
    const redactedText = redactSecretLines(result.rawText);
    const storable = !hasSecret(redactedText);

    let blockedArtifact;
    if (storable) {
      try {
        blockedArtifact = await store.put({
          rawText: redactedText,
          command: safeCommandText,
          cwd: displayCwd,
          mode: "blocked",
          reasonCode: "CR_BLOCK_SECRET",
          redacted: true,
        });
      } catch (error) {
        // Never fall back to printing result.rawText here: it holds the secret.
        notifyStoreFailure(error, "redacted evidence was not stored");
      }
    }

    let reasonCode;
    let summary;
    if (blockedArtifact) {
      reasonCode = "CR_BLOCK_SECRET";
      // Counts only — deliberately NOT summarize(). Its `highlights:` section quotes
      // lines from the blocked output, so any imperfection in redaction would reach
      // the agent's context window, which is harder to contain than reaching disk.
      // Retrieval stays the single, deliberate way to see the redacted content.
      summary = [
        "Secret-shaped content was detected and replaced with [REDACTED_SECRET] before storage.",
        "No content from this output is relayed here; retrieve the artifact to read the redacted text.",
        `command: ${safeCommandText}`,
        `exit_code: ${result.code}`,
        `duration_ms: ${result.durationMs}`,
        `raw_lines: ${lineCount(result.rawText)}`,
        `raw_estimated_tokens: ${estimateTokens(result.rawText)}`,
      ].join("\n");
    } else if (storable) {
      reasonCode = "CR_BLOCK_SECRET";
      summary =
        "Output matched secret policy. The local artifact store was unavailable, so the redacted copy was not stored and nothing was relayed.";
    } else {
      // Unreachable by construction with the current pattern set: every pattern's
      // redaction consumes its own match whole, and the placeholder cannot re-trigger
      // detection (see REDACTION_PLACEHOLDER in policy.js — the closing `]` is what
      // blocks a label pattern from reaching a `:`/`=`). Fuzzing produced zero
      // failures of this gate at 215,772 combinations over the fixture matrix, and an
      // independent 400,000-combination adversarial-punctuation run agreed — against
      // 774 failures on the pre-change baseline. The branch is kept as a
      // guard for FUTURE pattern additions whose redaction is partial but still
      // detectable; it is not exercised end-to-end by the test suite.
      reasonCode = "CR_BLOCK_SECRET_UNSTORABLE";
      summary =
        "Output matched secret policy and could not be safely redacted for storage. It was not relayed and not stored. Rerun with a safer command or redirect sensitive output outside agent context.";
    }

    const output = envelope({
      commandText: safeCommandText,
      cwd: displayCwd,
      exitCode: result.code,
      durationMs: result.durationMs,
      mode: "blocked",
      reasonCode,
      marker: blockedArtifact ? artifactMarker(blockedArtifact) : undefined,
      summary,
    });
    process.stdout.write(output);
    await recordSafely(
      store,
      runEvent("blocked", {
        command,
        commandText: safeCommandText,
        result,
        rawBytes,
        sentBytes: Buffer.byteLength(output, "utf8"),
        reasonCode,
      }),
    );
    process.exitCode = result.code;
    return;
  }

  if (policy.dryRun) {
    const output = dryRunReport({
      commandText: safeCommandText,
      rawText: result.rawText,
      exitCode: result.code,
      durationMs: result.durationMs,
      reasonCode: policy.reasonCode,
    });
    process.stdout.write(output);
    await recordSafely(
      store,
      runEvent("raw", {
        command,
        commandText: safeCommandText,
        result,
        rawBytes,
        sentBytes: Buffer.byteLength(output, "utf8"),
        reasonCode: policy.reasonCode,
      }),
    );
    process.exitCode = result.code;
    return;
  }

  if (!policy.shouldSummarize) {
    process.stdout.write(result.rawText);
    await recordSafely(
      store,
      runEvent("passthrough", {
        command,
        commandText: safeCommandText,
        result,
        rawBytes,
        sentBytes: rawBytes,
        reasonCode: policy.reasonCode,
      }),
    );
    process.exitCode = result.code;
    return;
  }

  let artifact;
  try {
    artifact = await store.put({
      rawText: result.rawText,
      command: safeCommandText,
      cwd: displayCwd,
      mode: policy.mode,
      reasonCode: policy.reasonCode,
    });
  } catch (error) {
    notifyStoreFailure(error, "raw output passed through without compression");
    process.stdout.write(result.rawText);
    await recordSafely(
      store,
      runEvent("passthrough", {
        command,
        commandText: safeCommandText,
        result,
        rawBytes,
        sentBytes: rawBytes,
        reasonCode: "CR_STORE_FAILED",
      }),
    );
    process.exitCode = result.code;
    return;
  }

  const output = envelope({
    commandText: safeCommandText,
    cwd: displayCwd,
    exitCode: result.code,
    durationMs: result.durationMs,
    mode: policy.mode,
    reasonCode: policy.reasonCode,
    marker: artifactMarker(artifact),
    summary: summarize({ commandText: safeCommandText, rawText: result.rawText, exitCode: result.code, durationMs: result.durationMs }),
  });
  process.stdout.write(output);
  await recordSafely(
    store,
    runEvent("compressed", {
      command,
      commandText: safeCommandText,
      result,
      rawBytes,
      sentBytes: Buffer.byteLength(output, "utf8"),
      reasonCode: policy.reasonCode,
    }),
  );
  process.exitCode = result.code;
}

async function rawCommand(args) {
  const separator = args.indexOf("--");
  const command = separator === -1 ? [] : args.slice(separator + 1);
  if (command.length === 0) {
    throw new Error("missing command after --");
  }
  process.exitCode = await executeRaw(command);
}

async function retrieve(args, store) {
  const { artifactId, options } = parseRetrievalOptions(args);
  try {
    const { payload, rawText } = await store.get(artifactId);
    const output = applyRetrievalOptions(rawText, options);
    process.stdout.write(output);
    if (payload.content?.redacted === true) {
      // stdout stays byte-for-byte the stored text; the provenance notice goes to stderr.
      process.stderr.write(
        `CR_NOTICE_REDACTED: artifact ${artifactId} was stored with standard-secret-redaction; [REDACTED_SECRET] replaces detected secret values\n`,
      );
    }
    await recordSafely(store, { kind: "retrievals", retrievalBytes: Buffer.byteLength(output, "utf8") });
  } catch (error) {
    await recordSafely(store, { kind: "retrieval_miss" });
    throw error;
  }
}

async function inspect(args, store) {
  const artifactId = args[0];
  if (!artifactId) {
    throw new Error("missing artifact id");
  }
  const { payload } = await store.get(artifactId);
  const { raw_base64: _raw, ...metadata } = payload;
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

async function stats(store) {
  process.stdout.write(`${JSON.stringify(await store.readStats(), null, 2)}\n`);
}

async function gain(args, store) {
  const json = parseJsonFlag(args, "gain");
  const payload = gainPayload(await store.readStats(), await store.readEvents());
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  printGain(payload);
}

async function discover(args, store) {
  const json = parseJsonFlag(args, "discover");
  const payload = discoverPayload(await store.readStats(), await store.readEvents(), await statusAgents(["--json"]));
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  printDiscover(payload);
}

async function cleanup(args, store) {
  const allowed = new Set(["--all"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`unknown cleanup option: ${arg}`);
    }
  }
  const result = await store.cleanup({ all: args.includes("--all") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function rewrite(args) {
  const command = args.join(" ");
  if (!command) {
    throw new Error("missing shell command");
  }
  const result = rewriteShellCommand(command);
  if (!result.changed) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.command}\n`);
}

async function hook(args) {
  const provider = args[0];
  if (!["claude", "codex"].includes(provider)) {
    throw new Error("hook provider must be claude or codex");
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8");
  process.stdout.write(provider === "codex" ? await codexHook(input) : await claudeHook(input));
}

async function init(args) {
  const results = await installAgents(args);
  process.stdout.write(`${JSON.stringify({ installed: results }, null, 2)}\n`);
}

async function agentStatus(args) {
  process.stdout.write(`${JSON.stringify(await statusAgents(args), null, 2)}\n`);
}

async function uninstall(args) {
  const results = await uninstallAgents(args);
  process.stdout.write(`${JSON.stringify({ uninstalled: results }, null, 2)}\n`);
}

export async function main(args) {
  const command = args[0];
  const store = new ArtifactStore();
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "run") {
    await runCommand(args.slice(1), store);
  } else if (command === "raw") {
    await rawCommand(args.slice(1));
  } else if (command === "retrieve") {
    await retrieve(args.slice(1), store);
  } else if (command === "inspect") {
    await inspect(args.slice(1), store);
  } else if (command === "stats") {
    await stats(store);
  } else if (command === "gain") {
    await gain(args.slice(1), store);
  } else if (command === "discover") {
    await discover(args.slice(1), store);
  } else if (command === "cleanup") {
    await cleanup(args.slice(1), store);
  } else if (command === "rewrite") {
    await rewrite(args.slice(1));
  } else if (command === "hook") {
    await hook(args.slice(1));
  } else if (command === "init") {
    await init(args.slice(1));
  } else if (command === "status") {
    await agentStatus(args.slice(1));
  } else if (command === "uninstall") {
    await uninstall(args.slice(1));
  } else {
    throw new Error(`unknown command: ${command}\n\n${usage()}`);
  }
}

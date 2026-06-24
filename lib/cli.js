import process from "node:process";
import path from "node:path";
import { artifactMarker, ArtifactStore } from "./artifact-store.js";
import { commandString, executeCapture, executeRaw, parseRunOptions } from "./command.js";
import { claudeHook, codexHook, installAgents, rewriteShellCommand, statusAgents, uninstallAgents } from "./integrations.js";
import { classifyCommand, redactCommandArg } from "./policy.js";
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

function commandKey(command) {
  const executable = executableName(command);
  if (executable === "git" && command[1]) {
    return `git ${command[1]}`;
  }
  if (["npm", "pnpm", "bun", "yarn"].includes(executable)) {
    if (command[1] === "run" && command[2]) {
      return `${executable} run ${command[2]}`;
    }
    if (command[1]) {
      return `${executable} ${command[1]}`;
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
  if (!agentStatus.claude.automaticShellWrapping) {
    setup.push("Claude Code hook is not installed. Run `context-relay init --claude`.");
  }
  if (!agentStatus.codex.automaticShellWrapping) {
    setup.push("Codex hook is not installed. Run `context-relay init --codex`.");
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
    const output = envelope({
      commandText: safeCommandText,
      cwd: displayCwd,
      exitCode: result.code,
      durationMs: result.durationMs,
      mode: "blocked",
      reasonCode: policy.reasonCode,
      summary: "Output matched secret or PII policy and was not relayed. Rerun with a safer command or redirect sensitive output outside agent context.",
    });
    process.stdout.write(output);
    await store.record(
      runEvent("blocked", {
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

  if (policy.dryRun) {
    const output = dryRunReport({
      commandText: safeCommandText,
      rawText: result.rawText,
      exitCode: result.code,
      durationMs: result.durationMs,
      reasonCode: policy.reasonCode,
    });
    process.stdout.write(output);
    await store.record(
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
    await store.record(
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
  } catch {
    process.stdout.write(result.rawText);
    await store.record(
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
  await store.record(
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
    const { rawText } = await store.get(artifactId);
    const output = applyRetrievalOptions(rawText, options);
    process.stdout.write(output);
    await store.record({ kind: "retrievals", retrievalBytes: Buffer.byteLength(output, "utf8") });
  } catch (error) {
    await store.record({ kind: "retrieval_miss" });
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

import process from "node:process";
import { artifactMarker, ArtifactStore } from "./artifact-store.js";
import { commandString, executeCapture, executeRaw, parseRunOptions } from "./command.js";
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
  context-relay cleanup [--all]
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

async function runCommand(args, store) {
  const { mode: requestedMode, command } = parseRunOptions(args);
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
      cwd: process.cwd(),
      exitCode: result.code,
      durationMs: result.durationMs,
      mode: "blocked",
      reasonCode: policy.reasonCode,
      summary: "Output matched secret or PII policy and was not relayed. Rerun with a safer command or redirect sensitive output outside agent context.",
    });
    process.stdout.write(output);
    await store.record({ kind: "blocked", rawBytes, sentBytes: Buffer.byteLength(output, "utf8") });
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
    await store.record({ kind: "raw", rawBytes, sentBytes: Buffer.byteLength(output, "utf8") });
    process.exitCode = result.code;
    return;
  }

  if (!policy.shouldSummarize) {
    process.stdout.write(result.rawText);
    await store.record({ kind: "passthrough", rawBytes, sentBytes: rawBytes });
    process.exitCode = result.code;
    return;
  }

  let artifact;
  try {
    artifact = await store.put({
      rawText: result.rawText,
      command: safeCommandText,
      cwd: process.cwd(),
      mode: policy.mode,
      reasonCode: policy.reasonCode,
    });
  } catch {
    process.stdout.write(result.rawText);
    await store.record({ kind: "passthrough", rawBytes, sentBytes: rawBytes });
    process.exitCode = result.code;
    return;
  }

  const output = envelope({
    commandText: safeCommandText,
    cwd: process.cwd(),
    exitCode: result.code,
    durationMs: result.durationMs,
    mode: policy.mode,
    reasonCode: policy.reasonCode,
    marker: artifactMarker(artifact),
    summary: summarize({ commandText: safeCommandText, rawText: result.rawText, exitCode: result.code, durationMs: result.durationMs }),
  });
  process.stdout.write(output);
  await store.record({ kind: "compressed", rawBytes, sentBytes: Buffer.byteLength(output, "utf8") });
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
  } else if (command === "cleanup") {
    await cleanup(args.slice(1), store);
  } else {
    throw new Error(`unknown command: ${command}\n\n${usage()}`);
  }
}

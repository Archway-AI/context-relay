import { spawn } from "node:child_process";

export function splitCommandArgs(args) {
  const separator = args.indexOf("--");
  if (separator === -1) {
    return { options: args, command: [] };
  }
  return { options: args.slice(0, separator), command: args.slice(separator + 1) };
}

export function parseRunOptions(args) {
  const { options, command } = splitCommandArgs(args);
  let mode = "auto";
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--dry-run") {
      mode = "dry-run";
    } else if (option === "--raw" || option === "--no-compress") {
      mode = "raw";
    } else if (option === "--mode") {
      mode = options[index + 1] || mode;
      index += 1;
    } else if (option.startsWith("--mode=")) {
      mode = option.slice("--mode=".length);
    } else {
      throw new Error(`unknown run option: ${option}`);
    }
  }
  if (!["auto", "compress", "dry-run", "raw"].includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  if (command.length === 0) {
    throw new Error("missing command after --");
  }
  return { mode, command };
}

export function commandString(command, redact = (value) => value) {
  return command.map((part, index) => {
    const safe = redact(part, index, command);
    return /\s/.test(safe) ? JSON.stringify(safe) : safe;
  }).join(" ");
}

export function executeCapture(command, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push({ stream: "stdout", chunk }));
    child.stderr.on("data", (chunk) => chunks.push({ stream: "stderr", chunk }));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const rawText = chunks.map((item) => item.chunk.toString("utf8")).join("");
      resolve({
        code: code ?? (signal ? 128 : 1),
        signal,
        rawText,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function executeRaw(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

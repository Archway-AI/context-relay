import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLAUDE_MARKER = "@CONTEXT_RELAY.md";
const CODEX_MARKER = "@CONTEXT_RELAY.md";
const CLAUDE_HOOK_COMMAND = "context-relay hook claude";
const CODEX_HOOK_COMMAND = "context-relay hook codex";
const MANAGED_START = "# --- Context Relay managed block ---";
const MANAGED_END = "# --- end Context Relay managed block ---";

const SAFE_COMMANDS = new Set([
  "bun",
  "cargo",
  "deno",
  "find",
  "git",
  "grep",
  "jest",
  "make",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "rg",
  "tsc",
  "yarn",
]);

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

const SAFE_GIT_SUBCOMMANDS = new Set([
  "blame",
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "show",
  "status",
]);
const SHELL_CONTROL_OPERATOR_PATTERN = /&&|\|\||[|;&]/;

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
    SHELL_CONTROL_OPERATOR_PATTERN.test(command)
  );
}

function commandParts(command) {
  return command.trim().split(/\s+/);
}

function isAllowedCommandShape(command, executable) {
  const parts = commandParts(command);
  if (INTERACTIVE_OR_LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(command))) {
    return false;
  }
  if (executable === "git") {
    return SAFE_GIT_SUBCOMMANDS.has(parts[1]);
  }
  if (executable === "npm" || executable === "pnpm") {
    if (parts[1] === "run") {
      return FINITE_PACKAGE_SUBCOMMANDS.has(parts[2]);
    }
    return FINITE_PACKAGE_SUBCOMMANDS.has(parts[1]);
  }
  if (executable === "yarn") {
    return FINITE_YARN_SUBCOMMANDS.has(parts[1]);
  }
  if (executable === "bun") {
    return FINITE_BUN_SUBCOMMANDS.has(parts[1]) || (parts[1] === "run" && FINITE_PACKAGE_SUBCOMMANDS.has(parts[2]));
  }
  if (executable === "cargo") {
    return FINITE_CARGO_SUBCOMMANDS.has(parts[1]);
  }
  if (executable === "deno") {
    return FINITE_DENO_SUBCOMMANDS.has(parts[1]);
  }
  if (executable === "node") {
    return parts[1] === "--test";
  }
  if (executable === "make") {
    return parts.length > 1 && parts.every((part) => !part.includes("="));
  }
  if (executable === "jest") {
    return !parts.some((part) => part === "--watch" || part === "--watchAll");
  }
  return SAFE_COMMANDS.has(executable);
}

export function rewriteShellCommand(command, options = {}) {
  const trimmed = command.trim();
  if (!trimmed) {
    return { changed: false, reason: "empty" };
  }
  if (hasUnsupportedShellShape(command)) {
    return { changed: false, reason: "unsupported-shell-shape" };
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

function appendMarker(content, marker) {
  if (content.includes(marker)) {
    return content.endsWith("\n") ? content : `${content}\n`;
  }
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${marker}\n`;
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

function mergeClaudeSettings(existing) {
  let settings = {};
  if (existing.trim()) {
    settings = JSON.parse(existing);
  }
  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const hasHook = preToolUse.some((entry) => {
    if (entry?.matcher !== "Bash" || !Array.isArray(entry.hooks)) {
      return false;
    }
    return entry.hooks.some((hook) => hook?.type === "command" && hook?.command === CLAUDE_HOOK_COMMAND);
  });
  const nextPreToolUse = hasHook
    ? preToolUse
    : [
        ...preToolUse,
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }],
        },
      ];
  return `${JSON.stringify({ ...settings, hooks: { ...hooks, PreToolUse: nextPreToolUse } }, null, 2)}\n`;
}

function removeClaudeHook(existing) {
  if (!existing.trim()) {
    return "";
  }
  const settings = JSON.parse(existing);
  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const nextPreToolUse = preToolUse
    .map((entry) => {
      if (entry?.matcher !== "Bash" || !Array.isArray(entry.hooks)) {
        return entry;
      }
      return {
        ...entry,
        hooks: entry.hooks.filter((hook) => hook?.type !== "command" || hook?.command !== CLAUDE_HOOK_COMMAND),
      };
    })
    .filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);
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

function mergeManagedBlock(content, block) {
  const pattern = new RegExp(`${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block}`;
}

function removeManagedBlock(content) {
  const pattern = new RegExp(`${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
  return content.replace(pattern, "").trimEnd() + (content.trim() ? "\n" : "");
}

function parseJsonObject(existing) {
  if (!existing.trim()) {
    return {};
  }
  return JSON.parse(existing);
}

function mergeCodexHooks(existing) {
  const payload = parseJsonObject(existing);
  const hooks = payload.hooks && typeof payload.hooks === "object" ? payload.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const hasHook = preToolUse.some((entry) => {
    if (entry?.matcher !== "Bash" || !Array.isArray(entry.hooks)) {
      return false;
    }
    return entry.hooks.some((hook) => hook?.type === "command" && hook?.command === CODEX_HOOK_COMMAND);
  });
  const nextPreToolUse = hasHook
    ? preToolUse
    : [
        ...preToolUse,
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: CODEX_HOOK_COMMAND,
              statusMessage: "Wrapping noisy shell output with Context Relay",
            },
          ],
        },
      ];
  return `${JSON.stringify({ ...payload, hooks: { ...hooks, PreToolUse: nextPreToolUse } }, null, 2)}\n`;
}

function removeCodexHook(existing) {
  const payload = parseJsonObject(existing);
  const hooks = payload.hooks && typeof payload.hooks === "object" ? payload.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const nextPreToolUse = preToolUse
    .map((entry) => {
      if (entry?.matcher !== "Bash" || !Array.isArray(entry.hooks)) {
        return entry;
      }
      return {
        ...entry,
        hooks: entry.hooks.filter((hook) => hook?.type !== "command" || hook?.command !== CODEX_HOOK_COMMAND),
      };
    })
    .filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);
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
  const existingSettings = await readText(settingsPath);
  const nextSettings = mergeClaudeSettings(existingSettings);
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
    hook: CLAUDE_HOOK_COMMAND,
  };
}

export async function installCodex(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const root = codexDir();
  const awarenessPath = path.join(root, "CONTEXT_RELAY.md");
  const agentsPath = path.join(root, "AGENTS.md");
  const hooksPath = path.join(root, "hooks.json");
  const existingAgents = await readText(agentsPath);
  const nextAgents = mergeManagedBlock(existingAgents, buildCodexManagedBlock());
  const existingHooks = await readText(hooksPath);
  const nextHooks = mergeCodexHooks(existingHooks);

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
    hook: CODEX_HOOK_COMMAND,
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
  const claudeSettings = await readText(path.join(rootClaude, "settings.json"));
  const claudeMd = await readText(path.join(rootClaude, "CLAUDE.md"));
  const codexAgents = await readText(path.join(rootCodex, "AGENTS.md"));
  const codexHooks = await readText(path.join(rootCodex, "hooks.json"));

  let claudeHookInstalled = false;
  try {
    const settings = claudeSettings.trim() ? JSON.parse(claudeSettings) : {};
    claudeHookInstalled = Boolean(
      settings.hooks?.PreToolUse?.some(
        (entry) =>
          entry?.matcher === "Bash" &&
          entry.hooks?.some((hook) => hook?.type === "command" && hook?.command === CLAUDE_HOOK_COMMAND),
      ),
    );
  } catch {
    claudeHookInstalled = false;
  }
  let codexHookInstalled = false;
  try {
    const hooksPayload = codexHooks.trim() ? JSON.parse(codexHooks) : {};
    codexHookInstalled = Boolean(
      hooksPayload.hooks?.PreToolUse?.some(
        (entry) =>
          entry?.matcher === "Bash" &&
          entry.hooks?.some((hook) => hook?.type === "command" && hook?.command === CODEX_HOOK_COMMAND),
      ),
    );
  } catch {
    codexHookInstalled = false;
  }

  return {
    claude: {
      directory: rootClaude,
      hookInstalled: claudeHookInstalled,
      awarenessLinked: claudeMd.includes(CLAUDE_MARKER),
      automaticShellWrapping: claudeHookInstalled,
    },
    codex: {
      directory: rootCodex,
      hookInstalled: codexHookInstalled,
      awarenessLinked: codexAgents.includes(CODEX_MARKER),
      automaticShellWrapping: codexHookInstalled,
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
    const existingSettings = await readText(settingsPath);
    const existingClaudeMd = await readText(claudeMdPath);
    const nextSettings = removeClaudeHook(existingSettings);
    const nextClaudeMd = existingClaudeMd
      .split(/\r?\n/)
      .filter((line) => line.trim() !== CLAUDE_MARKER)
      .join("\n")
      .trimEnd();
    await writeText(settingsPath, nextSettings, options.dryRun);
    await writeText(claudeMdPath, nextClaudeMd ? `${nextClaudeMd}\n` : "", options.dryRun);
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
    const existingHooks = await readText(hooksPath);
    const nextHooks = removeCodexHook(existingHooks);
    await writeText(agentsPath, nextAgents, options.dryRun);
    await writeText(hooksPath, nextHooks, options.dryRun);
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

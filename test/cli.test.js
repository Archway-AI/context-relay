import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const bin = new URL("../bin/context-relay.js", import.meta.url).pathname;
const packageRoot = path.dirname(new URL("../package.json", import.meta.url).pathname);
let storeDir;
let tempDirs = [];

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      CONTEXT_RELAY_STORE_DIR: storeDir,
      CONTEXT_RELAY_RUN_ID: "testrun",
      ...(options.env || {}),
    },
    input: options.input,
    encoding: "utf8",
  });
}

function runAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, CONTEXT_RELAY_STORE_DIR: storeDir, CONTEXT_RELAY_RUN_ID: "testrun" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function noisyNodeCommand(lines = 40) {
  return [
    process.execPath,
    "-e",
    `for (let i = 1; i <= ${lines}; i++) console.log("file" + i + ".ts:" + i + ":TODO item " + i)`,
  ];
}

function artifactId(output) {
  const match = output.match(/\[artifact:cr:(cr_[^ ]+)/);
  assert.ok(match, output);
  return match[1];
}

async function makeTempGitRepo(remote = "git@github.com:Example-Org/example-repo.git") {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "context-relay-repo-"));
  tempDirs.push(repoDir);
  spawnSync("git", ["init"], { cwd: repoDir, encoding: "utf8" });
  spawnSync("git", ["remote", "add", "origin", remote], { cwd: repoDir, encoding: "utf8" });
  return repoDir;
}

beforeEach(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), "context-relay-test-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("context-relay CLI", () => {
  it("prints help", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /context-relay run/);
    assert.match(result.stdout, /context-relay cleanup/);
    assert.match(result.stdout, /context-relay hook claude\|codex/);
  });

  it("passes small output through", () => {
    const result = run(["run", "--", process.execPath, "-e", "console.log('small')"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "small\n");
  });

  it("summarizes noisy output and stores a retrievable artifact", () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR compressed output/);
    assert.match(result.stdout, /raw: \[artifact:cr:/);
    assert.match(result.stdout, /raw_estimated_tokens:/);

    const retrieve = run(["retrieve", artifactId(result.stdout)]);
    assert.equal(retrieve.status, 0);
    assert.match(retrieve.stdout, /file1\.ts:1:TODO item 1/);
    assert.match(retrieve.stdout, /file40\.ts:40:TODO item 40/);
  });

  it("supports inspect without returning raw content", () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const inspect = run(["inspect", artifactId(result.stdout)]);
    assert.equal(inspect.status, 0);
    const metadata = JSON.parse(inspect.stdout);
    assert.equal(metadata.schema_version, "cr-artifact-v0.1");
    assert.equal(metadata.content.redacted, false);
    assert.ok(!inspect.stdout.includes("TODO item 1"));
  });

  it("uses git remote metadata when available", async () => {
    const repoDir = await makeTempGitRepo();
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()], { cwd: repoDir });
    const inspect = run(["inspect", artifactId(result.stdout)], { cwd: repoDir });
    assert.equal(inspect.status, 0);
    const metadata = JSON.parse(inspect.stdout);
    assert.equal(metadata.workspace, "Example-Org");
    assert.equal(metadata.repo, "example-repo");
  });

  it("summarizes large JSON with counts and warning examples", () => {
    const jsonCommand = [
      process.execPath,
      "-e",
      "const rows=Array.from({length:20},(_,i)=>({id:i,status:i%5===0?'warning':'ok',path:'file'+i+'.js'})); console.log(JSON.stringify({items:rows}, null, 2));",
    ];
    const result = run(["run", "--mode", "compress", "--", ...jsonCommand]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /json_root: object/);
    assert.match(result.stdout, /items: array\(20\)/);
    assert.match(result.stdout, /status_counts: warning=4, ok=16/);
    assert.match(result.stdout, /file0\.js/);
  });

  it("supports range and grep retrieval", () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand(8)]);
    const id = artifactId(result.stdout);

    const range = run(["retrieve", id, "--range", "2:3"]);
    assert.equal(range.status, 0);
    assert.equal(range.stdout, "file2.ts:2:TODO item 2\nfile3.ts:3:TODO item 3\n");

    const grep = run(["retrieve", id, "--grep", "item 7"]);
    assert.equal(grep.status, 0);
    assert.equal(grep.stdout, "7:file7.ts:7:TODO item 7\n");
  });

  it("fails safely for missing artifacts", () => {
    const result = run(["retrieve", "cr_missing"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CR_RETRIEVE_MISSING/);
  });

  it("fails safely for corrupt artifacts", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    const artifactPath = path.join(storeDir, "artifacts", `${id}.json`);
    const payload = JSON.parse(await readFile(artifactPath, "utf8"));
    payload.raw_base64 = Buffer.from("tampered", "utf8").toString("base64");
    await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);

    const retrieve = run(["retrieve", id]);
    assert.notEqual(retrieve.status, 0);
    assert.match(retrieve.stderr, /CR_RETRIEVE_HASH_MISMATCH/);
  });

  it("fails safely for expired artifacts", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    const artifactPath = path.join(storeDir, "artifacts", `${id}.json`);
    const payload = JSON.parse(await readFile(artifactPath, "utf8"));
    payload.expires_at = "2000-01-01T00:00:00.000Z";
    await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);

    const retrieve = run(["retrieve", id]);
    assert.notEqual(retrieve.status, 0);
    assert.match(retrieve.stderr, /CR_RETRIEVE_EXPIRED/);
  });

  it("uses opaque artifact ids separate from content hashes", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    const payload = JSON.parse(await readFile(path.join(storeDir, "artifacts", `${id}.json`), "utf8"));

    assert.ok(payload.content.sha256);
    assert.ok(!id.includes(payload.content.sha256.slice(0, 12)));
  });

  it("does not relay detected secrets", () => {
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "console.log('api_key=abcdefghijklmnop123456')",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.doesNotMatch(result.stdout, /abcdefghijklmnop123456/);
  });

  it("redacts flag value secrets from displayed commands", () => {
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "console.log('api_key=abcdefghijklmnop123456')",
      "--",
      "--token",
      "abcdefghijklmnopqrstuvwxyz123456",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--token \[REDACTED_SECRET\]/);
    assert.doesNotMatch(result.stdout, /abcdefghijklmnopqrstuvwxyz123456/);
  });

  it("redacts compound secret flag values from displayed commands", () => {
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "console.log('api_key=abcdefghijklmnop123456')",
      "--",
      "--access-token",
      "shortsecret12345",
      "--client-secret",
      "anothersecret",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--access-token \[REDACTED_SECRET\]/);
    assert.match(result.stdout, /--client-secret \[REDACTED_SECRET\]/);
    assert.doesNotMatch(result.stdout, /shortsecret12345/);
    assert.doesNotMatch(result.stdout, /anothersecret/);
  });

  it("blocks standalone high-entropy child output", () => {
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "console.log('abcdefghijklmnopqrstuvwxyz123456')",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.doesNotMatch(result.stdout, /abcdefghijklmnopqrstuvwxyz123456/);
    assert.doesNotMatch(result.stdout, /artifact:cr:/);
  });

  it("blocks standalone JWT-like child output", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNvbnRleHRSZWxheSJ9.GHvqPZf8JW7V1DCxUX7wnp80lVj0lF83VCyA";
    const result = run(["run", "--mode", "compress", "--", process.execPath, "-e", `console.log('${jwt}')`]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.doesNotMatch(result.stdout, new RegExp(jwt));
    assert.doesNotMatch(result.stdout, /artifact:cr:/);
  });

  it("redacts short labeled secret arguments and blocks labeled secret output", () => {
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "for (let i = 0; i < 30; i++) console.log('line' + i);",
      "--",
      "token=value",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[REDACTED_SECRET\]/);
    assert.doesNotMatch(result.stdout, /token=value/);

    const blocked = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "console.log('token=value')",
    ]);
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /CR_BLOCK_SECRET/);
    assert.doesNotMatch(blocked.stdout, /token=value/);
  });

  it("does not treat token accounting labels as secrets", () => {
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "for (let i = 0; i < 30; i++) console.log('tokens=' + i)",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR compressed output/);
    assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/);
  });

  it("does not treat long repo paths as standalone secrets", () => {
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "for (let i = 0; i < 30; i++) console.log('plugins/context-relay/bin/context-relay.js:' + i + ': artifact reference')",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR compressed output/);
    assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/);
  });

  it("reports stats", async () => {
    run(["run", "--", process.execPath, "-e", "console.log('small')"]);
    const compressed = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    run(["retrieve", artifactId(compressed.stdout)]);
    const result = run(["stats"]);
    assert.equal(result.status, 0);
    const stats = JSON.parse(result.stdout);
    assert.equal(stats.runs, 2);
    assert.equal(stats.passthrough, 1);
    assert.equal(stats.compressed, 1);
    assert.equal(stats.retrievals, 1);
    assert.ok(stats.raw_bytes > 0);
    assert.ok(stats.sent_bytes > 0);
    assert.ok(stats.retrieval_bytes > 0);
    assert.ok((await readFile(path.join(storeDir, "events.jsonl"), "utf8")).includes("compressed"));
  });

  it("keeps stats across parallel retrievals", async () => {
    const compressed = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(compressed.stdout);
    const [first, second] = await Promise.all([
      runAsync(["retrieve", id, "--grep", "item 1"]),
      runAsync(["retrieve", id, "--grep", "item 2"]),
    ]);

    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    const result = run(["stats"]);
    const stats = JSON.parse(result.stdout);
    assert.equal(stats.retrievals, 2);
  });

  it("cleans expired artifacts without removing active artifacts", async () => {
    const expired = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const active = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const expiredId = artifactId(expired.stdout);
    const activeId = artifactId(active.stdout);
    const expiredPath = path.join(storeDir, "artifacts", `${expiredId}.json`);
    const payload = JSON.parse(await readFile(expiredPath, "utf8"));
    payload.expires_at = "2000-01-01T00:00:00.000Z";
    await writeFile(expiredPath, `${JSON.stringify(payload, null, 2)}\n`);

    const cleanup = run(["cleanup"]);
    assert.equal(cleanup.status, 0);
    assert.deepEqual(JSON.parse(cleanup.stdout), {
      removed_artifacts: 1,
      removed_events: false,
      mode: "expired",
    });
    await assert.rejects(access(expiredPath));
    const retrieve = run(["retrieve", activeId, "--grep", "TODO item 1"]);
    assert.equal(retrieve.status, 0);
  });

  it("cleans artifacts with invalid expiry metadata", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    const artifactPath = path.join(storeDir, "artifacts", `${id}.json`);
    const payload = JSON.parse(await readFile(artifactPath, "utf8"));
    delete payload.expires_at;
    await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);

    const cleanup = run(["cleanup"]);
    assert.equal(cleanup.status, 0);
    assert.deepEqual(JSON.parse(cleanup.stdout), {
      removed_artifacts: 1,
      removed_events: false,
      mode: "expired",
    });
    await assert.rejects(access(artifactPath));
  });

  it("cleans the full local store when requested", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    run(["retrieve", id, "--grep", "TODO item 1"]);

    const cleanup = run(["cleanup", "--all"]);
    assert.equal(cleanup.status, 0);
    assert.deepEqual(JSON.parse(cleanup.stdout), {
      removed_artifacts: 1,
      removed_events: true,
      mode: "all",
    });
    const stats = run(["stats"]);
    assert.equal(stats.status, 0);
    assert.equal(JSON.parse(stats.stdout).runs, 0);
  });

  it("rewrites eligible shell commands for agent hooks", () => {
    const result = run(["rewrite", "git", "status", "--short"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "context-relay run --mode auto -- bash -lc 'git status --short'\n");

    const skipped = run(["rewrite", "context-relay", "stats"]);
    assert.equal(skipped.status, 1);
    assert.equal(skipped.stdout, "");

    const mutatingGit = run(["rewrite", "git", "push"]);
    assert.equal(mutatingGit.status, 1);
    assert.equal(mutatingGit.stdout, "");

    const compound = run(["rewrite", "git", "status", "&&", "echo", "unsafe"]);
    assert.equal(compound.status, 1);
    assert.equal(compound.stdout, "");

    const compactPipe = run(["rewrite", "git", "grep", "TODO|FIXME"]);
    assert.equal(compactPipe.status, 1);
    assert.equal(compactPipe.stdout, "");

    const compactSequence = run(["rewrite", "git", "status;echo", "unsafe"]);
    assert.equal(compactSequence.status, 1);
    assert.equal(compactSequence.stdout, "");

    const devServer = run(["rewrite", "npm", "run", "dev"]);
    assert.equal(devServer.status, 1);
    assert.equal(devServer.stdout, "");

    const interactiveInit = run(["rewrite", "npm", "init"]);
    assert.equal(interactiveInit.status, 1);
    assert.equal(interactiveInit.stdout, "");

    const packageTest = run(["rewrite", "npm", "test"]);
    assert.equal(packageTest.status, 0);
    assert.equal(packageTest.stdout, "context-relay run --mode auto -- bash -lc 'npm test'\n");
  });

  it("emits Claude Code hook updatedInput for eligible Bash commands", () => {
    const payload = {
      tool_input: {
        command: "pnpm test",
        description: "run tests",
      },
    };
    const result = run(["hook", "claude"], { input: JSON.stringify(payload) });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      "context-relay run --mode auto -- bash -lc 'pnpm test'",
    );
    assert.equal(output.hookSpecificOutput.updatedInput.description, "run tests");
  });

  it("emits Codex hook updatedInput with required allow decision for eligible Bash commands", () => {
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "pnpm test",
      },
    };
    const result = run(["hook", "codex"], { input: JSON.stringify(payload) });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      "context-relay run --mode auto -- bash -lc 'pnpm test'",
    );
  });

  it("leaves sensitive Claude Code hook commands unchanged", () => {
    const result = run(["hook", "claude"], {
      input: JSON.stringify({ tool_input: { command: "gh auth token" } }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  it("installs Claude and Codex hooks without touching real homes", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);

    const result = run(["init", "--all"], {
      env: {
        CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
        CONTEXT_RELAY_CODEX_HOME: codexHome,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const install = JSON.parse(result.stdout);
    assert.equal(install.installed.length, 2);

    const claudeSettings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.deepEqual(claudeSettings.hooks.PreToolUse.at(-1), {
      matcher: "Bash",
      hooks: [{ type: "command", command: "context-relay hook claude" }],
    });
    assert.match(await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8"), /@CONTEXT_RELAY\.md/);
    assert.match(await readFile(path.join(claudeHome, "CONTEXT_RELAY.md"), "utf8"), /Context Relay wraps noisy shell output/);

    assert.match(await readFile(path.join(codexHome, "AGENTS.md"), "utf8"), /Context Relay managed block/);
    assert.match(await readFile(path.join(codexHome, "CONTEXT_RELAY.md"), "utf8"), /Context Relay wraps noisy shell output/);
    const codexHooks = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.deepEqual(codexHooks.hooks.PreToolUse.at(-1), {
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: "context-relay hook codex",
          statusMessage: "Wrapping noisy shell output with Context Relay",
        },
      ],
    });

    const status = run(["status"], {
      env: {
        CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
        CONTEXT_RELAY_CODEX_HOME: codexHome,
      },
    });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.claude.automaticShellWrapping, true);
    assert.equal(statusPayload.codex.automaticShellWrapping, true);
    assert.equal(statusPayload.codex.awarenessLinked, true);

    const uninstall = run(["uninstall", "--all"], {
      env: {
        CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
        CONTEXT_RELAY_CODEX_HOME: codexHome,
      },
    });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.doesNotMatch(await readFile(path.join(claudeHome, "settings.json"), "utf8"), /context-relay hook claude/);
    assert.doesNotMatch(await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8"), /@CONTEXT_RELAY\.md/);
    assert.doesNotMatch(await readFile(path.join(codexHome, "AGENTS.md"), "utf8"), /Context Relay managed block/);
    assert.doesNotMatch(await readFile(path.join(codexHome, "hooks.json"), "utf8"), /context-relay hook codex/);
  });

  it("ships required public packaging assets without local private paths", async () => {
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(packageJson.name, "@archwayai/context-relay");
    assert.equal(packageJson.publishConfig?.access, "public");
    assert.equal(packageJson.bin?.["context-relay"], "bin/context-relay.js");

    const npmCacheDir = await mkdtemp(path.join(os.tmpdir(), "context-relay-npm-cache-"));
    tempDirs.push(npmCacheDir);
    const packResult = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      env: { ...process.env, npm_config_cache: npmCacheDir },
      encoding: "utf8",
    });
    assert.equal(packResult.status, 0, packResult.stderr);
    const [{ files }] = JSON.parse(packResult.stdout);
    const packedFiles = files.map((file) => file.path).sort();

    const requiredFiles = [
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "README.md",
      "docs/architecture.md",
      "docs/agent-integrations.md",
      "docs/eval-results.json",
      "docs/evals.md",
      "docs/limitations.md",
      "docs/releasing.md",
      "docs/security-and-privacy.md",
      "docs/trusted-publishing.md",
      "examples/noisy-test-log.js",
      "fixtures/tool-output.json",
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/docs_issue.md",
      ".github/ISSUE_TEMPLATE/feature_request.md",
      "scripts/quickstart.js",
      "scripts/run-evals.js",
    ];
    for (const file of requiredFiles) {
      assert.ok(packedFiles.includes(file), `${file} missing from npm package`);
    }

    assert.ok(!packedFiles.includes("docs/oss-w0-decision.md"));
    assert.ok(!packedFiles.includes("docs/package-audit.md"));
    assert.ok(!packedFiles.includes(["docs", ["dog", "food-w3.md"].join("")].join("/")));
    assert.ok(!packedFiles.some((file) => file.startsWith(".github/workflows/")));

    const privatePattern = new RegExp(
      [
        ["", "Users", ""].join("/"),
        ["linear", "\\.app"].join(""),
        ["archwayai-", "plugins"].join(""),
        ["example", "\\.com"].join(""),
      ].join("|"),
      "i",
    );
    for (const file of packedFiles) {
      if (!/\.(c?js|json|md|yml|yaml|txt)$/.test(file)) {
        continue;
      }
      const text = await readFile(path.join(packageRoot, file), "utf8");
      assert.doesNotMatch(text, privatePattern, file);
    }
  });
});

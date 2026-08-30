import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, lineCount } from "../lib/policy.js";

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

// Emits a fixture from the environment rather than from argv, so a leak assertion is
// about the OUTPUT path only. A payload passed as `node -e "...<secret>..."` also lands
// in the displayed `command:` line, whose escaping behaviour is a separate, pre-existing
// parity issue with the baseline and would otherwise mask what these tests measure.
const emitPayload = [
  "run",
  "--mode",
  "compress",
  "--",
  process.execPath,
  "-e",
  "process.stdout.write(process.env.CR_TEST_PAYLOAD)",
];

function artifactId(output) {
  const match = output.match(/\[artifact:cr:(cr_[^ ]+)/);
  assert.ok(match, output);
  return match[1];
}

// Everything the local store holds on disk, with artifact bodies decoded. `raw_base64`
// means a plain substring search over the files would miss a leaked secret entirely.
async function storeDiskText() {
  const parts = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const text = await readFile(full, "utf8");
      parts.push(text);
      for (const match of text.matchAll(/"raw_base64":\s*"([^"]*)"/g)) {
        parts.push(Buffer.from(match[1], "base64").toString("utf8"));
      }
    }
  };
  await walk(storeDir);
  return parts.join("\n");
}

async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Reads the store's event log directly so a test can assert on the exact `commandKey`
// recorded for a run, independent of the savings-threshold filtering `gain`/`discover`
// apply before they show a command in their reports.
async function readStoreEvents() {
  let text;
  try {
    text = await readFile(path.join(storeDir, "events.jsonl"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// Keep git away from real user and system configuration so summaries of
// `git status` output do not depend on the machine running the tests.
const isolatedGitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

// Prefer ripgrep, fall back to grep, and let the caller skip when neither exists.
function searchExecutable() {
  for (const candidate of ["rg", "grep"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function searchArgs(executable) {
  return executable === "rg" ? ["--no-heading", "--line-number", "--no-ignore", "TODO", "."] : ["-rn", "TODO", "."];
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, env: { ...process.env, ...isolatedGitEnv }, encoding: "utf8" });
}

async function makeTempGitRepo(remote = "git@github.com:Example-Org/example-repo.git") {
  const repoDir = await makeTempDir("context-relay-repo-");
  git(["init"], repoDir);
  git(["remote", "add", "origin", remote], repoDir);
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
    assert.match(result.stdout, /context-relay gain/);
    assert.match(result.stdout, /context-relay discover/);
    assert.match(result.stdout, /context-relay hook claude\|codex/);
  });

  it("passes small output through", () => {
    const result = run(["run", "--", process.execPath, "-e", "console.log('small')"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "small\n");
  });

  it("counts line boundaries in constant auxiliary space without changing policy thresholds", () => {
    for (const [text, expected] of [
      ["", 0],
      ["one line", 1],
      ["a\nb", 2],
      ["a\r\nb", 2],
      ["a\rb", 1],
      ["a\n", 2],
    ]) {
      assert.equal(lineCount(text), expected, JSON.stringify(text));
    }

    const twentyFiveLines = Array(25).fill("x").join("\n");
    const twentySixLines = `${twentyFiveLines}\nx`;
    assert.equal(classifyCommand(["echo"], twentyFiveLines, 0, "auto").reasonCode, "CR_PASS_SMALL_OUTPUT");
    assert.equal(classifyCommand(["echo"], twentySixLines, 0, "auto").reasonCode, "CR_REVERSIBLE_SUMMARY");

    const largeOutput = "line\n".repeat(1_000_000);
    const originalSplit = String.prototype.split;
    String.prototype.split = function refuseFullOutputSplit(...args) {
      if (String(this) === largeOutput) {
        throw new Error("lineCount allocated through String#split");
      }
      return Reflect.apply(originalSplit, this, args);
    };
    try {
      assert.equal(lineCount(largeOutput), 1_000_001);
    } finally {
      String.prototype.split = originalSplit;
    }
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

  it("summarizes search output with per-file match counts", async (t) => {
    const executable = searchExecutable();
    if (!executable) {
      t.skip("neither rg nor grep is available on this machine");
      return;
    }
    const searchDir = await makeTempDir("context-relay-search-");
    for (const name of ["alpha.ts", "beta.ts", "gamma.ts"]) {
      await writeFile(
        path.join(searchDir, name),
        [1, 2, 3, 4].map((index) => `TODO item ${index} in ${name}`).join("\n").concat("\n"),
      );
    }

    const result = run(["run", "--mode", "compress", "--", executable, ...searchArgs(executable)], {
      cwd: searchDir,
      env: { RIPGREP_CONFIG_PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR compressed output/);
    assert.match(result.stdout, /search_matches: 12/);
    assert.match(result.stdout, /files_with_matches: 3/);
    assert.match(result.stdout, /alpha\.ts: 4 matches \(1:TODO item 1 in alpha\.ts;/);

    const retrieve = run(["retrieve", artifactId(result.stdout), "--grep", "TODO item 4"], { cwd: searchDir });
    assert.equal(retrieve.status, 0);
    assert.match(retrieve.stdout, /TODO item 4 in gamma\.ts/);
  });

  it("summarizes git status output with status code counts", async () => {
    const repoDir = await makeTempGitRepo();
    await writeFile(path.join(repoDir, "staged.ts"), "export const staged = 1;\n");
    git(["add", "staged.ts"], repoDir);
    await writeFile(path.join(repoDir, "untracked.ts"), "export const untracked = 2;\n");

    const result = run(["run", "--mode", "compress", "--", "git", "status", "--short"], {
      cwd: repoDir,
      env: isolatedGitEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR compressed output/);
    assert.match(result.stdout, /git_status_paths: 2/);
    assert.match(result.stdout, /status_counts: .*"A "=1/);
    assert.match(result.stdout, /status_counts: .*"\?\?"=1/);
    assert.match(result.stdout, /- A {2}staged\.ts/);
    assert.match(result.stdout, /- \?\? untracked\.ts/);
  });

  it("summarizes the shipped JSON tool fixture", async () => {
    const fixturePath = path.join(packageRoot, "fixtures", "tool-output.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
      fixturePath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /json_root: object\(1 keys\)/);
    assert.match(result.stdout, new RegExp(`items: array\\(${fixture.items.length}\\)`));
    assert.match(result.stdout, /status_counts: ok=2, warning=1/);

    const retrieve = run(["retrieve", artifactId(result.stdout)]);
    assert.equal(retrieve.status, 0);
    assert.equal(retrieve.stdout, await readFile(fixturePath, "utf8"));
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

  it("distinguishes malformed artifact JSON from a missing artifact", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    const artifactPath = path.join(storeDir, "artifacts", `${id}.json`);
    await writeFile(artifactPath, "{ malformed json\n");

    const retrieve = run(["retrieve", id]);
    assert.notEqual(retrieve.status, 0);
    assert.equal(retrieve.stdout, "");
    assert.match(retrieve.stderr, /CR_RETRIEVE_CORRUPT_JSON/);
    assert.doesNotMatch(retrieve.stderr, /CR_RETRIEVE_MISSING/);
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

  it("does not block bare unlabeled opaque strings", () => {
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
    assert.match(result.stdout, /CR compressed output/);
    assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/);

    const retrieve = run(["retrieve", artifactId(result.stdout)]);
    assert.equal(retrieve.status, 0);
    assert.match(retrieve.stdout, /abcdefghijklmnopqrstuvwxyz123456/);
  });

  it("blocks standalone JWT-like child output and keeps redacted evidence", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNvbnRleHRSZWxheSJ9.GHvqPZf8JW7V1DCxUX7wnp80lVj0lF83VCyA";
    const result = run(["run", "--mode", "compress", "--", process.execPath, "-e", `console.log('${jwt}')`]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.doesNotMatch(result.stdout, new RegExp(jwt));
    assert.match(result.stdout, /artifact:cr:/);

    const retrieve = run(["retrieve", artifactId(result.stdout)]);
    assert.equal(retrieve.status, 0);
    assert.match(retrieve.stdout, /\[REDACTED_SECRET\]/);
    assert.doesNotMatch(retrieve.stdout, new RegExp(jwt));
    assert.match(retrieve.stderr, /CR_NOTICE_REDACTED/);
  });

  it("relays real git log output instead of blocking it", async () => {
    const repoDir = await makeTempGitRepo();
    for (const message of ["first", "second"]) {
      const commit = spawnSync(
        "git",
        [
          "-c",
          "user.name=CR Test",
          "-c",
          "user.email=cr-test@invalid.local",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-m",
          message,
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      assert.equal(commit.status, 0, commit.stderr);
    }

    const result = run(["run", "--mode", "compress", "--", "git", "log", "-2"], { cwd: repoDir });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR compressed output/);
    assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/);
    assert.match(result.stdout, /raw: \[artifact:cr:/);

    const retrieve = run(["retrieve", artifactId(result.stdout)], { cwd: repoDir });
    assert.equal(retrieve.status, 0);
    assert.match(retrieve.stdout, /commit [0-9a-f]{40}/);
  });

  it("does not treat UUIDs as secrets", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      `for(let i=0;i<30;i++)console.log('id: ${uuid}')`,
      "--",
      uuid,
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR compressed output/);
    assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/);
    // Regression: the displayed command line must not mangle the UUID argument.
    assert.match(result.stdout, new RegExp(`command: .*${uuid}`));

    const retrieve = run(["retrieve", artifactId(result.stdout)]);
    assert.equal(retrieve.status, 0);
    assert.ok(retrieve.stdout.includes(uuid));
  });

  it("does not treat base64 blobs as secrets", () => {
    const blob = Buffer.from("context relay base64 evidence payload for fixtures").toString("base64");
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      `const b=${JSON.stringify(blob)};for(let i=0;i<30;i++)console.log('blob: '+b)`,
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /CR compressed output/);
    assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/);

    const retrieve = run(["retrieve", artifactId(result.stdout)]);
    assert.equal(retrieve.status, 0);
    assert.ok(retrieve.stdout.includes(blob));
  });

  it("stores redacted evidence for real-shaped keys", () => {
    // Built by concatenation so the literals never look like live credentials.
    const fixtures = ["ghp_" + "A".repeat(36), "AKIA" + "IOSFODNN7EXAMPLE", "sk-" + "a1B2".repeat(6)];
    for (const fixture of fixtures) {
      const result = run([
        "run",
        "--mode",
        "compress",
        "--",
        process.execPath,
        "-e",
        `console.log('value ' + ${JSON.stringify(fixture)})`,
      ]);
      assert.equal(result.status, 0, fixture);
      assert.match(result.stdout, /CR_BLOCK_SECRET/, fixture);
      assert.ok(!result.stdout.includes(fixture), fixture);
      assert.match(result.stdout, /raw: \[artifact:cr:/, fixture);

      const id = artifactId(result.stdout);
      const retrieve = run(["retrieve", id]);
      assert.equal(retrieve.status, 0, fixture);
      assert.match(retrieve.stdout, /\[REDACTED_SECRET\]/, fixture);
      assert.ok(!retrieve.stdout.includes(fixture), fixture);
      assert.match(retrieve.stderr, /CR_NOTICE_REDACTED/, fixture);

      const inspect = run(["inspect", id]);
      assert.equal(inspect.status, 0, fixture);
      const metadata = JSON.parse(inspect.stdout);
      assert.equal(metadata.content.redacted, true, fixture);
      assert.equal(metadata.policy.redaction_policy, "standard-secret-redaction", fixture);
    }
  });

  // Round-2 regression guards. The round-1 pattern set missed every shape below:
  // `\bsecret\b` cannot match inside AWS_SECRET_ACCESS_KEY because `_` is a word
  // character, and `\s*[:=]` cannot cross the closing quote in `"password": "..."`.
  // A suite that only ever tested a bare `api_key=` label proved nothing about these.
  const labeledSecretCases = [
    { name: "AWS_SECRET_ACCESS_KEY", secret: "wJalrXUtnFEMI" + "K7MDENGbPxRfiCYEXAMPLEKEY", line: (s) => `AWS_SECRET_ACCESS_KEY=${s}` },
    { name: "DB_PASSWORD", secret: "hunter2" + "hunter2hunter2hunter2", line: (s) => `DB_PASSWORD=${s}` },
    { name: "GITHUB_TOKEN", secret: "abcdef1234" + "567890abcdefFEDCBA", line: (s) => `GITHUB_TOKEN=${s}` },
    { name: "STRIPE_SECRET_KEY", secret: "rk_liv" + "e_XyZ123abc456QQ", line: (s) => `STRIPE_SECRET_KEY=${s}` },
    { name: "json password", secret: "correcthorse" + "batterystaple99", line: (s) => `{"password": "${s}"}` },
    { name: "authorization bearer", secret: "ya29.AbCdEf" + "123456789xyzQRS", line: (s) => `Authorization: Bearer ${s}` },
  ];

  for (const testCase of labeledSecretCases) {
    it(`blocks and redacts labeled secrets: ${testCase.name}`, async () => {
      const line = testCase.line(testCase.secret);
      const result = run([
        "run",
        "--mode",
        "compress",
        "--",
        process.execPath,
        "-e",
        `console.log(${JSON.stringify(line)})`,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /CR_BLOCK_SECRET/, `not blocked: ${line}`);
      assert.ok(!result.stdout.includes(testCase.secret), `secret leaked to stdout: ${line}`);
      assert.ok(!result.stderr.includes(testCase.secret), `secret leaked to stderr: ${line}`);

      const disk = await storeDiskText();
      assert.ok(!disk.includes(testCase.secret), `secret leaked to disk: ${line}`);
    });
  }

  it("fully redacts quoted multi-word secret values", async () => {
    const passphrase = "correct horse " + "battery staple";
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      `console.log("password='" + ${JSON.stringify(passphrase)} + "'")`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    // The round-1 value capture stopped at the first space, leaving
    // "[REDACTED_SECRET] horse battery staple'" as residue on stdout and on disk.
    for (const word of ["correct", "horse", "battery", "staple"]) {
      assert.ok(!result.stdout.includes(word), `passphrase residue on stdout: ${word}`);
    }
    const disk = await storeDiskText();
    for (const word of ["correct", "horse", "battery", "staple"]) {
      assert.ok(!disk.includes(word), `passphrase residue on disk: ${word}`);
    }
  });

  it("redacts non-digest hex secrets in the stored artifact", async () => {
    // 48 hex chars: not an md5/sha1/sha256 digest length, so nothing legitimate
    // depends on it surviving. Round 1 exempted any hex run of 32+ chars.
    const hmac = "a3f1".repeat(12);
    assert.equal(hmac.length, 48);
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      `console.log("JWT_SIGNING_SECRET=" + ${JSON.stringify(hmac)})`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(hmac), "hex secret leaked to stdout");
    const disk = await storeDiskText();
    assert.ok(!disk.includes(hmac), "hex secret leaked to disk");
  });

  it("redacts hex-shaped secrets passed as command arguments", async () => {
    const hmac = "b7e2".repeat(12);
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      ...noisyNodeCommand(),
      "--",
      "--payload",
      hmac,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR compressed output/);
    assert.ok(!result.stdout.includes(hmac), "hex arg leaked into the envelope command line");
    const disk = await storeDiskText();
    assert.ok(!disk.includes(hmac), "hex arg leaked into events.jsonl or artifact source.command");
  });

  it("keeps 40-hex git shas intact in displayed commands", () => {
    const sha = "3f2b1c9d4e5a6b7c8d9e0f1a2b3c4d5e6f708192";
    assert.equal(sha.length, 40);
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand(), "--", "show", sha]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(sha), "git sha was mangled in the displayed command");
  });

  it("blocked envelopes relay no content from the blocked output", () => {
    // The canary is assembled inside the child so it never appears in the command
    // text. The envelope's `command:` line legitimately echoes the command (existing
    // tests depend on that); what must not cross is a line of the child's *output*.
    const marker = "CANARYLINEUNIQUE42";
    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      `console.log(String.fromCharCode(67,65,78,65,82,89) + "LINE" + "UNIQUE" + 42); console.log("api_key=" + "abcdefghijklmnop123456")`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    // Round 1 added summarize() highlights to the blocked envelope, so lines from
    // blocked output reached agent context. Only counts and the marker may cross.
    assert.ok(!result.stdout.includes(marker), "blocked envelope relayed a content line");
    assert.doesNotMatch(result.stdout, /^highlights:/m);
    assert.match(result.stdout, /raw_lines: \d+/);
  });

  it("anchors prefixed key shapes inside longer tokens", async () => {
    const { hasSecret } = await import("../lib/policy.js");
    assert.equal(hasSecret("payload QUJD" + "ghp_" + "A".repeat(36)), true, "ghp_ embedded in a longer token");
    assert.equal(hasSecret("key=AKIA" + "IOSFODNN7EXAMPLE" + "XY"), true, "AWS key with trailing alnum");
    assert.equal(hasSecret("blob" + "glpat-" + "A1b2C3d4E5f6G7h8I9j0"), true, "glpat- embedded");
  });

  it("placeholder invariant: the redaction placeholder never re-triggers detection", async () => {
    const { hasSecret, REDACTION_PLACEHOLDER } = await import("../lib/policy.js");
    // The guard is the closing `]`, not the underscore: no label pattern can cross a
    // bracket to reach the `:`/`=` it needs. A rename to a bracketless token would
    // make the placeholder self-detecting and fail the storability gate on every
    // block. This test exists so that rename is caught.
    assert.equal(hasSecret(REDACTION_PLACEHOLDER), false);
    assert.equal(hasSecret(`${REDACTION_PLACEHOLDER}=value`), false);
    assert.equal(hasSecret(`${REDACTION_PLACEHOLDER}: value`), false);
    // A label still detects a real value...
    assert.equal(hasSecret("token=abcdefghijklmnop123456"), true);
    // ...but a value that IS the placeholder is already redacted, and round 3's
    // bracketed-placeholder exemption (`[FILTERED]`-style) covers it by construction.
    // This assertion was `true` in round 2; the flip is deliberate and harmless,
    // because the storability gate only ever sees whole matches replaced by the
    // placeholder, never a label left standing in front of one.
    assert.equal(hasSecret(`token=${REDACTION_PLACEHOLDER}`), false);
  });

  it("redaction invariant: redacted text never re-triggers detection", async () => {
    const { hasSecret, redactSecrets } = await import("../lib/policy.js");
    const secrets = [
      "api_key=abcdefghijklmnop123456",
      "ghp_" + "A".repeat(36),
      "AKIA" + "IOSFODNN7EXAMPLE",
      "sk-" + "a1B2".repeat(6),
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNvbnRleHRSZWxheSJ9.GHvqPZf8JW7V1DCxUX7wnp80lVj0lF83VCyA",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQfakebodyMIIEvQfakebodyMIIEvQfakebody\n-----END PRIVATE KEY-----",
    ];
    for (const secret of secrets) {
      assert.equal(hasSecret(secret), true, `expected detection for ${secret.slice(0, 24)}`);
      assert.equal(hasSecret(redactSecrets(secret)), false, `gate failed for ${secret.slice(0, 24)}`);
    }

    const safe = [
      "commit 3f2b1c9d4e5a6b7c8d9e0f1a2b3c4d5e6f708192",
      "id: 550e8400-e29b-41d4-a716-446655440000",
      "blob: " + Buffer.from("context relay base64 evidence payload for fixtures").toString("base64"),
    ];
    for (const line of safe) {
      assert.equal(hasSecret(line), false, `false positive for ${line.slice(0, 24)}`);
    }
  });

  // Round-3 regression guards (B1). Widening the label pattern in round 2 made it
  // fire on values that are demonstrably not credentials: CI template references,
  // masks, filtered-log markers and documentation placeholders. Each of these was
  // relayed by the pre-change baseline and destroyed by the round-2 pattern.
  const maskedValueCases = [
    { name: "github actions secrets template", line: "AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}" },
    { name: "asterisk mask", line: "password=********" },
    { name: "rails filtered log", line: "Using token: [FILTERED]" },
    { name: "doc placeholder bearer", line: "Authorization: Bearer <redacted>" },
    { name: "helm empty value", line: 'password: ""' },
    { name: "readme placeholder", line: "API_KEY=<your-api-key>" },
    // The shapes that made `git log` in this repo block on itself: a label with an
    // empty value, a quoted ellipsis, and an auth scheme word followed by prose.
    { name: "empty env assignment list", line: "AWS_SECRET_ACCESS_KEY=, DB_PASSWORD=, GITHUB_TOKEN=," },
    { name: "quoted ellipsis", line: '"password": "..."' },
    { name: "prose after auth scheme", line: "and Authorization: Bearer are all detected, while" },
    { name: "yaml null value", line: "password: null" },
    // Round-4 parity shapes: tool output that names a credential without printing one.
    { name: "terraform sensitive marker", line: "password = (sensitive value)" },
    { name: "kubectl byte count", line: "password:  16 bytes" },
    { name: "env presence marker", line: "AWS_SECRET_ACCESS_KEY=(set)" },
    { name: "undefined value", line: "API_KEY=undefined" },
    { name: "not applicable value", line: "client_secret: N/A" },
  ];

  for (const testCase of maskedValueCases) {
    it(`relays masked and placeholder values instead of blocking: ${testCase.name}`, () => {
      const result = run([
        "run",
        "--mode",
        "compress",
        "--",
        process.execPath,
        "-e",
        `console.log(${JSON.stringify(testCase.line)})`,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/, `blocked a non-secret: ${testCase.line}`);
      assert.match(result.stdout, /CR compressed output/);

      const retrieve = run(["retrieve", artifactId(result.stdout)]);
      assert.equal(retrieve.status, 0);
      assert.ok(retrieve.stdout.includes(testCase.line), `evidence destroyed: ${testCase.line}`);
    });
  }

  it("relays git log whose commit messages describe secret label shapes", async () => {
    // The canonical failure. This repo's own changelog documents the label shapes the
    // detector looks for, so a pattern that matches its own description of itself
    // destroys `git log` in the very repo that ships it. Round 1 did this via the
    // entropy rule; round 2 did it via the label rule.
    const repoDir = await makeTempGitRepo();
    const message = [
      "fix: close the labeled-secret detection regression from round 1",
      "",
      "F1/F2 Match a credential keyword as a whole *name part* of its label, so",
      "  AWS_SECRET_ACCESS_KEY=, DB_PASSWORD=, GITHUB_TOKEN=, STRIPE_SECRET_KEY=,",
      '  "password": "...", and Authorization: Bearer are all detected, while',
      "  accounting labels (tokens=0, raw_estimated_tokens: 5231) stay unblocked.",
    ].join("\n");
    // Three commits so `--mode auto` lands on the same compressing branch that the
    // real `git log -5` takes; the failure being pinned is the block, not the mode.
    for (let i = 0; i < 3; i++) {
      const commit = spawnSync(
        "git",
        [
          "-c",
          "user.name=CR Test",
          "-c",
          "user.email=cr-test@invalid.local",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-m",
          message,
        ],
        { cwd: repoDir, encoding: "utf8" },
      );
      assert.equal(commit.status, 0, commit.stderr);
    }

    const result = run(["run", "--mode", "auto", "--", "git", "log", "-5"], { cwd: repoDir });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/, result.stdout);

    const retrieve = run(["retrieve", artifactId(result.stdout)], { cwd: repoDir });
    assert.equal(retrieve.status, 0);
    assert.match(retrieve.stdout, /commit [0-9a-f]{40}/, "40-hex sha not retrievable");
  });

  // Round-3 regression guards (B2). The round-2 value alternation required a closing
  // quote and the catch-all could not start at a quote character, so an unterminated
  // quote was the single shape where this branch was weaker than the baseline.
  const unterminatedQuoteCases = [
    { name: "double quote", secret: "hunter2abc" + "defghijkl", line: (s) => `api_key="${s}` },
    { name: "single quote", secret: "hunter2abc" + "defghijkl", line: (s) => `PASSWORD='${s}` },
  ];

  for (const testCase of unterminatedQuoteCases) {
    it(`blocks labeled secrets with an unterminated ${testCase.name}`, async () => {
      const line = testCase.line(testCase.secret);
      const result = run([
        "run",
        "--mode",
        "compress",
        "--",
        process.execPath,
        "-e",
        `console.log(${JSON.stringify(line)})`,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /CR_BLOCK_SECRET/, `not blocked: ${line}`);
      assert.ok(!result.stdout.includes(testCase.secret), `secret leaked to stdout: ${line}`);
      assert.ok(!result.stderr.includes(testCase.secret), `secret leaked to stderr: ${line}`);

      const disk = await storeDiskText();
      assert.ok(!disk.includes(testCase.secret), `secret leaked to disk: ${line}`);
    });
  }

  // Round-4 regression guards (C1). The round-3 value-plausibility guard requires an
  // alphanumeric in the value, and a YAML block-scalar introducer (`|`, `>`, `|-`) has
  // none — so a credential written across the following indented lines relayed in full,
  // where both the pre-change baseline and the round-2 commit blocked it. Block scalars
  // are how multi-line secrets (SSH keys, certs, PEM bodies) are written in helm values,
  // k8s manifests and workflow YAML, which is exactly the "browse CI configs" surface.
  const continuationValueCases = [
    { name: "literal block scalar", intro: "password: |" },
    { name: "folded block scalar", intro: "password: >" },
    { name: "strip-chomped block scalar", intro: "password: |-" },
    { name: "indented block scalar", intro: "password: |2-" },
    { name: "keep-chomped folded scalar", intro: "client-secret: >+" },
    { name: "backslash continuation", intro: "PASSWORD=\\" },
  ];

  for (const testCase of continuationValueCases) {
    it(`blocks credentials on a continuation line: ${testCase.name}`, async () => {
      const secret = "hunter2" + "realvalue";
      const text = `${testCase.intro}\n  ${secret}\n`;
      const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /CR_BLOCK_SECRET/, `not blocked: ${testCase.intro}`);
      assert.ok(!result.stdout.includes(secret), `secret leaked to stdout: ${testCase.intro}`);
      assert.ok(!result.stderr.includes(secret), `secret leaked to stderr: ${testCase.intro}`);

      const disk = await storeDiskText();
      assert.ok(!disk.includes(secret), `secret leaked to disk: ${testCase.intro}`);
    });
  }

  it("scrubs a PEM body carried inside a block scalar", async () => {
    const body = "MIIEvQfakebody" + "PrivateKeyBytes";
    const text = [
      "tls.key: |",
      "  -----BEGIN RSA PRIVATE KEY-----",
      `  ${body}`,
      "  -----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(body), "key body leaked to stdout");
    const disk = await storeDiskText();
    assert.ok(!disk.includes(body), "key body leaked to disk");
  });

  // ---------------------------------------------------------------------------
  // Round-5 regression guards.
  // ---------------------------------------------------------------------------

  // F1. `LABEL_NAME` opened with `(?:^|[^A-Za-z0-9_.-])`, which CONSUMED the delimiter
  // in front of the label. A global replace resumes at `lastIndex`, so once a match had
  // eaten the newline that ended its block, the next label had no delimiter left and
  // `^` could not stand in (`gi`, never `m`). The second credential relayed whole, as
  // residue that is not secret-shaped — it passed the storability gate and reached disk.
  it("blocks both credentials when two block scalars are adjacent", async () => {
    const first = "A1REAL" + "SECRETONE9";
    const second = "B2REAL" + "SECRETTWO7";
    const text = `password: |\n  ${first}\napi_key: |\n  ${second}\n`;
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    const disk = await storeDiskText();
    for (const fixture of [first, second]) {
      assert.ok(!result.stdout.includes(fixture), `leaked to stdout: ${fixture}`);
      assert.ok(!result.stderr.includes(fixture), `leaked to stderr: ${fixture}`);
      assert.ok(!disk.includes(fixture), `leaked to disk: ${fixture}`);
    }
  });

  // The single-line form of the same adjacency. This one already worked before F1 and
  // is here so the lookbehind rewrite cannot regress it.
  it("blocks both credentials when two labeled assignments are adjacent", async () => {
    const first = "AAAREAL" + "111222333";
    const second = "BBBREAL" + "444555666";
    const text = `password=${first}\napi_key=${second}\n`;
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    const disk = await storeDiskText();
    for (const fixture of [first, second]) {
      assert.ok(!result.stdout.includes(fixture), `leaked to stdout: ${fixture}`);
      assert.ok(!disk.includes(fixture), `leaked to disk: ${fixture}`);
    }
  });

  // F1, second consequence: the consumed delimiter was the newline ENDING the previous
  // line, so span redaction merged that line into the placeholder and the line pass then
  // destroyed both. The preceding line holds no secret and must survive as evidence.
  it("preserves the line before a labeled secret", async () => {
    const context = "keep this context line";
    const secret = "abcdefghij" + "klmnop123456";
    const text = `${context}\napi_key=${secret}\ntrailing context line\n`;
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(secret), "secret leaked to stdout");

    const retrieve = run(["retrieve", artifactId(result.stdout)]);
    assert.equal(retrieve.status, 0);
    assert.ok(retrieve.stdout.includes(context), `collateral damage: ${retrieve.stdout}`);
    assert.ok(retrieve.stdout.includes("trailing context line"), retrieve.stdout);
    assert.ok(!retrieve.stdout.includes(secret), "secret leaked into the artifact");
  });

  // F2. YAML permits blank lines at the head of a block scalar, and the introducer
  // branch went straight from `\r?\n` to `[ \t]+`, so the credential relayed in full.
  for (const introducer of ["|", ">"]) {
    it(`blocks a block scalar with a blank line after the introducer: ${introducer}`, async () => {
      const secret = "hunter2" + "realvalue";
      const text = `password: ${introducer}\n\n  ${secret}\n`;
      const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /CR_BLOCK_SECRET/, `not blocked: ${introducer}`);
      assert.ok(!result.stdout.includes(secret), `leaked to stdout: ${introducer}`);
      const disk = await storeDiskText();
      assert.ok(!disk.includes(secret), `leaked to disk: ${introducer}`);
    });
  }

  // F2 boundary: the blank-line tolerance must not let an EMPTY block scalar reach
  // across into the next unindented key.
  it("does not extend an empty block scalar into the following key", async () => {
    const { hasSecret, redactSecrets } = await import("../lib/policy.js");
    const text = "password: |\n\nunindented: value\n";
    assert.equal(hasSecret(text), false, "empty block scalar matched");
    assert.equal(redactSecrets(text), text, "empty block scalar consumed the next key");
  });

  // F3/F4 relay guards, checked end to end alongside the round-3/4 masked values above.
  const compactPlaceholderCases = [
    { name: "compact json null", line: '{"password": null}' },
    { name: "compact json access token null", line: '{"access_token": null}' },
    { name: "compact json doc placeholder", line: '{"api_key": "<value>"}' },
    { name: "bracket placeholder in a json array", line: '{"tokens": ["[FILTERED]"]}' },
  ];

  for (const testCase of compactPlaceholderCases) {
    it(`relays compact placeholder literals instead of blocking: ${testCase.name}`, () => {
      const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: `${testCase.line}\n` } });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /CR_BLOCK_SECRET/, `blocked a non-secret: ${testCase.line}`);
      assert.match(result.stdout, /CR compressed output/);

      const retrieve = run(["retrieve", artifactId(result.stdout)]);
      assert.equal(retrieve.status, 0);
      assert.ok(retrieve.stdout.includes(testCase.line), `evidence destroyed: ${testCase.line}`);
    });
  }

  // F4. A wrapper is only a documentation placeholder when its innards look like prose.
  // 16+ characters carrying both a digit and a letter is a credential that happens to be
  // wrapped, and exempting it relayed the credential in full.
  it("narrows the wrapper-placeholder exemption to implausible innards", async () => {
    const { hasSecret, REDACTION_PLACEHOLDER } = await import("../lib/policy.js");
    const wrapped = "hunter2" + "realvalue123";
    assert.equal(hasSecret(`api_key=<${wrapped}>`), true, "angle-wrapped credential exempted");
    assert.equal(hasSecret(`api_key=[${wrapped}]`), true, "bracket-wrapped credential exempted");
    // Real documentation placeholders stay exempt: short, or no digit, or both.
    assert.equal(hasSecret("API_KEY=<your-api-key>"), false);
    assert.equal(hasSecret("Using token: [FILTERED]"), false);
    assert.equal(hasSecret("Authorization: Bearer <redacted>"), false);
    // And the CI template alternative is deliberately untouched.
    assert.equal(hasSecret("AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}"), false);
    // THE TRAP: the module's own placeholder is a bracket wrapper. `REDACTED_SECRET` is
    // 15 characters with no digit, so it stays under both thresholds. If the narrowing
    // ever caught it, the storability gate would fail on every block and every blocked
    // artifact would be destroyed instead of stored.
    assert.equal(REDACTION_PLACEHOLDER, "[REDACTED_SECRET]");
    assert.equal(hasSecret(REDACTION_PLACEHOLDER), false);
    assert.equal(hasSecret(`token=${REDACTION_PLACEHOLDER}`), false);
  });

  it("blocks a wrapped credential end to end", async () => {
    const wrapped = "hunter2" + "realvalue123";
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: `api_key=<${wrapped}>\n` } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(wrapped), "wrapped credential leaked to stdout");
    const disk = await storeDiskText();
    assert.ok(!disk.includes(wrapped), "wrapped credential leaked to disk");
  });

  // F5. Whole-line destruction only removes residue that lands on the matched line. A
  // value can legitimately continue on the FOLLOWING lines, so the blocked path also
  // destroys the lines that belong to a destroyed line. The two rules are indentation
  // and shell continuation, and both must read the ORIGINAL line, not the redacted one.
  it("destroys an orphaned indented body but keeps sibling keys", async () => {
    const { redactSecretLines } = await import("../lib/policy.js");
    const orphan = "ORPHANBODY" + "VALUE9";
    const secret = "abcdefghij" + "123456";
    const text = `database:\n  api_key: ${secret}\n    ${orphan}\n  host: example.com\nafter\n`;
    const redacted = redactSecretLines(text);
    assert.ok(!redacted.includes(orphan), `orphan survived: ${redacted}`);
    assert.ok(!redacted.includes(secret), `secret survived: ${redacted}`);
    // Precision: a sibling at equal indent is not part of the value.
    assert.ok(redacted.includes("  host: example.com"), `sibling destroyed: ${redacted}`);
    assert.ok(redacted.includes("after"), `unrelated line destroyed: ${redacted}`);
    assert.ok(redacted.includes("database:"), `parent key destroyed: ${redacted}`);
  });

  it("keeps a sibling key when a same-line secret is destroyed", async () => {
    const { redactSecretLines } = await import("../lib/policy.js");
    const secret = "hunter2" + "realvalue";
    const redacted = redactSecretLines(`database:\n  password: ${secret}\n  host: example.com\n`);
    assert.ok(!redacted.includes(secret), redacted);
    assert.ok(redacted.includes("  host: example.com"), `sibling destroyed: ${redacted}`);
  });

  it("leaves no residue below an orphaned indented body on disk", async () => {
    const orphan = "ORPHANBODY" + "VALUE9";
    const secret = "abcdefghij" + "123456";
    const text = `database:\n  api_key: ${secret}\n    ${orphan}\n  host: example.com\n`;
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(orphan), "orphan leaked to stdout");
    const disk = await storeDiskText();
    assert.ok(!disk.includes(orphan), "orphan leaked to disk");
    assert.ok(!disk.includes(secret), "secret leaked to disk");
  });

  // A blank line inside a block-scalar body ends the span pattern's trailing
  // repetition, so everything after it is orphaned. A blank line must therefore NOT end
  // the indentation cascade — it carries no content of its own and the block continues.
  it("destroys a block body orphaned by a blank line inside it", async () => {
    const first = "A1REAL" + "SECRETONE";
    const second = "B2REAL" + "SECRETTWO";
    const text = `password: |\n  ${first}\n\n  ${second}\nnext: value\n`;
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    const disk = await storeDiskText();
    for (const fixture of [first, second]) {
      assert.ok(!result.stdout.includes(fixture), `leaked to stdout: ${fixture}`);
      assert.ok(!disk.includes(fixture), `leaked to disk: ${fixture}`);
    }
  });

  it("leaves no residue on a backslash-continued credential", async () => {
    const secret = "hunter2" + "value";
    const residue = "MORERESIDUE" + "42";
    const text = `PASSWORD=${secret}\\\n  ${residue}\nafter\n`;
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(residue), "continuation leaked to stdout");
    const disk = await storeDiskText();
    assert.ok(!disk.includes(residue), "continuation leaked to disk");
    assert.ok(!disk.includes(secret), "secret leaked to disk");
  });

  // Round-4 regression guard (C2). `redactSecretLines` ran the line pass BEFORE the
  // span pass, so a quoted value spanning a newline was sliced apart: the first line
  // was destroyed and the tail survived as residue that no longer matched anything.
  // The gate (`!hasSecret(redactedText)`) then passed it, and the tail landed on disk
  // inside an artifact stamped `redacted: true`.
  it("leaves no tail residue when a quoted secret value spans lines", async () => {
    const head = "topsecret" + "line1";
    const tail = "TAILLINE2" + "continues";
    const text = `before\npassword: "${head}\n${tail}"\nafter\n`;
    const result = run(emitPayload, { env: { CR_TEST_PAYLOAD: text } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(head), "head leaked to stdout");
    assert.ok(!result.stdout.includes(tail), "tail leaked to stdout");

    const disk = await storeDiskText();
    assert.ok(!disk.includes(head), "head leaked to disk");
    assert.ok(!disk.includes(tail), "tail leaked to disk");
  });

  it("redaction ordering: the span pass runs before the line pass", async () => {
    const { hasSecret, redactSecretLines } = await import("../lib/policy.js");
    const head = "topsecret" + "line1";
    const tail = "TAILLINE2" + "continues";
    const multiLineQuoted = `before\npassword: "${head}\n${tail}"\nafter`;
    const redacted = redactSecretLines(multiLineQuoted);
    assert.ok(!redacted.includes(head), redacted);
    assert.ok(!redacted.includes(tail), redacted);
    assert.equal(hasSecret(redacted), false);

    // The line pass must survive the reorder: an under-consumed span leaves residue on
    // its own line, and destroying the whole line is what removes that class. Round 3
    // got this from line-first ordering; it now comes from the placeholder predicate.
    const unquoted = redactSecretLines("password=correct horse battery staple");
    for (const word of ["correct", "horse", "battery", "staple"]) {
      assert.ok(!unquoted.includes(word), `residue survived the reorder: ${word}`);
    }
  });

  it("keeps digest values readable when they carry a short key prefix", async () => {
    // `sha=<40 hex>` was destroyed because `=` is inside the opaque-token class, so the
    // matched run was not pure hex. Over-redaction only ever hits blocked artifacts, but
    // it costs the evidence the blocked path exists to preserve.
    const { redactSecrets } = await import("../lib/policy.js");
    const sha = "3f2b1c9d4e5a6b7c8d9e0f1a2b3c4d5e6f708192";
    assert.equal(redactSecrets(`sha=${sha}`), `sha=${sha}`);
    assert.equal(redactSecrets(`commit ${sha}`), `commit ${sha}`);
    // A non-digest-length hex run is still scrubbed, prefix or not.
    const hmac = "a3f1".repeat(12);
    assert.ok(!redactSecrets(`sig=${hmac}`).includes(hmac));
  });

  it("still blocks real-shaped values after the placeholder guard", async () => {
    // The B1 guard must cost zero detection coverage. A plausible 40-character value
    // on the same labels that carry the placeholders above must still block.
    const { hasSecret } = await import("../lib/policy.js");
    const secret = "wJalrXUtnFEMI" + "K7MDENGbPxRfiCYEXAMPLEKEY01";
    assert.equal(secret.length, 40);
    for (const line of [
      `AWS_SECRET_ACCESS_KEY=${secret}`,
      `AWS_SECRET_ACCESS_KEY: ${secret}`,
      `password=${secret}`,
      `Using token: ${secret}`,
      `Authorization: Bearer ${secret}`,
      `API_KEY=${secret}`,
      `password: "${secret}"`,
    ]) {
      assert.equal(hasSecret(line), true, `guard over-exempted a real value: ${line}`);
    }

    const result = run([
      "run",
      "--mode",
      "compress",
      "--",
      process.execPath,
      "-e",
      `console.log("AWS_SECRET_ACCESS_KEY=" + ${JSON.stringify(secret)})`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!result.stdout.includes(secret), "secret leaked to stdout");
    const disk = await storeDiskText();
    assert.ok(!disk.includes(secret), "secret leaked to disk");
  });

  it("preserves child exit code and warns when the store is unavailable", async () => {
    const blocker = path.join(storeDir, "not-a-dir");
    await writeFile(blocker, "x");
    const broken = path.join(blocker, "sub");
    const env = { CONTEXT_RELAY_STORE_DIR: broken };

    const noisy = run(["run", "--mode", "compress", "--", process.execPath, "examples/noisy-test-log.js"], {
      cwd: packageRoot,
      env,
    });
    assert.equal(noisy.status, 0);
    assert.match(noisy.stdout, /status=warning/);
    assert.doesNotMatch(noisy.stdout, /CR compressed output/);
    assert.match(noisy.stderr, /CR_STORE_FAILED/);
    assert.match(noisy.stderr, /without compression/);

    const failing = run(
      ["run", "--mode", "compress", "--", process.execPath, "-e", "console.log('x'.repeat(2000)); process.exit(7)"],
      { env },
    );
    assert.equal(failing.status, 7);
    assert.match(failing.stderr, /CR_STORE_FAILED/);

    const small = run(["run", "--", process.execPath, "-e", "console.log('small')"], { env });
    assert.equal(small.status, 0);
    assert.equal(small.stdout, "small\n");
    assert.match(small.stderr, /CR_STORE_FAILED/);

    const blocked = run(
      ["run", "--mode", "compress", "--", process.execPath, "-e", "console.log('api_key=abcdefghijklmnop123456')"],
      { env },
    );
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /CR_BLOCK_SECRET/);
    assert.ok(!blocked.stdout.includes("abcdefghijklmnop123456"));
    assert.ok(!blocked.stderr.includes("abcdefghijklmnop123456"));
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
    const compressed = run(["run", "--mode", "compress", "--", ...noisyNodeCommand(120)]);
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
    assert.ok(stats.gross_saved_bytes > 0);
    assert.ok(stats.net_saved_bytes >= 0);
    assert.ok(stats.gross_efficiency_percent > 0);
    assert.ok((await readFile(path.join(storeDir, "events.jsonl"), "utf8")).includes("compressed"));
  });

  it("reports rate metrics without dividing by zero runs", () => {
    const result = run(["stats"]);
    assert.equal(result.status, 0);
    const stats = JSON.parse(result.stdout);
    assert.equal(stats.runs, 0);
    assert.equal(stats.retrieval_rate, 0);
    assert.equal(stats.blocked_rate, 0);
    assert.equal(stats.fallback_rate, 0);
    assert.equal(stats.compression_savings_pct, 0);
  });

  it("reports retrieval, blocked, and compression savings metrics", () => {
    run(["run", "--", process.execPath, "-e", "console.log('small')"]);
    const compressed = run(["run", "--mode", "compress", "--", ...noisyNodeCommand(120)]);
    run(["run", "--mode", "compress", "--", process.execPath, "-e", "console.log('api_key=abcdefghijklmnop123456')"]);
    run(["retrieve", artifactId(compressed.stdout), "--grep", "TODO item 7"]);

    const stats = JSON.parse(run(["stats"]).stdout);
    assert.equal(stats.runs, 3);
    assert.equal(stats.blocked, 1);
    assert.equal(stats.retrieval_rate, 0.333);
    assert.equal(stats.blocked_rate, 0.333);
    assert.equal(stats.fallback_rate, 0);
    assert.equal(stats.compression_savings_pct, stats.gross_efficiency_percent);
    assert.ok(stats.compression_savings_pct > 0);

    const gain = run(["gain"]);
    assert.equal(gain.status, 0, gain.stderr);
    assert.match(gain.stdout, /compression savings: [\d.]+% \(alias of gross efficiency\)/);
    assert.match(gain.stdout, /rates per run: retrieval 0\.333, blocked 0\.333, fallback 0/);
  });

  it("counts store failures as fallbacks", async () => {
    // A file where the artifacts directory belongs makes store.put fail, which
    // is the CR_STORE_FAILED passthrough that fallback_rate measures.
    await writeFile(path.join(storeDir, "artifacts"), "not a directory\n");

    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand(40)]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /artifact:cr:/);
    assert.match(result.stdout, /file40\.ts:40:TODO item 40/);

    const stats = JSON.parse(run(["stats"]).stdout);
    assert.equal(stats.runs, 1);
    assert.equal(stats.passthrough, 1);
    assert.equal(stats.fallbacks, 1);
    assert.equal(stats.fallback_rate, 1);
  });

  it("reports gain and discovers local setup and reducer opportunities", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);
    const env = {
      CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
      CONTEXT_RELAY_CODEX_HOME: codexHome,
    };

    run(["run", "--", process.execPath, "-e", "console.log('small')"], { env });
    const compressed = run(["run", "--mode", "compress", "--", ...noisyNodeCommand(220)], { env });
    run(["retrieve", artifactId(compressed.stdout), "--grep", "TODO item 7"], { env });

    const gain = run(["gain", "--json"], { env });
    assert.equal(gain.status, 0, gain.stderr);
    const gainPayload = JSON.parse(gain.stdout);
    assert.ok(gainPayload.summary.gross_saved_bytes > 0);
    assert.ok(gainPayload.summary.net_saved_bytes > 0);
    assert.equal(gainPayload.top_commands[0].command, "node");
    assert.ok(gainPayload.top_commands[0].saved_estimated_tokens > 0);

    const gainText = run(["gain"], { env });
    assert.equal(gainText.status, 0, gainText.stderr);
    assert.match(gainText.stdout, /Context Relay gain/);
    assert.match(gainText.stdout, /Top command savings/);

    const discover = run(["discover", "--json"], { env });
    assert.equal(discover.status, 0, discover.stderr);
    const discoverPayload = JSON.parse(discover.stdout);
    assert.ok(discoverPayload.setup.some((item) => item.includes("Claude Code hook is not installed")));
    assert.ok(discoverPayload.setup.some((item) => item.includes("Codex hook is not installed")));
    assert.ok(
      [...discoverPayload.high_gain, ...discoverPayload.reducer_candidates].some((entry) => entry.command === "node"),
    );

    const discoverText = run(["discover"], { env });
    assert.equal(discoverText.status, 0, discoverText.stderr);
    assert.match(discoverText.stdout, /Context Relay discover/);
    assert.match(discoverText.stdout, /Setup gaps/);
    assert.match(discoverText.stdout, /Already working well|Reducer candidates/);
  });

  it("keys git and npm commands correctly when global flags precede the subcommand (BUG 2)", async () => {
    const repoDir = await makeTempGitRepo();
    await writeFile(path.join(repoDir, "a.txt"), "hello\n");
    git(["add", "a.txt"], repoDir);
    const commitResult = spawnSync("git", ["commit", "-m", "init"], {
      cwd: repoDir,
      env: {
        ...process.env,
        ...isolatedGitEnv,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      encoding: "utf8",
    });
    assert.equal(commitResult.status, 0, commitResult.stderr);

    const gitDir = path.join(repoDir, ".git");
    const appDir = path.join(repoDir, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      path.join(appDir, "package.json"),
      `${JSON.stringify(
        { name: "app", version: "1.0.0", scripts: { build: "node -e \"console.log('built')\"" } },
        null,
        2,
      )}\n`,
    );

    // Plain `git log` still keys correctly (no regression).
    run(["run", "--", "git", "log", "--oneline"], { cwd: repoDir, env: isolatedGitEnv });
    // `git -C <path> log` used to key as `git -C` because `-C`'s value token was read as
    // the subcommand; it must key the same as plain `git log`.
    run(["run", "--", "git", "-C", repoDir, "log", "--oneline"], { env: isolatedGitEnv });
    // Same class of bug via the inline `--git-dir=<path>` global option.
    run(["run", "--", "git", `--git-dir=${gitDir}`, "log", "--oneline"], { env: isolatedGitEnv });
    // An unrecognized global flag must fall back safely to the bare executable name
    // rather than inventing a key from the flag itself.
    run(["run", "--", "git", "-C", repoDir, "--not-a-real-flag", "log"], { env: isolatedGitEnv });
    // npm-family global flags before `run <script>` must not break `npm run build` keying.
    run(["run", "--", "npm", "--prefix", "./app", "run", "build"], { cwd: repoDir });

    const events = (await readStoreEvents()).filter(
      (event) => event.kind !== "retrievals" && event.kind !== "retrieval_miss",
    );
    const keyForCommand = (commandText) => events.find((event) => event.command === commandText)?.commandKey;

    assert.equal(keyForCommand("git log --oneline"), "git log");
    assert.equal(keyForCommand(`git -C ${repoDir} log --oneline`), "git log");
    assert.equal(keyForCommand(`git --git-dir=${gitDir} log --oneline`), "git log");
    assert.equal(keyForCommand(`git -C ${repoDir} --not-a-real-flag log`), "git");
    assert.equal(keyForCommand("npm --prefix ./app run build"), "npm run build");
  });

  // The BUG 5 / BUG 6 property is pure key-derivation logic over an argv array
  // (findNpmSubcommandIndex / commandKey in lib/command-shape.js and lib/cli.js) - it has
  // nothing to do with what a real package manager binary does at runtime. This used to be
  // asserted only by actually spawning `pnpm` (see git history), which meant the test
  // silently depended on pnpm being installed on the machine running it. CI runners have
  // node/npm/git but NOT pnpm, so that spawn failed, no event was recorded, and the lookup
  // returned `undefined` - a hard failure on every CI run despite the underlying logic
  // being correct. Testing the argv -> key mapping directly, with no subprocess at all,
  // makes the property deterministic and CI-safe. (This file otherwise favors black-box
  // CLI-subprocess tests, but lib/policy.js's hasSecret/redactSecrets are already imported
  // and unit-tested directly elsewhere in this file - see the redaction tests above - so
  // this is consistent with existing practice, not a new exception.)
  it("derives pnpm/npm command keys correctly for per-tool flag semantics, from argv only (BUG 5 / BUG 6)", async () => {
    const { commandKey } = await import("../lib/cli.js");

    // pnpm's `-w` is the BOOLEAN `--workspace-root` toggle (verified: `pnpm -w run build`
    // errors "--workspace-root may only be used inside a workspace" rather than consuming
    // "run" as a value), unlike npm's value-taking `-w <workspace-name>`. Treating it as
    // value-taking for pnpm swallows the real subcommand and keys as `pnpm build`.
    assert.equal(commandKey(["pnpm", "-w", "run", "build"]), "pnpm run build");
    // npm's `-w <name>` genuinely IS value-taking and must still consume its value.
    assert.equal(commandKey(["npm", "-w", "some-workspace", "run", "build"]), "npm run build");
    // `--prefix=<dir>` (inline `=` form) was unhandled - only the separate-argument form
    // worked - so it must now key the same as the working separate-argument form.
    assert.equal(commandKey(["npm", "--prefix=/tmp/some-app", "run", "build"]), "npm run build");
    // Table-consistency companion bug found auditing the same two sets: npm's
    // `--workspace <name>` (separate-argument form, no `=`) was only recognized in the
    // INLINE set, not the separate-argument set, so it fell through and rejected.
    assert.equal(
      commandKey(["npm", "--workspace", "some-workspace", "run", "build"]),
      "npm run build",
    );
  });

  // Companion integration test: confirms the same property survives real process spawn and
  // event recording end to end, using only executables CI is guaranteed to have (npm, like
  // git elsewhere in this file, is assumed present). pnpm's bare `-w` case is NOT
  // re-exercised here - it is fully covered, deterministically, by the unit test above.
  it("keys npm commands correctly when spawned for real, for divergent flag forms (BUG 5 / BUG 6)", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "context-relay-npmfamily-"));
    tempDirs.push(workDir);
    await writeFile(
      path.join(workDir, "package.json"),
      `${JSON.stringify(
        { name: "app", version: "1.0.0", scripts: { build: "node -e \"console.log('built')\"" } },
        null,
        2,
      )}\n`,
    );

    // npm's `-w <name>` genuinely IS value-taking and must still consume its value.
    run(["run", "--", "npm", "-w", "some-workspace", "run", "build"], { cwd: workDir });
    // `--prefix=<dir>` (inline `=` form) was unhandled - only the separate-argument form
    // worked - so it must now key the same as the working separate-argument form.
    run(["run", "--", "npm", `--prefix=${workDir}`, "run", "build"]);
    // Table-consistency companion bug found auditing the same two sets: npm's
    // `--workspace <name>` (separate-argument form, no `=`) was only recognized in the
    // INLINE set, not the separate-argument set, so it fell through and rejected.
    run(["run", "--", "npm", "--workspace", "some-workspace", "run", "build"], { cwd: workDir });

    const events = (await readStoreEvents()).filter(
      (event) => event.kind !== "retrievals" && event.kind !== "retrieval_miss",
    );
    const keyForCommand = (commandText) => events.find((event) => event.command === commandText)?.commandKey;

    assert.equal(keyForCommand("npm -w some-workspace run build"), "npm run build");
    assert.equal(keyForCommand(`npm --prefix=${workDir} run build`), "npm run build");
    assert.equal(keyForCommand("npm --workspace some-workspace run build"), "npm run build");
  });

  it("refuses npm --prefix=<dir> (inline OR separate-argument form) - the gate's npm-family shape has no flag slot at all (Change 2 narrowing, was BUG 6)", () => {
    // Round-7 narrowing: the gate no longer flag-skips at all (see lib/integrations.js,
    // Change 2/4). `npm|pnpm|yarn|bun (run)? <finite-script>` is matched EXACTLY - no
    // leading global flag has a shape rule to match against, so both forms of `--prefix`
    // refuse by construction now, where a prior round wrapped both.
    const separateForm = run(["rewrite", "npm", "--prefix", "./app", "run", "build"]);
    assert.equal(separateForm.status, 1);
    assert.equal(separateForm.stdout, "");

    const inlineForm = run(["rewrite", "npm", "--prefix=./app", "run", "build"]);
    assert.equal(inlineForm.status, 1);
    assert.equal(inlineForm.stdout, "");

    // Plain `npm run build` (no leading flag at all) is unaffected - this is a narrowing of
    // the flag-skipping surface, not a wholesale disabling of npm wrapping.
    const plain = run(["rewrite", "npm", "run", "build"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, "context-relay run --mode auto -- bash -lc 'npm run build'\n");
  });

  it("refuses pnpm -C/--dir <path> - the gate's npm-family shape has no directory-flag exception the way git's does (Change 2 narrowing, was NIT 2)", () => {
    // Only git carries a single flagged exception (`-C`) in the new exact-shape gate; the
    // npm family's shape has none at all, so both pnpm's `-C` and its documented long form
    // `--dir` refuse now, where a prior round wrapped both.
    const shortForm = run(["rewrite", "pnpm", "-C", "./app", "run", "build"]);
    assert.equal(shortForm.status, 1);
    assert.equal(shortForm.stdout, "");

    const longForm = run(["rewrite", "pnpm", "--dir", "./app", "run", "build"]);
    assert.equal(longForm.status, 1);
    assert.equal(longForm.stdout, "");

    const plain = run(["rewrite", "pnpm", "run", "build"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, "context-relay run --mode auto -- bash -lc 'pnpm run build'\n");
  });

  it("refuses bun --cwd <dir> in both the separate-argument and inline forms - no npm-family shape has a flag slot (Change 2 narrowing, was NIT 1)", () => {
    // Fable previously verified live (bun 1.3.11) that the separate-argument form of
    // `--cwd` doesn't even behave as a working directory flag for bun, while the inline
    // `--cwd=<dir>` form does. That distinction no longer matters to the gate: neither form
    // matches the exact `bun (run)? <finite-script>` shape, so both refuse now regardless
    // of which one bun itself would honor.
    const separateForm = run(["rewrite", "bun", "--cwd", "/tmp/some-project", "test"]);
    assert.equal(separateForm.status, 1);
    assert.equal(separateForm.stdout, "");

    const inlineForm = run(["rewrite", "bun", "--cwd=/tmp/some-project", "test"]);
    assert.equal(inlineForm.status, 1);
    assert.equal(inlineForm.stdout, "");

    const plain = run(["rewrite", "bun", "test"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, "context-relay run --mode auto -- bash -lc 'bun test'\n");
  });

  it("does not widen yarn to accept the 'run' form when folded into the shared npm-family shape rule - yarn stays bare-only, exactly as before", () => {
    // Before matchNpmFamilyShape unified all four npm-family tools behind one shape
    // function, yarn's matcher located a subcommand and checked it against
    // FINITE_YARN_SUBCOMMANDS directly - "run" was never a member of that set, so
    // `yarn run test` was never wrapped, only bare `yarn test` was. npm/pnpm/bun all
    // separately supported the "run" form already. Folding all four into one shared
    // function would silently widen yarn to match them - an unintended behavior change in a
    // change whose whole purpose is narrowing. matchNpmFamilyShape carries an explicit
    // `executable !== "yarn"` guard on the run branch specifically to preserve this.
    const yarnRun = run(["rewrite", "yarn", "run", "test"]);
    assert.equal(yarnRun.status, 1);
    assert.equal(yarnRun.stdout, "");

    // Bare `yarn test` is unaffected - yarn's pre-existing surface, unchanged.
    const yarnBare = run(["rewrite", "yarn", "test"]);
    assert.equal(yarnBare.status, 0, yarnBare.stderr);
    assert.equal(yarnBare.stdout, "context-relay run --mode auto -- bash -lc 'yarn test'\n");
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

  it("fails stats when the store path is unavailable instead of reporting zero", async () => {
    const unavailableRoot = path.join(await makeTempDir("context-relay-unavailable-"), "store-file");
    await writeFile(unavailableRoot, "not a directory\n");

    const result = run(["stats"], { env: { CONTEXT_RELAY_STORE_DIR: unavailableRoot } });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /CR_ERROR/);
  });

  it("fails cleanup when the artifact directory is unavailable instead of reporting zero", async () => {
    const unavailableRoot = path.join(await makeTempDir("context-relay-unavailable-"), "store-file");
    await writeFile(unavailableRoot, "not a directory\n");

    const result = run(["cleanup"], { env: { CONTEXT_RELAY_STORE_DIR: unavailableRoot } });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /CR_ERROR/);
    assert.equal(await readFile(unavailableRoot, "utf8"), "not a directory\n");
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

  it("cleans artifacts with malformed JSON", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    const artifactPath = path.join(storeDir, "artifacts", `${id}.json`);
    await writeFile(artifactPath, "{ malformed json\n");

    const cleanup = run(["cleanup"]);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(JSON.parse(cleanup.stdout).removed_artifacts, 1);
    await assert.rejects(access(artifactPath));
  });

  it("does not delete an unreadable artifact during cleanup", async () => {
    const result = run(["run", "--mode", "compress", "--", ...noisyNodeCommand()]);
    const id = artifactId(result.stdout);
    const artifactPath = path.join(storeDir, "artifacts", `${id}.json`);
    await chmod(artifactPath, 0o000);

    try {
      const cleanup = run(["cleanup"]);
      assert.notEqual(cleanup.status, 0);
      assert.equal(cleanup.stdout, "");
      assert.match(cleanup.stderr, /CR_ERROR/);
      await access(artifactPath);
    } finally {
      await chmod(artifactPath, 0o600);
    }
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

  it("matches git/npm commands by exact positional shape, not by flag-skipping (Change 2/4 narrowing, was BUG 3: rewrite gate)", async () => {
    // Round 7: the gate no longer has a flag-skipping loop at all (see
    // lib/integrations.js). It matches a small number of EXACT positional shapes instead:
    // `git <safe-sub> ...rest`, the single flagged exception `git -C <dir> <safe-sub>
    // ...rest`, and `npm|pnpm|yarn|bun (run)? <finite-script>` with no leading flag at all.
    // Every other git/npm global flag - `-c`, `--exec-path`, `--git-dir`, `--prefix`, `-w`,
    // `--cwd` - refuses by construction: no shape has a slot for it, not because it is
    // individually blocklisted.
    const repoDir = await makeTempGitRepo();
    const gitDir = path.join(repoDir, ".git");

    // Plain `git log` still allowed (no regression).
    const plainLog = run(["rewrite", "git", "log"]);
    assert.equal(plainLog.status, 0, plainLog.stderr);
    assert.equal(plainLog.stdout, "context-relay run --mode auto -- bash -lc 'git log'\n");

    // `git -C <path> log --oneline -30` is the one flagged exception - still ALLOWED.
    const dashCLog = run(["rewrite", "git", "-C", repoDir, "log", "--oneline", "-30"]);
    assert.equal(dashCLog.status, 0, dashCLog.stderr);
    assert.equal(
      dashCLog.stdout,
      `context-relay run --mode auto -- bash -lc '${`git -C ${repoDir} log --oneline -30`}'\n`,
    );

    // `--git-dir=<path>` has no shape rule at all any more - REJECTED, where a prior round
    // wrapped it. Only `-C` is the named exception.
    const gitDirLog = run(["rewrite", "git", `--git-dir=${gitDir}`, "log"]);
    assert.equal(gitDirLog.status, 1);
    assert.equal(gitDirLog.stdout, "");

    // `git -C <path> push` must still be REJECTED: push is not in SAFE_GIT_SUBCOMMANDS, so
    // the `git -C <dir> <safe-sub> ...rest` shape doesn't match it either.
    const dashCPush = run(["rewrite", "git", "-C", repoDir, "push"]);
    assert.equal(dashCPush.status, 1);
    assert.equal(dashCPush.stdout, "");

    // An unrecognized global flag must still fall back to REJECTED (conservative).
    const unknownFlag = run(["rewrite", "git", "-C", repoDir, "--not-a-real-flag", "log"]);
    assert.equal(unknownFlag.status, 1);
    assert.equal(unknownFlag.stdout, "");

    // An interactive/long-running command with leading flags is REJECTED for the same
    // reason plain `npm run dev` always was - INTERACTIVE_OR_LONG_RUNNING_PATTERNS runs
    // before any shape is even considered.
    const devWithFlags = run(["rewrite", "npm", "--prefix", "./app", "run", "dev"]);
    assert.equal(devWithFlags.status, 1);
    assert.equal(devWithFlags.stdout, "");

    // npm-family global flags before `run <script>` have no shape rule either - REJECTED,
    // where a prior round wrapped it (see the dedicated narrowing tests for `--prefix`,
    // `-C`/`--dir`, and `--cwd`, was BUG 6 / NIT 1 / NIT 2).
    const npmPrefixBuild = run(["rewrite", "npm", "--prefix", "./app", "run", "build"]);
    assert.equal(npmPrefixBuild.status, 1);
    assert.equal(npmPrefixBuild.stdout, "");
  });

  it("emits the real Claude Code PreToolUse hook rewrite for `git -C <path> log`, not empty passthrough (BUG 3 end-to-end)", async () => {
    const repoDir = await makeTempGitRepo();

    const wrapped = run(["hook", "claude"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `git -C ${repoDir} log --oneline -30` },
      }),
    });
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.notEqual(wrapped.stdout, "");
    const wrappedOutput = JSON.parse(wrapped.stdout);
    assert.equal(wrappedOutput.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(
      wrappedOutput.hookSpecificOutput.updatedInput.command,
      `context-relay run --mode auto -- bash -lc '${`git -C ${repoDir} log --oneline -30`}'`,
    );

    // `git -C <path> push` must still emit nothing - push is a mutating subcommand.
    const notWrapped = run(["hook", "claude"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `git -C ${repoDir} push` },
      }),
    });
    assert.equal(notWrapped.status, 0, notWrapped.stderr);
    assert.equal(notWrapped.stdout, "");
  });

  it("refuses to wrap `git -c alias.<x>=!<cmd> <x>` even though the aliased subcommand is allowlisted (Copilot finding A)", () => {
    // `-c` is not behaviorally transparent for the rewrite gate the way `-C`/`--git-dir`
    // are: it can redefine an alias to run an arbitrary, non-finite command.
    // findGitSubcommandIndex correctly skips a leading `-c` to find "log" for STATS
    // keying, but the SAFETY gate must not reuse that skip to call the command safe -
    // `git -c alias.log=!sh log` actually runs `sh`, not `log`. Confirmed live before
    // this fix: both forms below were WRAPPED (status 0).
    const aliasSh = run(["rewrite", "git", "-c", "alias.log=!sh", "log"]);
    assert.equal(aliasSh.status, 1);
    assert.equal(aliasSh.stdout, "");

    const aliasId = run(["rewrite", "git", "-c", "alias.log=!id", "log"]);
    assert.equal(aliasId.status, 1);
    assert.equal(aliasId.stdout, "");

    // Plain `git log` (no `-c`) must still be wrapped - this is not a wholesale
    // disabling of git wrapping.
    const plainLog = run(["rewrite", "git", "log"]);
    assert.equal(plainLog.status, 0, plainLog.stderr);
    assert.equal(plainLog.stdout, "context-relay run --mode auto -- bash -lc 'git log'\n");

    // `git -C <path> log` (a different, behaviorally-transparent global flag) must still
    // be wrapped - the fix must not overreach into flags with no escape-hatch property.
    const dashCLog = run(["rewrite", "git", "-C", "/tmp", "log"]);
    assert.equal(dashCLog.status, 0, dashCLog.stderr);
    assert.equal(dashCLog.stdout, "context-relay run --mode auto -- bash -lc 'git -C /tmp log'\n");

    // A legitimate POST-subcommand `-c` (git log/show's own combined-diff flag, unrelated
    // to global `-c name=value` config) must not be penalized - the reject is scoped to
    // the leading-flags region only.
    const logDashCFlag = run(["rewrite", "git", "log", "-c"]);
    assert.equal(logDashCFlag.status, 0, logDashCFlag.stderr);
    assert.equal(logDashCFlag.stdout, "context-relay run --mode auto -- bash -lc 'git log -c'\n");

    // `-c` ahead of a NON-allowlisted subcommand must still be rejected (no regression -
    // it was already rejected before this fix, just for the wrong reason).
    const aliasPush = run(["rewrite", "git", "-c", "alias.push=!sh", "push"]);
    assert.equal(aliasPush.status, 1);
    assert.equal(aliasPush.stdout, "");
  });

  it("does not key `git --exec-path log` as `git log` for stats (Copilot finding H) - and the gate refuses `--exec-path` in EITHER form now (Change 2/4 narrowing)", async () => {
    const { commandKey } = await import("../lib/cli.js");

    // `git --exec-path log` prints the exec-path and exits 0 WITHOUT ever running "log"
    // (confirmed live: exit 0, stdout is the exec-path). commandKey (stats attribution,
    // which keeps the permissive flag-skipping finder - see lib/command-shape.js) must
    // not key it as `git log` - the finder must fall back to -1 (unrecognized), same as any
    // other unrecognized flag shape.
    assert.equal(commandKey(["git", "--exec-path", "log"]), "git");
    const barePrecedesLog = run(["rewrite", "git", "--exec-path", "log"]);
    assert.equal(barePrecedesLog.status, 1);
    assert.equal(barePrecedesLog.stdout, "");

    // The inline `=` form IS behaviorally transparent for commandKey's purposes (confirmed
    // live: `git --exec-path=/tmp log` actually ran `log`), so commandKey still keys it as
    // `git log`. The GATE is a separate matter under the round-7 narrowing: `-C` is the
    // only git flag with a shape rule at all, so `--exec-path=<dir>` - inline or not - now
    // refuses by construction, where a prior round wrapped the inline form.
    assert.equal(commandKey(["git", "--exec-path=/tmp", "log"]), "git log");
    const inlineForm = run(["rewrite", "git", "--exec-path=/tmp", "log"]);
    assert.equal(inlineForm.status, 1);
    assert.equal(inlineForm.stdout, "");
  });

  it("refuses a git/npm command with a backslash-escaped space in a leading flag's value (Copilot findings E/F) - now via the blanket expansion-character refusal, not word-count correction (Change 2 narrowing)", () => {
    // `git -C /tmp/repo\ log push` is a VALID invocation where the escaped space keeps
    // "/tmp/repo log" as ONE argument to -C, making "push" - a MUTATING subcommand, not in
    // SAFE_GIT_SUBCOMMANDS - the real subcommand. A prior round fixed this by tokenizing
    // correctly (respecting the backslash-escape) before deciding the subcommand; round 7
    // deletes that tokenizer entirely (see EXPANSION_RISK_PATTERN, lib/integrations.js) and
    // refuses on the backslash character itself, before any shape is even considered - the
    // same outcome, a strictly simpler mechanism that also closes brace-expansion,
    // variable, and glob cardinality changes the tokenizer never could.
    const escapedGit = run(["rewrite", "git", "-C", "/tmp/repo\\ log", "push"]);
    assert.equal(escapedGit.status, 1, escapedGit.stdout);
    assert.equal(escapedGit.stdout, "");

    // Same shape, npm family - also refused (now doubly so: the backslash refuses it
    // outright, and `--prefix` has no shape rule left to match against either way).
    const escapedNpm = run(["rewrite", "npm", "--prefix", "/tmp/app\\ test", "uninstall", "pkg"]);
    assert.equal(escapedNpm.status, 1, escapedNpm.stdout);
    assert.equal(escapedNpm.stdout, "");

    // Ordinary (unescaped) `git -C <dir> log` still wraps - `-C` remains the one flagged
    // exception. `npm --prefix ...` does NOT still wrap any more: under the round-7 exact
    // npm-family shape (no leading flag at all), `--prefix` refuses regardless of escaping -
    // see the dedicated narrowing test for that (was BUG 6).
    const plainGit = run(["rewrite", "git", "-C", "/tmp/repo", "log"]);
    assert.equal(plainGit.status, 0, plainGit.stderr);
    assert.equal(plainGit.stdout, "context-relay run --mode auto -- bash -lc 'git -C /tmp/repo log'\n");

    const plainNpm = run(["rewrite", "npm", "--prefix", "./app", "run", "build"]);
    assert.equal(plainNpm.status, 1);
    assert.equal(plainNpm.stdout, "");
  });

  it("refuses to wrap anything carrying an expansion-risk character - brace expansion, unquoted variables, globs (Change 2: round 7 fix)", () => {
    // The round-7 finding this closes: `git -C {repo,push} log` tokenizes to 4 words and
    // LOOKS like the safe `git -C <dir> log` shape, but brace expansion turns it into 5 real
    // shell arguments (`git -C repo push log`) once bash actually runs it - and bash runs
    // `push`, not `log`. No tokenizer can see through an expansion it cannot itself
    // evaluate, so the fix is to refuse outright on the characters that make expansion
    // possible at all, before any shape is even considered.
    const braceExpansion = run(["rewrite", "git", "-C", "{repo,push}", "log"]);
    assert.equal(braceExpansion.status, 1, braceExpansion.stdout);
    assert.equal(braceExpansion.stdout, "");

    // Same cardinality-changing property, npm family: `npm --prefix {repo,uninstall} test`
    // would run `npm --prefix repo uninstall test` once expanded.
    const npmBraceExpansion = run(["rewrite", "npm", "--prefix", "{repo,uninstall}", "test"]);
    assert.equal(npmBraceExpansion.status, 1, npmBraceExpansion.stdout);
    assert.equal(npmBraceExpansion.stdout, "");

    // An unquoted variable: the argument count depends on $REPO's contents, which this
    // process cannot evaluate without literally invoking a shell.
    const unquotedVariable = run(["rewrite", "git", "-C", "$REPO", "log"]);
    assert.equal(unquotedVariable.status, 1, unquotedVariable.stdout);
    assert.equal(unquotedVariable.stdout, "");

    // A glob: the argument count depends on which files match, a filesystem fact this
    // process cannot evaluate without invoking a shell either.
    const glob = run(["rewrite", "git", "-C", "repo*", "log"]);
    assert.equal(glob.status, 1, glob.stdout);
    assert.equal(glob.stdout, "");

    // `git -C /path push` - no expansion risk at all, but `push` is not in
    // SAFE_GIT_SUBCOMMANDS, so the shape simply doesn't match. Refused for a different
    // reason than the four above, but refused all the same - included here as the
    // brief's explicit companion case.
    const dashCPush = run(["rewrite", "git", "-C", "/path", "push"]);
    assert.equal(dashCPush.status, 1, dashCPush.stdout);
    assert.equal(dashCPush.stdout, "");
  });

  it("Finding 1: refuses question-mark pathname expansion before matching the safe git -C shape", () => {
    // `????` is one pre-expansion word, so the command looks exactly like the allowed
    // `git -C <dir> log` four-token shape. Bash may expand it to several filenames,
    // changing both argv cardinality and which word git treats as its subcommand.
    const questionGlob = run(["rewrite", "git", "-C", "????", "log"]);
    assert.equal(questionGlob.status, 1, questionGlob.stdout);
    assert.equal(questionGlob.stdout, "");
  });

  it("Finding 1: refuses bracket pathname expansion before matching the safe git -C shape", () => {
    // Bracket expressions are the third bash pathname-expansion form alongside `*` and
    // `?`. Refuse both delimiters independently as well as a complete expression so a
    // malformed or partial pattern cannot cross the gate either.
    for (const riskyDirectory of ["[repo]", "[repo", "repo]"]) {
      const bracketGlob = run(["rewrite", "git", "-C", riskyDirectory, "log"]);
      assert.equal(bracketGlob.status, 1, `${riskyDirectory}: ${bracketGlob.stdout}`);
      assert.equal(bracketGlob.stdout, "");
    }
  });

  it("Finding 4: refuses the demonstrated redirection bypass of the safe git -C shape", () => {
    // `git -C 2>f log push` tokenizes to the exact allowed `git -C <dir> log` four-token
    // shape, with `2>f` masquerading as the directory argument. Bash strips `2>f` as a
    // file-descriptor-2 redirect before building argv, leaving the real command
    // `git -C log push` - a mutating `git push`, not the read this shape was allowed for.
    const fdRedirect = run(["rewrite", "git", "-C", "2>f", "log", "push"]);
    assert.equal(fdRedirect.status, 1, fdRedirect.stdout);
    assert.equal(fdRedirect.stdout, "");
  });

  it("Finding 4: refuses bare, doubled, and fd-duplication redirection forms before matching any safe shape", () => {
    for (const riskyDirectory of [">out", "<in", ">>out", "1>out", "&>out", "<&3", ">&2"]) {
      const redirected = run(["rewrite", "git", "-C", riskyDirectory, "log"]);
      assert.equal(redirected.status, 1, `${riskyDirectory}: ${redirected.stdout}`);
      assert.equal(redirected.stdout, "");
    }
  });

  it("Finding 5: a vertical tab inside a directory token does not create an extra bash-equivalent word", () => {
    // JS `\s` matches vertical tab, form feed, and Unicode whitespace, none of which are in
    // bash's default IFS (space, tab, newline). "repo<VT>log" is ONE bash word (the vertical
    // tab has no separating meaning to bash), so `git -C repo<VT>log push` really runs a
    // mutating push from a weirdly-named directory - but splitting on JS `\s` turns it into
    // FIVE tokens (git, -C, repo, log, push), landing "log" at the position the safe
    // `git -C <dir> log` shape checks, so the real "push" subcommand hides behind it.
    const verticalTabDirectory = `repolog`;
    const controlCharSplit = run(["rewrite", "git", "-C", verticalTabDirectory, "push"]);
    assert.equal(controlCharSplit.status, 1, controlCharSplit.stdout);
    assert.equal(controlCharSplit.stdout, "");
  });

  it("Finding 6: ambiguousPreSentinelHooks does not surface commands with no plausible relation to this installer's script", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // Four tokens, ends in "hook claude" - satisfies the old shape check completely, but
    // "context-relay" is a bare relative token, not an absolute path ending in this
    // package's actual script basename. This tool never generated this and never will.
    const unrelatedFourToken = "echo context-relay hook claude";
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: unrelatedFourToken }] }] } },
        null,
        2,
      )}\n`,
    );

    const status = run(["status"], { env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.deepEqual(statusPayload.claude.ambiguousPreSentinelHooks, []);
  });

  it("still wraps the exact shapes the narrowed gate keeps: plain git log with trailing flags, git -C <dir> log, npm run build, npm test", () => {
    // The compression-cost claim this rewrite rests on: real traffic is overwhelmingly
    // `git log/diff/status/show` and `npm test`-shaped commands, and none of those lose
    // coverage under the narrowed gate.
    const gitLogWithFlags = run(["rewrite", "git", "log", "--oneline", "-30"]);
    assert.equal(gitLogWithFlags.status, 0, gitLogWithFlags.stderr);
    assert.equal(
      gitLogWithFlags.stdout,
      "context-relay run --mode auto -- bash -lc 'git log --oneline -30'\n",
    );

    const gitDashCLog = run(["rewrite", "git", "-C", "/path/to/repo", "log"]);
    assert.equal(gitDashCLog.status, 0, gitDashCLog.stderr);
    assert.equal(
      gitDashCLog.stdout,
      "context-relay run --mode auto -- bash -lc 'git -C /path/to/repo log'\n",
    );

    const npmRunBuild = run(["rewrite", "npm", "run", "build"]);
    assert.equal(npmRunBuild.status, 0, npmRunBuild.stderr);
    assert.equal(npmRunBuild.stdout, "context-relay run --mode auto -- bash -lc 'npm run build'\n");

    const npmTest = run(["rewrite", "npm", "test"]);
    assert.equal(npmTest.status, 0, npmTest.stderr);
    assert.equal(npmTest.stdout, "context-relay run --mode auto -- bash -lc 'npm test'\n");
  });

  it("kills the allow-by-default fallback: find/grep/rg/tsc/pytest are never wrapped, with any arguments (Change 4)", () => {
    // These five used to be wrapped with ANY argument list purely for being named in a
    // SAFE_COMMANDS set, with no shape check at all - the same permissive posture that
    // produced six rounds of findings against git/npm. None of them has a shape rule now.
    for (const executable of ["find", "grep", "rg", "tsc", "pytest"]) {
      const bare = run(["rewrite", executable]);
      assert.equal(bare.status, 1, `${executable} (bare) should refuse`);
      assert.equal(bare.stdout, "");

      const withArgs = run(["rewrite", executable, "-r", "TODO", "."]);
      assert.equal(withArgs.status, 1, `${executable} -r TODO . should refuse`);
      assert.equal(withArgs.stdout, "");
    }
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

  it("Change 1: recognizes the sentinel and the one-release legacy bare form; rejects a sentinel-less impersonator and echo-shaped forms", async () => {
    const { isManagedHookCommand, resolveHookCommand } = await import("../lib/integrations.js");

    // The real generated form (interpreter + script + "hook claude" + the sentinel) is
    // recognized.
    assert.equal(isManagedHookCommand(resolveHookCommand("claude"), "claude"), true);
    // A hand-written command in any shape, as long as it ends in the exact sentinel
    // sequence "hook <provider> --managed-by=context-relay", is recognized too - identity
    // is the sentinel token, not the interpreter or script path.
    assert.equal(
      isManagedHookCommand("/some/other/node /some/other/script.js hook claude --managed-by=context-relay", "claude"),
      true,
    );
    // Checking against the WRONG provider must not match, even with the sentinel present.
    assert.equal(isManagedHookCommand(resolveHookCommand("claude"), "codex"), false);

    // The one-release legacy bare form is still recognized.
    assert.equal(isManagedHookCommand("context-relay hook claude", "claude"), true);
    assert.equal(isManagedHookCommand("context-relay hook codex", "codex"), true);

    // The exact impersonation finding this rewrite exists to close: a 4-token command that
    // satisfies every shape a prior round checked for (absolute node-looking interpreter,
    // absolute script path basename "context-relay.js") but carries no sentinel. Round 7
    // deletes shape-based recognition entirely, so this is simply unrecognized - REJECTED.
    assert.equal(
      isManagedHookCommand("'/usr/bin/node' '/opt/evil/context-relay.js' hook claude", "claude"),
      false,
    );

    // echo-shaped forms with NO sentinel - a foreign command that merely mentions
    // "context-relay hook claude" as arguments to `echo` - are rejected. This is the
    // shape a prior round's basename-based recognition was fooled by; sentinel matching
    // has nothing to be fooled by here since there is no sentinel token at all.
    assert.equal(isManagedHookCommand("echo context-relay hook claude", "claude"), false);
    // Trailing garbage after the sentinel breaks the exact "hook <provider> <sentinel>"
    // suffix match too - the sentinel must be the LAST token, not merely present somewhere.
    assert.equal(
      isManagedHookCommand("echo hook claude --managed-by=context-relay extra-token", "claude"),
      false,
    );
    // What IS accepted as a deliberate, documented trade-off (see the comment on
    // classifyHookCommand): a command that carries the exact sentinel in the exact
    // position, EVEN with an arbitrary interpreter like `echo`, is recognized. Forging the
    // sentinel is deliberate impersonation, not an accidental shape collision - and per the
    // design brief, "removing an impersonator on uninstall is defensible."
    assert.equal(isManagedHookCommand("echo hook claude --managed-by=context-relay", "claude"), true);
  });

  it("Round 8: ownership matching honors bash's blank set, not JS `\\s` - interior AND edge (Copilot round-8 finding)", async () => {
    const { isManagedHookCommand, classifyHookCommand } = await import("../lib/integrations.js");
    const VT = "\v";
    const FF = "\f";
    const NBSP = "\u00a0";

    // The finding: parseShellQuotedTokens split on JS `\s`, so a byte bash keeps INSIDE a
    // word was read as a token boundary. `echo hook<VT>claude --managed-by=context-relay`
    // tokenized to five words ending in the exact sentinel triple and classified "managed"
    // - while bash runs `echo 'hook<VT>claude' --managed-by=context-relay`, four words, a
    // different command entirely. Verified against the real shell before the fix:
    //   bash -c 'v=$(printf "a\vb"); set -- $v; echo $#'  ->  1
    assert.equal(
      isManagedHookCommand(`echo hook${VT}claude --managed-by=context-relay`, "claude"),
      false,
    );
    assert.equal(
      isManagedHookCommand(`echo hook${FF}claude --managed-by=context-relay`, "claude"),
      false,
    );
    assert.equal(
      isManagedHookCommand(`echo hook${NBSP}claude --managed-by=context-relay`, "claude"),
      false,
    );

    // The EDGE half of the same bug, which the tokenizer fix alone does not close:
    // classifyHookCommand/matchPreSentinelHookShape called JS .trim(), which also strips
    // VT/FF/NBSP - so a leading VT was erased before the exact legacy-string comparison and
    // the command was claimed as ours. bash would look for a program literally named
    // "<VT>context-relay"; that program need not exist for the DELETION to fire.
    assert.equal(isManagedHookCommand(`${VT}context-relay hook claude`, "claude"), false);
    assert.equal(isManagedHookCommand(`context-relay hook claude${VT}`, "claude"), false);
    assert.equal(isManagedHookCommand(`${NBSP}context-relay hook claude`, "claude"), false);
    assert.equal(
      isManagedHookCommand(`echo hook claude --managed-by=context-relay${VT}`, "claude"),
      false,
    );

    // Ordinary space and tab ARE bash blanks and must still be trimmed and split on. The
    // fix loses no generated or documented owned form: every release emitted its tokens
    // space-separated, and quoted path bytes are copied verbatim by the quote branch, so
    // nothing we ever wrote stops being recognized. (It is not literally "recognizes a
    // strict subset": treating a non-ASCII blank as a literal byte can newly surface an
    // unquoted pre-sentinel path containing one to the init-only shape detector, where the
    // outcome is an exact same-path comparison or a non-destructive status report.)
    assert.equal(classifyHookCommand("  context-relay hook claude\t", "claude"), "legacy");
    assert.equal(
      classifyHookCommand("\techo hook claude --managed-by=context-relay  ", "claude"),
      "managed",
    );
    // Tab as an INTERIOR separator too, so narrowing SHELL_BLANK_PATTERN further (to just
    // / /) would be caught here rather than silently shipping.
    assert.equal(
      classifyHookCommand("echo\thook\tclaude\t--managed-by=context-relay", "claude"),
      "managed",
    );
  });

  it("Round 11: a bare token carrying shell syntax is never claimed as ours (Copilot round-11 finding)", async () => {
    const { isManagedHookCommand, classifyHookCommand, resolveHookCommand } = await import("../lib/integrations.js");
    const S = "--managed-by=context-relay";

    // Each of these ends in the exact sentinel triple, so the suffix match succeeded and the
    // command was CLAIMED - and uninstall deletes what it claims. Bash does not word-split
    // any of them the way this parser did: `/opt/my\ hook` is ONE executable token to bash.
    for (const token of [
      "/opt/my\\",      // backslash-escaped space
      "/opt/x;",         // control operator
      "/opt/x|",
      "/opt/`x`",        // command substitution
      '/opt/"x',         // quote
      "/opt/$HOME",      // variable expansion
      "/opt/*",          // glob
      "~/x",             // tilde expansion
      "/opt/{a,b}",      // brace expansion
      "/opt/?",
      "/opt/!x",
    ]) {
      assert.equal(isManagedHookCommand(`${token} hook claude ${S}`, "claude"), false, token);
    }

    // Copilot's suggested remedy was a DENYLIST, /[\\'"\r\n;&|<>()#`]/. It closes the first
    // five above and misses the last six - measured, not assumed. Recorded here so the
    // rejection is not re-litigated: naming dangerous characters fails OPEN on the one you
    // forgot, which is the same argument ARC-2109 uses against dangerous-flag denylists.
    const copilotDenylist = /[\\'"\r\n;&|<>()#`]/;
    const missedByDenylist = ["/opt/$HOME", "/opt/*", "~/x", "/opt/{a,b}", "/opt/?", "/opt/!x"];
    for (const token of missedByDenylist) {
      assert.equal(copilotDenylist.test(token), false, `denylist unexpectedly caught ${token}`);
      assert.equal(isManagedHookCommand(`${token} hook claude ${S}`, "claude"), false, token);
    }

    // Strictly narrowing - everything we actually emit is still claimed. The interpreter and
    // script path go through shellQuote's QUOTED branch, so arbitrary bytes there (spaces,
    // an nvm version, a relocated repo) are unaffected by the bare-token allowlist.
    assert.equal(isManagedHookCommand(resolveHookCommand("claude"), "claude"), true);
    assert.equal(isManagedHookCommand(resolveHookCommand("codex"), "codex"), true);
    assert.equal(classifyHookCommand("context-relay hook claude", "claude"), "legacy");
    assert.equal(
      classifyHookCommand(`'/opt/my node' '/opt/some path/cli.js' hook claude ${S}`, "claude"),
      "managed",
    );
  });

  it("Round 11: every string the tokenizer ACCEPTS word-splits identically in bash", async () => {
    // The invariant that replaces the twice-wrong "class closed by enumeration" claim. It is
    // bounded on purpose: it quantifies over the strings this function accepts, and says
    // nothing about the rest of the system. Anything off that domain returns null and fails
    // closed. Verified differentially against the real shell rather than argued.
    const { parseShellQuotedTokens } = await import("../lib/integrations.js");
    const candidates = [
      "context-relay hook claude",
      "hook claude --managed-by=context-relay",
      "'/usr/bin/node' '/opt/cli.js' hook claude --managed-by=context-relay",
      "'/opt/my node' '/opt/some path/cli.js' hook codex --managed-by=context-relay",
      "/usr/local/bin/context-relay hook claude",
      "a.b_c/d=e-f",
      "  padded   with   blanks  ",
      "'it'\\''s' hook claude",
      // Every one of these must be REFUSED, so they never reach the bash comparison.
      "/opt/my\\ hook claude",
      "/opt/$HOME hook claude",
      "/opt/* hook claude",
      "~/x hook claude",
      "/opt/{a,b} hook claude",
      "/opt/x; hook claude",
      "/opt/`x` hook claude",
    ];

    let accepted = 0;
    for (const candidate of candidates) {
      const tokens = parseShellQuotedTokens(candidate);
      if (tokens === null) {
        continue; // fails closed - outside the accepted domain, nothing to prove
      }
      accepted += 1;
      // Recover what bash ACTUALLY produces as argv for the same string.
      const printed = spawnSync("bash", ["-c", `for w in ${candidate}; do printf '%s\\0' "$w"; done`], {
        encoding: "utf8",
      });
      assert.equal(printed.status, 0, `${candidate}: ${printed.stderr}`);
      const bashWords = printed.stdout.split("\0").slice(0, -1);
      assert.deepEqual(tokens, bashWords, `tokenizer disagreed with bash on: ${candidate}`);
    }
    // Guard against the invariant passing vacuously by refusing everything.
    assert.ok(accepted >= 8, `expected the accepted domain to be non-trivial, got ${accepted}`);
  });

  it("Round 10: discover describes a legacy hook as needing migration, not as uninstalled (Copilot round-10 finding)", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome, CONTEXT_RELAY_CODEX_HOME: codexHome };

    // Seed the legacy bare form on BOTH providers. status reports hookInstalled: true and
    // hookUpgradeable: true for these, but automaticShellWrapping: false (round 7 split the
    // flag because the bare form is PATH-dependent and may not resolve). discover branched
    // only on automaticShellWrapping, so it told the user the hook was "not installed" -
    // contradicting status for the one state where they disagree.
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "context-relay hook claude" }] }] } }, null, 2)}\n`,
    );
    await writeFile(
      path.join(codexHome, "hooks.json"),
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "context-relay hook codex" }] }] } }, null, 2)}\n`,
    );

    const status = JSON.parse(run(["status", "--json"], { env }).stdout);
    assert.equal(status.claude.hookInstalled, true);
    assert.equal(status.claude.hookUpgradeable, true);
    assert.equal(status.claude.automaticShellWrapping, false);

    const payload = JSON.parse(run(["discover", "--json"], { env }).stdout);
    const claudeLine = payload.setup.find((item) => item.startsWith("Claude Code hook"));
    const codexLine = payload.setup.find((item) => item.startsWith("Codex hook"));
    // Both providers, so the wording cannot drift apart between them.
    for (const line of [claudeLine, codexLine]) {
      assert.ok(line, "expected a setup line for each provider");
      assert.match(line, /needs migration/);
      assert.doesNotMatch(line, /is not installed/);
      // The remedy was already correct and must not change.
      assert.match(line, /context-relay init --(claude|codex)/);
    }
  });

  it("Round 9: `git branch` never wraps - trailing arguments turn it into a mutation (Copilot round-9 finding A)", async () => {
    const { rewriteShellCommand } = await import("../lib/integrations.js");

    // Every one of these matched SAFE_GIT_SUBCOMMANDS via `parts[1]` and was WRAPPED before
    // this change, despite the documented contract that mutating commands are skipped.
    for (const command of [
      "git branch -D old-feature",
      "git branch new-branch-name",
      "git branch -m old new",
      "git -C /repo branch -D old",
    ]) {
      assert.equal(rewriteShellCommand(command, {}).changed, false, command);
    }
    // The read-only forms stop wrapping too - that is the accepted trade of deleting the
    // set member rather than growing a read-only flag grammar for it.
    assert.equal(rewriteShellCommand("git branch", {}).changed, false);
    assert.equal(rewriteShellCommand("git branch --list", {}).changed, false);

    // The remaining members are unaffected: they are read-only under arbitrary trailing
    // arguments, which is the criterion `branch` violated.
    assert.equal(rewriteShellCommand("git log --oneline -20", {}).changed, true);
    assert.equal(rewriteShellCommand("git -C /repo status", {}).changed, true);
  });

  it("Round 8: a VT-bearing foreign hook survives init --claude byte-identical", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // End-to-end proof for the destructive half of the finding. Reproduced live before the
    // fix: this entry was classified as ours by stripManagedPreToolUseEntries and did NOT
    // survive init - a silent deletion of foreign configuration during an ordinary install.
    const foreign = `echo hook\vclaude --managed-by=context-relay`;
    const seed = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: foreign }] }],
      },
    };
    await writeFile(path.join(claudeHome, "settings.json"), `${JSON.stringify(seed, null, 2)}\n`);

    const init = run(["init", "--claude"], { env });
    assert.equal(init.status, 0, init.stderr);
    const afterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.deepEqual(afterInit.hooks.PreToolUse[0], seed.hooks.PreToolUse[0]);
    // Our own entry is still appended alongside it - the fix narrows recognition, it does
    // not break installation.
    assert.match(afterInit.hooks.PreToolUse.at(-1).hooks[0].command, /--managed-by=context-relay$/);

    // And uninstall removes only ours, leaving the VT entry untouched.
    const uninstall = run(["uninstall", "--claude"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const afterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.deepEqual(afterUninstall.hooks.PreToolUse, seed.hooks.PreToolUse);
  });

  it("installs Claude and Codex hooks without touching real homes, and the written hook command resolves with no PATH", async () => {
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
    const claudeHookEntry = claudeSettings.hooks.PreToolUse.at(-1);
    assert.equal(claudeHookEntry.matcher, "Bash");
    assert.equal(claudeHookEntry.hooks.length, 1);
    assert.equal(claudeHookEntry.hooks[0].type, "command");
    const claudeHookCommand = claudeHookEntry.hooks[0].command;
    // BUG 1 regression guard: a hook subprocess does not inherit the invoking shell's PATH,
    // so the old bare "context-relay hook claude" silently failed to resolve whenever
    // context-relay was installed via `npm link` rather than onto a PATH directory. The
    // written command must no longer be that bare form, and must be self-contained.
    assert.notEqual(claudeHookCommand, "context-relay hook claude");
    assert.match(claudeHookCommand, /hook claude --managed-by=context-relay$/);
    assert.match(claudeHookCommand, /context-relay\.js/);
    assert.match(await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8"), /@CONTEXT_RELAY\.md/);
    assert.match(await readFile(path.join(claudeHome, "CONTEXT_RELAY.md"), "utf8"), /Context Relay wraps noisy shell output/);

    assert.match(await readFile(path.join(codexHome, "AGENTS.md"), "utf8"), /Context Relay managed block/);
    assert.match(await readFile(path.join(codexHome, "CONTEXT_RELAY.md"), "utf8"), /Context Relay wraps noisy shell output/);
    const codexHooks = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    const codexHookEntry = codexHooks.hooks.PreToolUse.at(-1);
    assert.equal(codexHookEntry.matcher, "Bash");
    assert.equal(codexHookEntry.hooks.length, 1);
    assert.equal(codexHookEntry.hooks[0].type, "command");
    assert.equal(codexHookEntry.hooks[0].statusMessage, "Wrapping noisy shell output with Context Relay");
    const codexHookCommand = codexHookEntry.hooks[0].command;
    assert.notEqual(codexHookCommand, "context-relay hook codex");
    assert.match(codexHookCommand, /hook codex --managed-by=context-relay$/);
    assert.match(codexHookCommand, /context-relay\.js/);

    // The actual regression test: run the exact installed command line through a shell
    // with the minimal PATH from the live repro (`env -i PATH=/usr/bin:/bin sh -c
    // 'command -v context-relay'` finds nothing on this machine), invoking the shell
    // itself by absolute path so PATH plays no role in finding /bin/sh either. If the
    // written hook command still depended on PATH to resolve `context-relay` or `node`,
    // this would fail to spawn or exit non-zero instead of returning a rewrite.
    const minimalPathEnv = { PATH: "/usr/bin:/bin" };
    const claudeHookRun = spawnSync("/bin/sh", ["-c", claudeHookCommand], {
      env: minimalPathEnv,
      input: JSON.stringify({ tool_input: { command: "pnpm test" } }),
      encoding: "utf8",
    });
    assert.equal(claudeHookRun.status, 0, claudeHookRun.stderr);
    const claudeHookOutput = JSON.parse(claudeHookRun.stdout);
    assert.equal(
      claudeHookOutput.hookSpecificOutput.updatedInput.command,
      "context-relay run --mode auto -- bash -lc 'pnpm test'",
    );

    const codexHookRun = spawnSync("/bin/sh", ["-c", codexHookCommand], {
      env: minimalPathEnv,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      }),
      encoding: "utf8",
    });
    assert.equal(codexHookRun.status, 0, codexHookRun.stderr);
    const codexHookOutput = JSON.parse(codexHookRun.stdout);
    assert.equal(codexHookOutput.hookSpecificOutput.permissionDecision, "allow");

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
    // A freshly-installed hook is the current sentinel form, not the one-release legacy
    // bare form - status must not report it as upgradeable.
    assert.equal(statusPayload.claude.hookUpgradeable, false);
    assert.equal(statusPayload.codex.hookUpgradeable, false);

    const uninstall = run(["uninstall", "--all"], {
      env: {
        CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
        CONTEXT_RELAY_CODEX_HOME: codexHome,
      },
    });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const claudeSettingsAfter = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeSettingsAfter.hooks, undefined);
    assert.doesNotMatch(await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8"), /@CONTEXT_RELAY\.md/);
    assert.doesNotMatch(await readFile(path.join(codexHome, "AGENTS.md"), "utf8"), /Context Relay managed block/);
    const codexHooksAfter = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexHooksAfter.hooks, undefined);
  });

  it("reports invalid agent config explicitly and refuses every mutation without rewriting it", async () => {
    const invalidConfigs = [
      ["empty file", ""],
      ["whitespace-only file", " \n\t"],
      ["malformed JSON", "{\n"],
      ["null", "null\n"],
      ["array", "[]\n"],
      ["string", '"foreign"\n'],
      ["number", "42\n"],
      ["array hook container", '{"foreign":true,"hooks":[]}\n'],
    ];
    const providers = [
      ["claude", "settings.json"],
      ["codex", "hooks.json"],
    ];

    for (const [provider, configName] of providers) {
      for (const [configKind, original] of invalidConfigs) {
        const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
        const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
        tempDirs.push(claudeHome, codexHome);
        const env = {
          CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
          CONTEXT_RELAY_CODEX_HOME: codexHome,
        };
        const providerHome = provider === "claude" ? claudeHome : codexHome;
        const configPath = path.join(providerHome, configName);
        await writeFile(configPath, original);

        const status = run(["status", "--json"], { env });
        assert.equal(status.status, 0, `${provider} ${configKind}: ${status.stderr}`);
        const statusPayload = JSON.parse(status.stdout);
        assert.equal(statusPayload[provider].configState, "invalid", `${provider} ${configKind}`);

        const discover = run(["discover", "--json"], { env });
        assert.equal(discover.status, 0, `${provider} ${configKind}: ${discover.stderr}`);
        const setup = JSON.parse(discover.stdout).setup;
        assert.ok(
          setup.some((item) => item.includes(`${provider === "claude" ? "Claude Code" : "Codex"} configuration is invalid`)),
          `${provider} ${configKind}: ${JSON.stringify(setup)}`,
        );

        for (const args of [
          ["init", `--${provider}`],
          ["init", `--${provider}`, "--dry-run"],
          ["uninstall", `--${provider}`],
          ["uninstall", `--${provider}`, "--dry-run"],
        ]) {
          const mutation = run(args, { env });
          assert.equal(mutation.status, 1, `${provider} ${configKind} ${args.join(" ")}`);
          assert.match(mutation.stderr, /configuration is invalid/i);
          assert.equal(
            await readFile(configPath, "utf8"),
            original,
            `${provider} ${configKind} ${args.join(" ")} rewrote config`,
          );
        }
      }
    }
  });

  it("does not create a missing agent config file during uninstall", async () => {
    for (const [provider, configName] of [["claude", "settings.json"], ["codex", "hooks.json"]]) {
      for (const dryRunArgs of [[], ["--dry-run"]]) {
        const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
        const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
        tempDirs.push(claudeHome, codexHome);
        const env = {
          CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
          CONTEXT_RELAY_CODEX_HOME: codexHome,
        };
        const providerHome = provider === "claude" ? claudeHome : codexHome;
        const configPath = path.join(providerHome, configName);

        const uninstall = run(["uninstall", `--${provider}`, ...dryRunArgs], { env });
        assert.equal(uninstall.status, 0, uninstall.stderr);
        await assert.rejects(access(configPath), { code: "ENOENT" });
      }
    }
  });

  it("uses exact awareness ownership across status, repeated init, and uninstall", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);
    const env = {
      CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
      CONTEXT_RELAY_CODEX_HOME: codexHome,
    };
    const claudeDecoy = "See @CONTEXT_RELAY.md for optional notes.\n";
    const codexForeign = `Mention @CONTEXT_RELAY.md in prose.
# --- Context Relay managed block ---
foreign partial body
# unrelated delimiter
# --- end Context Relay managed block ---

# --- Context Relay managed block ---
orphaned start
`;
    await mkdir(claudeHome, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(claudeHome, "CLAUDE.md"), claudeDecoy);
    await writeFile(path.join(codexHome, "AGENTS.md"), codexForeign);

    const before = JSON.parse(run(["status", "--json"], { env }).stdout);
    assert.equal(before.claude.awarenessLinked, false);
    assert.equal(before.codex.awarenessLinked, false);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const init = run(["init", "--all"], { env });
      assert.equal(init.status, 0, init.stderr);
    }

    const claudeInstalled = await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8");
    assert.equal(
      claudeInstalled.split(/\r?\n/).filter((line) => line.trim() === "@CONTEXT_RELAY.md").length,
      1,
    );
    assert.ok(claudeInstalled.includes(claudeDecoy.trimEnd()));

    const managedBlock = `# --- Context Relay managed block ---
@CONTEXT_RELAY.md
# --- end Context Relay managed block ---`;
    const codexInstalled = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");
    assert.equal(codexInstalled.split(managedBlock).length - 1, 1);
    assert.ok(codexInstalled.includes(codexForeign.trimEnd()));

    const installed = JSON.parse(run(["status", "--json"], { env }).stdout);
    assert.equal(installed.claude.awarenessLinked, true);
    assert.equal(installed.codex.awarenessLinked, true);

    const uninstall = run(["uninstall", "--all"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8"), claudeDecoy);
    assert.equal(await readFile(path.join(codexHome, "AGENTS.md"), "utf8"), codexForeign);
  });

  it("Finding 3: reports legacy bare-name hooks as installed but not automatically wrapping, then healthy after re-init, for Claude and Codex", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);
    const env = {
      CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
      CONTEXT_RELAY_CODEX_HOME: codexHome,
    };

    // Simulate a hook installed by a pre-fix version of context-relay: the bare-name
    // command that silently fails to resolve once the hook subprocess loses PATH.
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "context-relay hook claude" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(codexHome, "hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: "context-relay hook codex",
                    statusMessage: "Wrapping noisy shell output with Context Relay",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const status = run(["status"], { env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    // A legacy entry is still recognized as installed so init/uninstall can migrate it,
    // but it is not a reliable automatic wrapper: detached hooks may not resolve the bare
    // `context-relay` executable on PATH. Both providers must expose that distinction.
    assert.equal(statusPayload.claude.hookInstalled, true);
    assert.equal(statusPayload.codex.hookInstalled, true);
    assert.equal(statusPayload.claude.automaticShellWrapping, false);
    assert.equal(statusPayload.codex.automaticShellWrapping, false);
    assert.equal(statusPayload.claude.hookUpgradeable, true);
    assert.equal(statusPayload.codex.hookUpgradeable, true);

    // Re-running init must not add a second entry alongside the legacy one - AND it must
    // upsert the legacy bare-name entry into the absolute-form command, self-healing the
    // exact "silently fails to resolve once the subprocess loses PATH" problem this hook
    // has (see the comment above): recognizing the legacy string as "already installed"
    // and leaving it in place would leave the user stuck with a broken hook forever.
    const reinit = run(["init", "--all"], { env });
    assert.equal(reinit.status, 0, reinit.stderr);
    const claudeSettingsAfterReinit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeSettingsAfterReinit.hooks.PreToolUse.length, 1);
    const claudeReinitCommand = claudeSettingsAfterReinit.hooks.PreToolUse[0].hooks[0].command;
    assert.notEqual(claudeReinitCommand, "context-relay hook claude");
    assert.match(claudeReinitCommand, /hook claude --managed-by=context-relay$/);
    assert.match(claudeReinitCommand, /context-relay\.js/);
    const codexHooksAfterReinit = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexHooksAfterReinit.hooks.PreToolUse.length, 1);
    const codexReinitCommand = codexHooksAfterReinit.hooks.PreToolUse[0].hooks[0].command;
    assert.notEqual(codexReinitCommand, "context-relay hook codex");
    assert.match(codexReinitCommand, /hook codex --managed-by=context-relay$/);
    assert.match(codexReinitCommand, /context-relay\.js/);

    // Re-init replaces both legacy entries with the absolute-path sentinel form. Status
    // can now report automatic wrapping as healthy for both providers.
    const statusAfterReinit = run(["status"], { env });
    assert.equal(statusAfterReinit.status, 0, statusAfterReinit.stderr);
    const statusAfterReinitPayload = JSON.parse(statusAfterReinit.stdout);
    assert.equal(statusAfterReinitPayload.claude.automaticShellWrapping, true);
    assert.equal(statusAfterReinitPayload.codex.automaticShellWrapping, true);
    assert.equal(statusAfterReinitPayload.claude.hookUpgradeable, false);
    assert.equal(statusAfterReinitPayload.codex.hookUpgradeable, false);

    const uninstall = run(["uninstall", "--all"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const claudeSettingsAfterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeSettingsAfterUninstall.hooks, undefined);
    const codexHooksAfterUninstall = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexHooksAfterUninstall.hooks, undefined);
  });

  it("does not recognize a same-shaped foreign command as its own hook, and never removes one on uninstall (BUG 4)", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);
    const env = {
      CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
      CONTEXT_RELAY_CODEX_HOME: codexHome,
    };

    // Three foreign hooks, none of them ours, each shaped to defeat a naive
    // substring-on-"context-relay" check: a DIFFERENT tool whose binary name happens to
    // contain "context-relay" as a substring, an arbitrary command that mentions
    // "context-relay" in passing, and (as a baseline) a wholly unrelated tool. All three
    // end in "hook claude" / "hook codex", the shape isManagedHookCommand also looks for.
    const foreignClaudeHooks = [
      { type: "command", command: "/usr/local/bin/context-relay-wrapper hook claude" },
      { type: "command", command: "echo context-relay hook claude" },
      { type: "command", command: "/usr/bin/other-tool hook claude" },
    ];
    const foreignCodexHooks = [
      { type: "command", command: "/usr/local/bin/context-relay-wrapper hook codex" },
      { type: "command", command: "echo context-relay hook codex" },
      { type: "command", command: "/usr/bin/other-tool hook codex" },
    ];
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: foreignClaudeHooks.map((hook) => ({ matcher: "Bash", hooks: [hook] })),
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(codexHome, "hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: foreignCodexHooks.map((hook) => ({ matcher: "Bash", hooks: [hook] })),
          },
        },
        null,
        2,
      )}\n`,
    );

    // None of the foreign hooks should be recognized as already-ours: init must add its
    // OWN new entry alongside them rather than treating any foreign entry as installed.
    const init = run(["init", "--all"], { env });
    assert.equal(init.status, 0, init.stderr);

    const claudeAfterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeAfterInit.hooks.PreToolUse.length, foreignClaudeHooks.length + 1);
    for (const hook of foreignClaudeHooks) {
      assert.ok(
        claudeAfterInit.hooks.PreToolUse.some((entry) => entry.hooks[0].command === hook.command),
        `expected foreign hook to survive init: ${hook.command}`,
      );
    }
    const ownClaudeEntry = claudeAfterInit.hooks.PreToolUse.at(-1);
    assert.match(ownClaudeEntry.hooks[0].command, /hook claude --managed-by=context-relay$/);
    assert.match(ownClaudeEntry.hooks[0].command, /context-relay\.js/);

    const codexAfterInit = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexAfterInit.hooks.PreToolUse.length, foreignCodexHooks.length + 1);
    for (const hook of foreignCodexHooks) {
      assert.ok(
        codexAfterInit.hooks.PreToolUse.some((entry) => entry.hooks[0].command === hook.command),
        `expected foreign hook to survive init: ${hook.command}`,
      );
    }

    // The destructive path: uninstall must remove ONLY the entry it just added, and every
    // foreign hook - including the substring-colliding ones - must survive untouched.
    const uninstall = run(["uninstall", "--all"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);

    const claudeAfterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeAfterUninstall.hooks.PreToolUse.length, foreignClaudeHooks.length);
    assert.deepEqual(
      claudeAfterUninstall.hooks.PreToolUse.map((entry) => entry.hooks[0].command),
      foreignClaudeHooks.map((hook) => hook.command),
    );

    const codexAfterUninstall = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexAfterUninstall.hooks.PreToolUse.length, foreignCodexHooks.length);
    assert.deepEqual(
      codexAfterUninstall.hooks.PreToolUse.map((entry) => entry.hooks[0].command),
      foreignCodexHooks.map((hook) => hook.command),
    );
  });

  it("does not duplicate the generated absolute-form hook on re-init (BUG 4)", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    const firstInit = run(["init", "--claude"], { env });
    assert.equal(firstInit.status, 0, firstInit.stderr);
    const afterFirstInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(afterFirstInit.hooks.PreToolUse.length, 1);
    const generatedCommand = afterFirstInit.hooks.PreToolUse[0].hooks[0].command;
    assert.match(generatedCommand, /hook claude --managed-by=context-relay$/);
    assert.match(generatedCommand, /context-relay\.js/);

    const secondInit = run(["init", "--claude"], { env });
    assert.equal(secondInit.status, 0, secondInit.stderr);
    const afterSecondInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(afterSecondInit.hooks.PreToolUse.length, 1);
    assert.equal(afterSecondInit.hooks.PreToolUse[0].hooks[0].command, generatedCommand);
  });

  it("does NOT recognize a pre-sentinel absolute-path hook at a DIFFERENT install location as ours - it stays genuinely ambiguous, left alone by init and uninstall, and surfaced by status (Change 1 narrowing, refined by the same-path defect fix below)", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);
    const env = {
      CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
      CONTEXT_RELAY_CODEX_HOME: codexHome,
    };

    // A hook written by a pre-sentinel install of context-relay at a path that is NOT this
    // install's own resolved script path (e.g. an npm-link'd clone that has since moved, or
    // been removed): a 4-token generated command whose basename is "context-relay.js" but
    // which carries no "--managed-by=context-relay" sentinel, because it was written by a
    // version of this tool that predates the sentinel entirely.
    //
    // A prior round recognized this shape by basename alone (interpreter path + script
    // basename, no sentinel involved) specifically to self-heal this migration scenario -
    // but that ambient-shape recognition is exactly what let
    // "'/usr/bin/node' '/opt/evil/context-relay.js' hook claude" get claimed as ours too:
    // the shape that closes the migration gap and the shape that opens the impersonation
    // hole are the SAME shape. Round 7 gave up recognizing this pre-sentinel form for
    // OWNERSHIP purposes entirely - see classifyHookCommand/isManagedHookCommand, still
    // used unchanged by uninstall. The defect fix below adds exactly one narrow exception
    // for `init`, scoped to the SAME resolved script path (isSamePathPreSentinelHook) -
    // this test is the companion case where the path genuinely differs, which stays exactly
    // as ambiguous as Round 7 left it: `init` still self-heals in the sense that matters (a
    // working sentinel hook gets added alongside it), it just cannot also remove/rewrite
    // the old one - and status now surfaces it under ambiguousPreSentinelHooks instead of
    // leaving it as an unexplained duplicate wrap.
    const migratedClaudeHook = "'/usr/bin/some-other-node' '/dead/clone/path/bin/context-relay.js' hook claude";
    const migratedCodexHook = "'/usr/bin/some-other-node' '/dead/clone/path/bin/context-relay.js' hook codex";
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: migratedClaudeHook }] }] } },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(codexHome, "hooks.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: migratedCodexHook }] }] } },
        null,
        2,
      )}\n`,
    );

    const status = run(["status"], { env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.claude.automaticShellWrapping, false);
    assert.equal(statusPayload.codex.automaticShellWrapping, false);
    // status surfaces the ambiguous, different-path pre-sentinel hook by name rather than
    // silently reporting "not installed" with no explanation for the leftover entry.
    assert.deepEqual(statusPayload.claude.ambiguousPreSentinelHooks, [migratedClaudeHook]);
    assert.deepEqual(statusPayload.codex.ambiguousPreSentinelHooks, [migratedCodexHook]);

    // init self-heals by adding a fresh, sentinel-bearing entry alongside the stale one -
    // it does not (and cannot, the path being genuinely different) rewrite the old one in
    // place. This IS a double-wrap (both entries fire on every Bash call), but it is no
    // longer a SILENT one - status (checked again below) still flags it.
    const init = run(["init", "--all"], { env });
    assert.equal(init.status, 0, init.stderr);
    const claudeAfterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeAfterInit.hooks.PreToolUse.length, 2);
    assert.ok(
      claudeAfterInit.hooks.PreToolUse.some((entry) => entry.hooks[0].command === migratedClaudeHook),
      "the stale pre-sentinel hook must survive init untouched",
    );
    const freshClaudeEntry = claudeAfterInit.hooks.PreToolUse.at(-1);
    assert.match(freshClaudeEntry.hooks[0].command, /hook claude --managed-by=context-relay$/);

    const statusAfterInit = run(["status"], { env });
    assert.equal(statusAfterInit.status, 0, statusAfterInit.stderr);
    const statusAfterInitPayload = JSON.parse(statusAfterInit.stdout);
    assert.equal(statusAfterInitPayload.claude.automaticShellWrapping, true);
    assert.deepEqual(statusAfterInitPayload.claude.ambiguousPreSentinelHooks, [migratedClaudeHook]);
    assert.deepEqual(statusAfterInitPayload.codex.ambiguousPreSentinelHooks, [migratedCodexHook]);

    // uninstall leaves the stale pre-sentinel hook in place too - it is foreign as far as
    // this predicate is concerned, and removing "foreign" hooks is exactly the mistake this
    // whole rewrite exists to stop making.
    const uninstall = run(["uninstall", "--all"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const claudeAfterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeAfterUninstall.hooks.PreToolUse.length, 1);
    assert.equal(claudeAfterUninstall.hooks.PreToolUse[0].hooks[0].command, migratedClaudeHook);
    const codexAfterUninstall = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexAfterUninstall.hooks.PreToolUse.length, 1);
    assert.equal(codexAfterUninstall.hooks.PreToolUse[0].hooks[0].command, migratedCodexHook);
  });

  it("DEFECT FIX: init against a SAME-PATH pre-sentinel hook (this install's own prior hook, written before the sentinel existed) replaces it in place - no double-wrap - while uninstall still refuses to touch it", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-codex-"));
    tempDirs.push(claudeHome, codexHome);
    const env = {
      CONTEXT_RELAY_CLAUDE_HOME: claudeHome,
      CONTEXT_RELAY_CODEX_HOME: codexHome,
    };

    // Reproduces the exact live shape found on this machine before this fix: a genuine
    // prior install of THIS SAME context-relay wrote the pre-sentinel 4-token form -
    // interpreter + this exact resolved script path + "hook <provider>" - before this
    // version added the sentinel. Built from the real resolveHookCommand() output so the
    // script path is byte-identical to what `init` will resolve for itself, not a
    // hand-typed approximation.
    const { resolveHookCommand } = await import("../lib/integrations.js");
    const preSentinelClaude = resolveHookCommand("claude").replace(/ --managed-by=context-relay$/, "");
    const preSentinelCodex = resolveHookCommand("codex").replace(/ --managed-by=context-relay$/, "");
    assert.doesNotMatch(preSentinelClaude, /--managed-by=context-relay/);

    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: preSentinelClaude }] }] } },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(codexHome, "hooks.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: preSentinelCodex }] }] } },
        null,
        2,
      )}\n`,
    );

    // Before the fix: two relay hooks would fire (the pre-sentinel one rewriting the
    // command to `context-relay run ...`, then the freshly-appended sentinel one seeing
    // that rewritten command) - the double-wrap this fix closes.
    const init = run(["init", "--all"], { env });
    assert.equal(init.status, 0, init.stderr);

    const claudeAfterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeAfterInit.hooks.PreToolUse.length, 1, "exactly one relay hook, not two");
    const claudeEntry = claudeAfterInit.hooks.PreToolUse[0];
    assert.equal(claudeEntry.hooks.length, 1);
    assert.match(claudeEntry.hooks[0].command, /hook claude --managed-by=context-relay$/);
    assert.notEqual(claudeEntry.hooks[0].command, preSentinelClaude);

    const codexAfterInit = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexAfterInit.hooks.PreToolUse.length, 1, "exactly one relay hook, not two");
    assert.match(codexAfterInit.hooks.PreToolUse[0].hooks[0].command, /hook codex --managed-by=context-relay$/);

    // status must not report a same-path pre-sentinel hook as "ambiguous" once init has
    // replaced it - there is nothing left to be ambiguous about.
    const status = run(["status"], { env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.claude.automaticShellWrapping, true);
    assert.equal(statusPayload.claude.hookUpgradeable, false);
    assert.deepEqual(statusPayload.claude.ambiguousPreSentinelHooks, []);
    assert.deepEqual(statusPayload.codex.ambiguousPreSentinelHooks, []);

    // Re-seed a fresh same-path pre-sentinel hook (simulating a machine that never ran
    // init) to prove uninstall's ownership check does NOT treat it as ours - ambiguity must
    // lose for anything destructive, even when init would have treated the identical
    // command as safely supersede-able. This is the asymmetry the fix is built on.
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: preSentinelClaude }] }] } },
        null,
        2,
      )}\n`,
    );
    const uninstall = run(["uninstall", "--claude"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const claudeAfterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeAfterUninstall.hooks.PreToolUse.length, 1);
    assert.equal(
      claudeAfterUninstall.hooks.PreToolUse[0].hooks[0].command,
      preSentinelClaude,
      "uninstall must never remove a pre-sentinel hook, same-path or not - only init self-heals it",
    );
  });

  it("Finding 2: init does not supersede an echo-interpreter entry that names this install's exact script path", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // Preserve the exact generated script-path token while replacing only the interpreter
    // token. This command has the pre-sentinel four-token shape, but it is definitionally
    // foreign: resolveHookCommand has only ever emitted process.execPath, never `echo`.
    const { resolveHookCommand, shellQuote } = await import("../lib/integrations.js");
    const echoHook = resolveHookCommand("claude")
      .replace(shellQuote(process.execPath), "echo")
      .replace(/ --managed-by=context-relay$/, "");
    assert.match(echoHook, /^echo .* hook claude$/);

    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: echoHook }] }] } },
        null,
        2,
      )}\n`,
    );

    const init = run(["init", "--claude"], { env });
    assert.equal(init.status, 0, init.stderr);
    const afterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(afterInit.hooks.PreToolUse.length, 2, "foreign echo hook must survive beside the fresh hook");
    assert.equal(afterInit.hooks.PreToolUse[0].hooks[0].command, echoHook);
    assert.match(afterInit.hooks.PreToolUse[1].hooks[0].command, /hook claude --managed-by=context-relay$/);
  });

  it("DEFECT FIX regression guard: uninstall still refuses to remove the exact impersonation shape this narrowing exists to close, even now that init recognizes a same-path pre-sentinel hook", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // The exact Copilot-finding string from the design brief: a foreign command at a
    // path that is emphatically NOT this install's resolved script path
    // (isSamePathPreSentinelHook must return false for it), carrying no sentinel.
    const evilHook = "'/usr/bin/node' '/opt/evil/context-relay.js' hook claude";
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: evilHook }] }] } },
        null,
        2,
      )}\n`,
    );

    const uninstall = run(["uninstall", "--claude"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const claudeAfterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeAfterUninstall.hooks.PreToolUse.length, 1);
    assert.equal(claudeAfterUninstall.hooks.PreToolUse[0].hooks[0].command, evilHook);
  });

  it("still rejects a wrapper binary, an echoed string, and a bare 'context-relay' (no .js) basename as the managed hook", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // Four candidates, all shaped to defeat a naive substring or bare-basename check:
    //   - a different tool whose binary path happens to contain "context-relay" as a
    //     substring (basename "context-relay-wrapper" - fails the exact ".js" basename
    //     check)
    //   - an arbitrary command that mentions "context-relay" in passing (4 tokens, but
    //     tokens[1] is "context-relay" with no path separator and no ".js" extension)
    //   - the bare basename "context-relay" (no ".js") used as a 4-token script-path
    //     token - explicitly called out as the hole that must stay closed: only the
    //     LEGACY 3-token exact string counts as "bare"
    //   - a wholly unrelated tool, as a baseline
    const foreignHooks = [
      "/usr/local/bin/context-relay-wrapper hook claude",
      "echo context-relay hook claude",
      "'/usr/bin/node' '/usr/local/bin/context-relay' hook claude",
      "/usr/bin/other-tool hook claude",
    ];
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        { hooks: { PreToolUse: foreignHooks.map((command) => ({ matcher: "Bash", hooks: [{ type: "command", command }] })) } },
        null,
        2,
      )}\n`,
    );

    const status = run(["status"], { env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).claude.automaticShellWrapping, false);

    // None of the four should be recognized as already-ours, so init must add its OWN
    // fifth entry rather than treating any of them as installed.
    const init = run(["init", "--claude"], { env });
    assert.equal(init.status, 0, init.stderr);
    const afterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(afterInit.hooks.PreToolUse.length, foreignHooks.length + 1);
    for (const command of foreignHooks) {
      assert.ok(
        afterInit.hooks.PreToolUse.some((entry) => entry.hooks[0].command === command),
        `expected foreign hook to survive init: ${command}`,
      );
    }

    // The destructive path: uninstall must remove ONLY the entry it just added.
    const uninstall = run(["uninstall", "--claude"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const afterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(afterUninstall.hooks.PreToolUse.length, foreignHooks.length);
    assert.deepEqual(
      afterUninstall.hooks.PreToolUse.map((entry) => entry.hooks[0].command),
      foreignHooks,
    );
  });

  it("init upserts a stale managed hook to the freshly generated command, leaving foreign entries in the same array untouched (BLOCKING fix: init self-heal)", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // A stale managed hook - a dead/different install directory than this test's own, but
    // still carrying the "--managed-by=context-relay" sentinel this tool actually checks
    // for (Change 1: recognition is sentinel identity, not path/basename shape, so a stale
    // PATH is irrelevant to whether this is recognized as ours) - shares an entry.hooks
    // array with a foreign hook, and a second, wholly separate PreToolUse entry holds
    // another foreign hook. Both foreign hooks must survive untouched; only the stale
    // managed hook may be rewritten.
    const staleCommand =
      "'/usr/bin/some-other-node' '/dead/clone/path/bin/context-relay.js' hook claude --managed-by=context-relay";
    const foreignSameEntry = "/usr/bin/other-tool hook claude";
    const foreignOtherEntry = "echo context-relay hook claude";
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  { type: "command", command: foreignSameEntry },
                  { type: "command", command: staleCommand },
                ],
              },
              { matcher: "Bash", hooks: [{ type: "command", command: foreignOtherEntry }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const init = run(["init", "--claude"], { env });
    assert.equal(init.status, 0, init.stderr);
    const afterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));

    const allCommands = afterInit.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    // The two foreign hooks survive untouched, in the entries they started in.
    assert.ok(allCommands.includes(foreignSameEntry), "foreign hook sharing the stale entry must survive");
    assert.ok(allCommands.includes(foreignOtherEntry), "foreign hook in its own entry must survive");
    // The stale path is gone entirely - not left in place, not left as a duplicate.
    assert.ok(!allCommands.includes(staleCommand), "stale managed hook must not survive init unchanged");
    // Exactly one hook remains shaped like our own managed hook, and it is the freshly
    // generated command, not the stale one.
    const managedShaped = allCommands.filter((command) => /context-relay\.js/.test(command));
    assert.equal(managedShaped.length, 1);
    assert.notEqual(managedShaped[0], staleCommand);
    assert.match(managedShaped[0], /hook claude --managed-by=context-relay$/);

    const firstEntry = afterInit.hooks.PreToolUse[0];
    assert.equal(firstEntry.hooks.length, 1);
    assert.equal(firstEntry.hooks[0].command, foreignSameEntry);
  });

  it("does not recognize a 4-token echo-shaped foreign command as its own hook just because token[1]'s basename matches, and never removes it on uninstall (Copilot finding G)", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // Both forms parse to 4 tokens with token[1]'s basename EXACTLY "context-relay.js" -
    // the shape the earlier round's fix validates - but token[0] (the interpreter) is
    // "echo", not an absolute path to a node executable. Reproduced before this fix: both
    // MATCHED and would have been deleted by `uninstall`.
    const echoQuoted = "echo '/tmp/context-relay.js' hook claude";
    const echoBinary = "/bin/echo /tmp/context-relay.js hook claude";
    await writeFile(
      path.join(claudeHome, "settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [echoQuoted, echoBinary].map((command) => ({
              matcher: "Bash",
              hooks: [{ type: "command", command }],
            })),
          },
        },
        null,
        2,
      )}\n`,
    );

    const status = run(["status"], { env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).claude.automaticShellWrapping, false);

    // Neither echo-shaped hook is recognized as already-ours: init must add its OWN third
    // entry rather than treating either as installed.
    const init = run(["init", "--claude"], { env });
    assert.equal(init.status, 0, init.stderr);
    const afterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(afterInit.hooks.PreToolUse.length, 3);
    assert.ok(afterInit.hooks.PreToolUse.some((entry) => entry.hooks[0].command === echoQuoted));
    assert.ok(afterInit.hooks.PreToolUse.some((entry) => entry.hooks[0].command === echoBinary));
    const ownEntry = afterInit.hooks.PreToolUse.at(-1);
    assert.match(ownEntry.hooks[0].command, /hook claude --managed-by=context-relay$/);
    assert.match(ownEntry.hooks[0].command, /context-relay\.js/);

    // The destructive path: uninstall must remove ONLY the entry it just added - both
    // echo-shaped foreign entries survive.
    const uninstall = run(["uninstall", "--claude"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const afterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.deepEqual(
      afterUninstall.hooks.PreToolUse.map((entry) => entry.hooks[0].command),
      [echoQuoted, echoBinary],
    );

    // Companion check (not a new install): under Change 1, recognition no longer looks at
    // the interpreter or script path AT ALL - only the sentinel. A cross-install migration
    // case (a DIFFERENT node binary name at a DIFFERENT directory than this test's own
    // resolveCliScriptPath()) is recognized when it carries the sentinel, and is NOT
    // recognized when it doesn't - the presence of the sentinel is the entire test, not the
    // interpreter/path shape. See "does NOT recognize a pre-sentinel absolute-path hook..."
    // above for the end-to-end version of the negative case.
    const { isManagedHookCommand } = await import("../lib/integrations.js");
    assert.equal(
      isManagedHookCommand(
        "'/usr/bin/some-other-node' '/dead/clone/path/bin/context-relay.js' hook claude --managed-by=context-relay",
        "claude",
      ),
      true,
    );
    assert.equal(
      isManagedHookCommand(
        "'/usr/bin/some-other-node' '/dead/clone/path/bin/context-relay.js' hook claude",
        "claude",
      ),
      false,
    );
    assert.equal(isManagedHookCommand(echoQuoted, "claude"), false);
    assert.equal(isManagedHookCommand(echoBinary, "claude"), false);
  });

  it("survives foreign PreToolUse entries byte-identical across init AND uninstall, including ones with an empty hooks array or a non-'Bash' matcher (Copilot finding D)", async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "context-relay-claude-"));
    tempDirs.push(claudeHome);
    const env = { CONTEXT_RELAY_CLAUDE_HOME: claudeHome };

    // The exact three-entry seed from the finding: a non-"Bash" matcher with an empty
    // hooks array, a "Bash" entry holding a foreign (unrelated) command, and another
    // non-"Bash" matcher with an empty hooks array. None of these should ever be modified
    // by stripManagedPreToolUseEntries - "Agent|Task" and "Write" because their matcher
    // isn't "Bash" at all, the "Bash" entry because its one hook isn't ours.
    const seed = {
      hooks: {
        PreToolUse: [
          { matcher: "Agent|Task", hooks: [] },
          { matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/some-other-tool --flag" }] },
          { matcher: "Write", hooks: [] },
        ],
      },
    };
    await writeFile(path.join(claudeHome, "settings.json"), `${JSON.stringify(seed, null, 2)}\n`);

    // BEFORE the fix: init deleted the "Agent|Task" and "Write" entries even though
    // neither was ever touched by the managed-hook filter (reproduced live: 3 entries ->
    // 2, both survivors reported as "Bash" - the pre-existing foreign "Bash" entry plus
    // the newly appended own entry).
    const init = run(["init", "--claude"], { env });
    assert.equal(init.status, 0, init.stderr);
    const afterInit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.deepEqual(
      afterInit.hooks.PreToolUse.map((entry) => entry.matcher),
      ["Agent|Task", "Bash", "Write", "Bash"],
    );
    assert.deepEqual(afterInit.hooks.PreToolUse[0], seed.hooks.PreToolUse[0]);
    assert.deepEqual(afterInit.hooks.PreToolUse[1], seed.hooks.PreToolUse[1]);
    assert.deepEqual(afterInit.hooks.PreToolUse[2], seed.hooks.PreToolUse[2]);
    const ownEntry = afterInit.hooks.PreToolUse[3];
    assert.match(ownEntry.hooks[0].command, /hook claude --managed-by=context-relay$/);

    // uninstall must ALSO leave the three foreign entries exactly as they were, removing
    // only the one entry init just added - covering the removal code path
    // (stripManagedPreToolUseEntries via removeClaudeHook) as well as the upsert path
    // (via mergeClaudeSettings) exercised by init above.
    const uninstall = run(["uninstall", "--claude"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const afterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.deepEqual(afterUninstall.hooks.PreToolUse, seed.hooks.PreToolUse);
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

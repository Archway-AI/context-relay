import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rewrites git/npm commands whose global flags precede the subcommand (BUG 3: rewrite gate, not just stats keying)", async () => {
    // commandKey (stats attribution) already skips leading global flags to find the real
    // subcommand. isAllowedCommandShape (lib/integrations.js) - the SEPARATE gate that
    // decides whether the PreToolUse hook wraps a command AT ALL - had the identical
    // parts[1] assumption and was never fixed. `git -C /path log` used to key correctly
    // for stats but still fail to be wrapped, because the gate itself never saw past `-C`
    // to find `log`.
    const repoDir = await makeTempGitRepo();
    const gitDir = path.join(repoDir, ".git");

    // Plain `git log` still allowed (no regression).
    const plainLog = run(["rewrite", "git", "log"]);
    assert.equal(plainLog.status, 0, plainLog.stderr);
    assert.equal(plainLog.stdout, "context-relay run --mode auto -- bash -lc 'git log'\n");

    // `git -C <path> log --oneline -30` must now be ALLOWED (wrapped).
    const dashCLog = run(["rewrite", "git", "-C", repoDir, "log", "--oneline", "-30"]);
    assert.equal(dashCLog.status, 0, dashCLog.stderr);
    assert.equal(
      dashCLog.stdout,
      `context-relay run --mode auto -- bash -lc '${`git -C ${repoDir} log --oneline -30`}'\n`,
    );

    // Inline `--git-dir=<path>` global option must also be ALLOWED.
    const gitDirLog = run(["rewrite", "git", `--git-dir=${gitDir}`, "log"]);
    assert.equal(gitDirLog.status, 0, gitDirLog.stderr);
    assert.equal(
      gitDirLog.stdout,
      `context-relay run --mode auto -- bash -lc '${`git --git-dir=${gitDir} log`}'\n`,
    );

    // `git -C <path> push` must still be REJECTED: push is not in SAFE_GIT_SUBCOMMANDS,
    // and flag-skipping must not widen the safety allowlist.
    const dashCPush = run(["rewrite", "git", "-C", repoDir, "push"]);
    assert.equal(dashCPush.status, 1);
    assert.equal(dashCPush.stdout, "");

    // An unrecognized global flag must still fall back to REJECTED (conservative), never
    // wrapped by a guess.
    const unknownFlag = run(["rewrite", "git", "-C", repoDir, "--not-a-real-flag", "log"]);
    assert.equal(unknownFlag.status, 1);
    assert.equal(unknownFlag.stdout, "");

    // An interactive/long-running command with leading flags must still be REJECTED - the
    // INTERACTIVE_OR_LONG_RUNNING_PATTERNS check runs before any flag-skipping.
    const devWithFlags = run(["rewrite", "npm", "--prefix", "./app", "run", "dev"]);
    assert.equal(devWithFlags.status, 1);
    assert.equal(devWithFlags.stdout, "");

    // npm-family global flags before `run <script>` must not break `npm run build` gating.
    const npmPrefixBuild = run(["rewrite", "npm", "--prefix", "./app", "run", "build"]);
    assert.equal(npmPrefixBuild.status, 0, npmPrefixBuild.stderr);
    assert.equal(
      npmPrefixBuild.stdout,
      `context-relay run --mode auto -- bash -lc '${"npm --prefix ./app run build"}'\n`,
    );
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
    assert.match(claudeHookCommand, /hook claude$/);
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
    assert.match(codexHookCommand, /hook codex$/);
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

  it("recognizes a legacy bare-name hook as already installed, does not duplicate it on re-init, and still uninstalls it", async () => {
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
    assert.equal(statusPayload.claude.automaticShellWrapping, true);
    assert.equal(statusPayload.codex.automaticShellWrapping, true);

    // Re-running init must not add a second, absolute-form entry alongside the legacy one.
    const reinit = run(["init", "--all"], { env });
    assert.equal(reinit.status, 0, reinit.stderr);
    const claudeSettingsAfterReinit = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeSettingsAfterReinit.hooks.PreToolUse.length, 1);
    assert.equal(
      claudeSettingsAfterReinit.hooks.PreToolUse[0].hooks[0].command,
      "context-relay hook claude",
    );
    const codexHooksAfterReinit = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexHooksAfterReinit.hooks.PreToolUse.length, 1);
    assert.equal(
      codexHooksAfterReinit.hooks.PreToolUse[0].hooks[0].command,
      "context-relay hook codex",
    );

    const uninstall = run(["uninstall", "--all"], { env });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const claudeSettingsAfterUninstall = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assert.equal(claudeSettingsAfterUninstall.hooks, undefined);
    const codexHooksAfterUninstall = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codexHooksAfterUninstall.hooks, undefined);
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

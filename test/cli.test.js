import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

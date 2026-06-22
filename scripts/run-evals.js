import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const bin = path.join(repoRoot, "bin/context-relay.js");
const storeDir = mkdtempSync(path.join(os.tmpdir(), "context-relay-eval-"));

const cases = [
  {
    id: "quickstart-log",
    description: "deterministic noisy TODO log",
    command: [process.execPath, "examples/noisy-test-log.js"],
    grep: "status=warning",
    expectExit: 0,
  },
  {
    id: "search-style-output",
    description: "large search-like result set",
    command: [
      process.execPath,
      "-e",
      "for (let i = 1; i <= 160; i++) console.log(`src/module${i % 8}/file${i}.ts:${i}:TODO item ${i} owner=agent status=${i % 13 === 0 ? 'warning' : 'ok'}`);",
    ],
    grep: "status=warning",
    expectExit: 0,
  },
  {
    id: "json-tool-output",
    description: "structured JSON tool response",
    command: [process.execPath, "examples/tool-json.js"],
    grep: "warning",
    expectExit: 0,
  },
  {
    id: "failing-log",
    description: "non-zero command with useful failure lines",
    command: [
      process.execPath,
      "-e",
      "for (let i = 1; i <= 96; i++) console.log(i % 9 === 0 ? `test${i}.spec.ts:${i}:error expected ok received fail` : `test${i}.spec.ts:${i}:passed`); process.exit(1);",
    ],
    grep: "error",
    expectExit: 1,
  },
];

const secretCase = {
  id: "secret-block",
  description: "secret-like output is blocked and not stored",
  command: [process.execPath, "-e", "console.log('api_key=abcdefghijklmnop123456')"],
};

function bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function tokens(text) {
  return Math.ceil(bytes(text) / 4);
}

function run(command, options = {}) {
  return spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: {
      ...process.env,
      CONTEXT_RELAY_STORE_DIR: storeDir,
      CONTEXT_RELAY_RUN_ID: options.runId || "eval",
    },
    encoding: "utf8",
  });
}

function runRelay(args, options = {}) {
  return run([process.execPath, bin, ...args], options);
}

function artifactId(output) {
  return output.match(/\[artifact:cr:(cr_[^ ]+)/)?.[1] || null;
}

function reduction(rawBytes, sentBytes) {
  if (rawBytes === 0) {
    return 0;
  }
  return Number(((1 - sentBytes / rawBytes) * 100).toFixed(1));
}

const evaluated = [];

for (const testCase of cases) {
  const raw = run(testCase.command, { runId: `${testCase.id}-raw` });
  const relayed = runRelay(["run", "--mode", "compress", "--", ...testCase.command], {
    runId: testCase.id,
  });
  const id = artifactId(relayed.stdout);
  const fullRetrieval = id ? runRelay(["retrieve", id], { runId: testCase.id }) : null;
  const targetedRetrieval = id ? runRelay(["retrieve", id, "--grep", testCase.grep], { runId: testCase.id }) : null;
  const rawBytes = bytes(raw.stdout);
  const summaryBytes = bytes(relayed.stdout);
  const targetedRetrievalBytes = bytes(targetedRetrieval?.stdout || "");
  evaluated.push({
    id: testCase.id,
    description: testCase.description,
    expected_exit_code: testCase.expectExit,
    raw_exit_code: raw.status,
    relayed_exit_code: relayed.status,
    raw_bytes: rawBytes,
    raw_estimated_tokens: tokens(raw.stdout),
    summary_bytes: summaryBytes,
    summary_estimated_tokens: tokens(relayed.stdout),
    targeted_retrieval_bytes: targetedRetrievalBytes,
    targeted_retrieval_estimated_tokens: tokens(targetedRetrieval?.stdout || ""),
    reduction_before_retrieval_percent: reduction(rawBytes, summaryBytes),
    reduction_after_targeted_retrieval_percent: reduction(rawBytes, summaryBytes + targetedRetrievalBytes),
    exact_retrieval: fullRetrieval?.stdout === raw.stdout,
    exit_code_preserved: relayed.status === raw.status && raw.status === testCase.expectExit,
    artifact_created: Boolean(id),
  });
}

const secret = runRelay(["run", "--mode", "compress", "--", ...secretCase.command], {
  runId: secretCase.id,
});
evaluated.push({
  id: secretCase.id,
  description: secretCase.description,
  relayed_exit_code: secret.status,
  blocked: /CR_BLOCK_SECRET/.test(secret.stdout),
  artifact_created: Boolean(artifactId(secret.stdout)),
  secret_absent_from_output: !secret.stdout.includes("abcdefghijklmnop123456"),
});

const compressionCases = evaluated.filter((entry) => "exact_retrieval" in entry);
const report = {
  generated_at: new Date().toISOString(),
  node: process.version,
  note: "Deterministic fixture evals. These are not broad task-accuracy benchmarks.",
  summary: {
    compression_cases: compressionCases.length,
    exact_retrieval_passed: compressionCases.filter((entry) => entry.exact_retrieval).length,
    exit_code_preserved_passed: compressionCases.filter((entry) => entry.exit_code_preserved).length,
    secret_block_passed: evaluated.some(
      (entry) => entry.id === "secret-block" && entry.blocked && !entry.artifact_created && entry.secret_absent_from_output,
    ),
  },
  cases: evaluated,
};

writeFileSync(path.join(repoRoot, "docs/eval-results.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log("Context Relay fixture evals");
console.log(JSON.stringify(report.summary, null, 2));
for (const entry of evaluated) {
  if ("exact_retrieval" in entry) {
    console.log(
      `${entry.id}: raw=${entry.raw_bytes}B summary=${entry.summary_bytes}B targeted=${entry.targeted_retrieval_bytes}B after_retrieval=${entry.reduction_after_targeted_retrieval_percent}% exact=${entry.exact_retrieval} exit=${entry.exit_code_preserved}`,
    );
  } else {
    console.log(`${entry.id}: blocked=${entry.blocked} artifact=${entry.artifact_created} secret_absent=${entry.secret_absent_from_output}`);
  }
}

rmSync(storeDir, { recursive: true, force: true });

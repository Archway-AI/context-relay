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
    expectTargetedMatches: 3,
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
    expectTargetedMatches: 12,
    expectExit: 0,
  },
  {
    id: "large-test-log",
    description: "large repetitive test log",
    command: [
      process.execPath,
      "-e",
      "for (let i = 1; i <= 1000; i++) console.log(`packages/app/test${i % 25}.spec.ts:${i}:${i % 13 === 0 ? 'warning flaky retry' : 'passed'} duration=${20 + (i % 17)}ms`);",
    ],
    grep: "warning flaky retry",
    expectTargetedMatches: 76,
    expectExit: 0,
  },
  {
    id: "typescript-diagnostics",
    description: "compiler diagnostics with repeated type errors",
    command: [
      process.execPath,
      "-e",
      "for (let i = 1; i <= 120; i++) console.log(i % 5 === 0 ? `src/components/View${i}.tsx:${i}:7 - error TS2322: Type 'string' is not assignable to type 'number'.` : `src/components/View${i}.tsx:${i}:7 - ok`); process.exit(2);",
    ],
    grep: "TS2322",
    expectTargetedMatches: 24,
    expectExit: 2,
  },
  {
    id: "git-diff-like-output",
    description: "large diff-like output with marked risky changes",
    command: [
      process.execPath,
      "-e",
      "for (let i = 1; i <= 220; i++) console.log(`${i % 2 === 0 ? '+' : '-'} src/file${i % 15}.ts line ${i} ${i % 29 === 0 ? 'TODO risky migration path' : 'ordinary change'}`);",
    ],
    grep: "TODO risky migration path",
    expectTargetedMatches: 7,
    expectExit: 0,
  },
  {
    id: "json-tool-output",
    description: "structured JSON tool response",
    command: [process.execPath, "examples/tool-json.js"],
    grep: "warning",
    expectTargetedMatches: 5,
    expectExit: 0,
  },
  {
    id: "large-json-tool-output",
    description: "large structured JSON tool response",
    command: [
      process.execPath,
      "-e",
      "const rows=Array.from({length:240},(_,i)=>({id:i,status:i%12===0?'warning':'ok',path:`src/file${i}.js`,tokens:100+i})); console.log(JSON.stringify({items:rows}, null, 2));",
    ],
    grep: "warning",
    expectTargetedMatches: 20,
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
    expectTargetedMatches: 10,
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

function nonEmptyLineCount(text) {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
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

function range(values) {
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
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
  const targetedRetrievalMatchCount = nonEmptyLineCount(targetedRetrieval?.stdout || "");
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
    targeted_retrieval_match_count: targetedRetrievalMatchCount,
    expected_targeted_retrieval_match_count: testCase.expectTargetedMatches,
    targeted_retrieval_passed: targetedRetrievalMatchCount === testCase.expectTargetedMatches,
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
const accuracyGatePassed = compressionCases.every(
  (entry) => entry.exact_retrieval && entry.exit_code_preserved && entry.targeted_retrieval_passed,
);
const report = {
  generated_at: new Date().toISOString(),
  node: process.version,
  note: "Deterministic fixture evals. These are not broad task-accuracy benchmarks.",
  summary: {
    compression_cases: compressionCases.length,
    exact_retrieval_passed: compressionCases.filter((entry) => entry.exact_retrieval).length,
    exit_code_preserved_passed: compressionCases.filter((entry) => entry.exit_code_preserved).length,
    targeted_retrieval_passed: compressionCases.filter((entry) => entry.targeted_retrieval_passed).length,
    accuracy_gate_passed: accuracyGatePassed,
    summary_only_reduction_percent_range: range(
      compressionCases.map((entry) => entry.reduction_before_retrieval_percent),
    ),
    after_targeted_retrieval_reduction_percent_range: range(
      compressionCases.map((entry) => entry.reduction_after_targeted_retrieval_percent),
    ),
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
      `${entry.id}: raw=${entry.raw_bytes}B summary=${entry.summary_bytes}B targeted=${entry.targeted_retrieval_bytes}B summary_only=${entry.reduction_before_retrieval_percent}% after_retrieval=${entry.reduction_after_targeted_retrieval_percent}% exact=${entry.exact_retrieval} exit=${entry.exit_code_preserved} targeted=${entry.targeted_retrieval_passed}`,
    );
  } else {
    console.log(`${entry.id}: blocked=${entry.blocked} artifact=${entry.artifact_created} secret_absent=${entry.secret_absent_from_output}`);
  }
}

rmSync(storeDir, { recursive: true, force: true });

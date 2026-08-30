import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const packageRoot = path.dirname(new URL("../package.json", import.meta.url).pathname);
const tempDirs = [];

async function copyEvalFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-relay-eval-contract-"));
  tempDirs.push(root);
  for (const entry of ["bin", "docs", "examples", "fixtures", "lib", "scripts", "package.json"]) {
    await cp(path.join(packageRoot, entry), path.join(root, entry), { recursive: true });
  }
  return root;
}

async function mutateEvalSource(root, before, after) {
  const sourcePath = path.join(root, "scripts/run-evals.js");
  const source = await readFile(sourcePath, "utf8");
  assert.ok(source.includes(before), `mutation target missing: ${before}`);
  await writeFile(sourcePath, source.replace(before, after));
}

function runEval(root) {
  return spawnSync(process.execPath, ["scripts/run-evals.js"], {
    cwd: root,
    encoding: "utf8",
  });
}

async function readReport(root) {
  return JSON.parse(await readFile(path.join(root, "docs/eval-results.json"), "utf8"));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("eval verdict contract", () => {
  it("fails the process for every failed declared predicate", async () => {
    const wrongMatchRoot = await copyEvalFixture();
    await mutateEvalSource(wrongMatchRoot, "expectTargetedMatches: 3,", "expectTargetedMatches: 4,");
    const wrongMatch = runEval(wrongMatchRoot);
    const wrongMatchReport = await readReport(wrongMatchRoot);
    assert.equal(wrongMatchReport.cases.find((entry) => entry.id === "quickstart-log").case_passed, false);
    assert.equal(wrongMatchReport.summary.suite_passed, false);
    assert.notEqual(wrongMatch.status, 0);

    const nonReducingRoot = await copyEvalFixture();
    await mutateEvalSource(
      nonReducingRoot,
      'command: [nodeCommand, "examples/noisy-test-log.js"],\n    grep: "status=warning",\n    expectTargetedMatches: 3,',
      'command: [nodeCommand, "-e", "process.stdout.write(\\"x\\")"],\n    grep: "x",\n    expectTargetedMatches: 1,',
    );
    const nonReducing = runEval(nonReducingRoot);
    const nonReducingReport = await readReport(nonReducingRoot);
    const nonReducingCase = nonReducingReport.cases.find((entry) => entry.id === "quickstart-log");
    assert.ok(nonReducingCase.reduction_before_retrieval_percent <= 0);
    assert.equal(nonReducingCase.case_passed, false);
    assert.equal(nonReducingReport.summary.suite_passed, false);
    assert.notEqual(nonReducing.status, 0);

    const failedSecretRoot = await copyEvalFixture();
    await mutateEvalSource(
      failedSecretRoot,
      'command: [nodeCommand, "-e", "console.log(\'api_key=abcdefghijklmnop123456\')"],',
      'command: [nodeCommand, "-e", "console.log(\'clean output\')"],',
    );
    const failedSecret = runEval(failedSecretRoot);
    const failedSecretReport = await readReport(failedSecretRoot);
    assert.equal(failedSecretReport.cases.find((entry) => entry.id === "secret-block").case_passed, false);
    assert.equal(failedSecretReport.summary.suite_passed, false);
    assert.notEqual(failedSecret.status, 0);
  });
});

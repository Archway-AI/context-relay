#!/usr/bin/env node
import { main } from "../lib/cli.js";

process.env.CONTEXT_RELAY_STORE_DIR ||= ".context-relay-demo";
process.env.CONTEXT_RELAY_RUN_ID ||= "demo";

main(["run", "--mode", "compress", "--", "node", "examples/noisy-test-log.js"]).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CR_ERROR: ${message}`);
  process.exitCode = 1;
});

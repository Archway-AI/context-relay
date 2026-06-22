#!/usr/bin/env node
import { main } from "../lib/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CR_ERROR: ${message}`);
  process.exitCode = 1;
});

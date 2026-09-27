import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Lint first: cheap, and catches broken imports/dead code before the suite runs.
const lint = spawnSync(
  process.execPath,
  [path.join("node_modules", "eslint", "bin", "eslint.js"), "."],
  { stdio: "inherit" }
);
if (lint.status !== 0) {
  console.error("[run-tests] eslint failed; skipping test run.");
  process.exit(lint.status ?? 1);
}

const testDir = path.join(process.cwd(), "test");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join("test", name))
  .sort();

const result = spawnSync(
  process.execPath,
  // No --test-force-exit: tests must release their handles (a leak shows up
  // as a hang here instead of being masked).
  ["--test", "--test-concurrency=1", ...files],
  {
    stdio: "inherit",
    // Keep local .env PUBLIC_BASE_URL from forcing Origin-required CSRF in
    // HTTP contract tests (browsers/smoke send Origin; bare fetch helpers don't).
    // PARTYQUEUE_ASYNC_ADDS is pinned off for the same reason: the synchronous
    // add contract is still what most queue tests assert, and since 14.0.0 the
    // flag defaults ON, so leaving it unset would fail those tests for reasons
    // that look nothing like the cause. The write-behind suite sets it itself.
    env: { ...process.env, PUBLIC_BASE_URL: "", PARTYQUEUE_ASYNC_ADDS: "0" },
  }
);
process.exit(result.status ?? 1);

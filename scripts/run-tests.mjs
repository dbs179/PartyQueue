import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testDir = path.join(process.cwd(), "test");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join("test", name))
  .sort();

const result = spawnSync(
  process.execPath,
  ["--test", "--test-force-exit", "--test-concurrency=1", ...files],
  { stdio: "inherit" }
);
process.exit(result.status ?? 1);

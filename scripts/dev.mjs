/**
 * Local dev: rebuild the client bundle on UI edits, and restart the server
 * when server files change. Soft-refresh the browser after a client rebuild
 * (index ?v= uses the bundle mtime).
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

// Ensure dist/main.js exists before the server boots.
const devEnv = { ...process.env, PQ_DEV: "1" };

const initial = spawnSync(node, ["scripts/build-client.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: devEnv,
});
if (initial.status) process.exit(initial.status ?? 1);

/** @type {import('node:child_process').ChildProcess[]} */
const kids = [];

function run(label, args) {
  const child = spawn(node, args, {
    cwd: root,
    stdio: "inherit",
    env: devEnv,
  });
  kids.push(child);
  child.on("exit", (code, signal) => {
    if (signal || shuttingDown) return;
    const status = code ?? 1;
    if (status !== 0) {
      console.error(`[dev] ${label} exited with code ${status}`);
    }
    shutdown(status);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of kids) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}

run("client", ["scripts/build-client.mjs", "--watch"]);
run("server", [
  "--watch",
  "--env-file-if-exists=.env",
  "src/server.js",
]);

// Route-parity contract: the full method + path + middleware-chain table of
// the app must match test/fixtures/route-table.json exactly. This is the
// safety net for refactors that move route registrations between modules —
// a dropped rate limiter, lost requireHost guard, or vanished route fails
// here with a readable diff. For intentional route changes, regenerate with:
//   node scripts/generate-route-table.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeTable } from "./helpers/route-table.js";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-route-parity-${process.pid}-`)
);
for (const key of [
  "SETTINGS_FILE",
  "HOST_PIN_FILE",
  "HISTORY_FILE",
  "COOLDOWN_FILE",
  "REQUESTS_FILE",
  "REACTIONS_FILE",
  "SUGGESTIONS_FILE",
  "GUESTS_FILE",
  "ORIGIN_FILE",
  "DJ_MEMORY_FILE",
]) {
  process.env[`PARTYQUEUE_${key}`] = path.join(tmpRoot, `${key}.json`);
}
process.env.SONOS_HOST = "127.0.0.1";

const { createApp } = await import("../src/server.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("registered routes and middleware chains match the checked-in table", () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "route-table.json"), "utf8")
  );
  const actual = routeTable(createApp().app);
  assert.deepEqual(actual, expected);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

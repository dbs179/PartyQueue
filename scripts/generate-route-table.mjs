// Regenerates test/fixtures/route-table.json — the route-parity contract used
// by test/route-table.test.js. Run this ONLY when a route change is
// intentional, then review the fixture diff like any other code change:
//   node scripts/generate-route-table.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-route-table-${process.pid}-`)
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
const { routeTable } = await import("../test/helpers/route-table.js");

const rows = routeTable(createApp().app);
const outFile = path.join("test", "fixtures", "route-table.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(rows, null, 2) + "\n");
console.log(`Wrote ${rows.length} routes to ${outFile}`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(0);

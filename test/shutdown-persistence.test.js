import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HISTORY_FILE = path.join(
  os.tmpdir(),
  `pq-shutdown-history-${process.pid}-${Date.now()}.json`
);
const COOLDOWN_FILE = path.join(
  os.tmpdir(),
  `pq-shutdown-cooldown-${process.pid}-${Date.now()}.json`
);

process.env.PARTYQUEUE_HISTORY_FILE = HISTORY_FILE;
process.env.PARTYQUEUE_COOLDOWN_FILE = COOLDOWN_FILE;

after(() => {
  fs.rmSync(HISTORY_FILE, { force: true });
  fs.rmSync(COOLDOWN_FILE, { force: true });
  delete process.env.PARTYQUEUE_HISTORY_FILE;
  delete process.env.PARTYQUEUE_COOLDOWN_FILE;
});

test("shutdown flush preserves history that was never loaded", async () => {
  const existing = [{ id: "track-1", artist: "Artist", name: "Song" }];
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(existing));

  const { flushHistoryPersist } = await import("../src/play-history.js");
  assert.equal(flushHistoryPersist(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")), existing);
});

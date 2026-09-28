import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lastSuccessFor,
  noteFailure,
  noteSuccess,
  recentFailures,
  resetFailureLogForTests,
} from "../src/failure-log.js";

test("failure ring keeps the latest events and throttles a noisy scope", () => {
  resetFailureLogForTests();
  const t0 = 1_700_000_000_000;
  assert.equal(noteFailure("spotify", "HTTP 429", { now: t0 }), true);
  assert.equal(
    noteFailure("spotify", "HTTP 429 again", { now: t0 + 1_000 }),
    false,
    "same scope inside 15s is dropped"
  );
  assert.equal(noteFailure("sonos", "read failed", { now: t0 + 1_000 }), true);
  noteSuccess("spotify", t0 + 2_000);

  const rows = recentFailures();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scope, "spotify");
  assert.equal(rows[1].scope, "sonos");
  assert.equal(lastSuccessFor("spotify"), t0 + 2_000);
  resetFailureLogForTests();
});

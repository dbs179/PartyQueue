import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-pending-${process.pid}-${Date.now()}.json`
);

let store;

async function freshImport() {
  return import(`../src/pending-adds.js?t=${Date.now()}-${Math.random()}`);
}

function sample(overrides = {}) {
  return {
    uri: "spotify:track:abc123",
    name: "Nine Ball",
    artist: "The Cadence",
    requestedBy: "Dave",
    requestedByUser: "Dave",
    ...overrides,
  };
}

beforeEach(async () => {
  process.env.PARTYQUEUE_PENDING_ADDS_FILE = TMP_FILE;
  try {
    fs.unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
  store = await freshImport();
});

afterEach(() => {
  try {
    fs.unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
  delete process.env.PARTYQUEUE_PENDING_ADDS_FILE;
});

test("an add is durable before it is acknowledged", async () => {
  store.addPending(sample());

  // A crash right here must not lose the song: re-read from disk only.
  const reloaded = await freshImport();
  const rows = reloaded.listPendingAdds();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Nine Ball");
  assert.equal(rows[0].state, "pending");
});

test("derives the Spotify track id from the uri", () => {
  const entry = store.addPending(sample());
  assert.equal(entry.trackId, "abc123");
});

test("placeable entries come back oldest first", () => {
  store.addPending(sample({ uri: "spotify:track:one", name: "One" }));
  store.addPending(sample({ uri: "spotify:track:two", name: "Two" }));
  store.addPending(sample({ uri: "spotify:track:three", name: "Three" }));

  assert.deepEqual(
    store.listPlaceable().map((e) => e.name),
    ["One", "Two", "Three"]
  );
});

test("claiming hides an entry from other workers without losing it", () => {
  store.addPending(sample());

  const claimed = store.claimNextPending();
  assert.ok(claimed);
  assert.equal(claimed.attempts, 1);
  assert.equal(store.claimNextPending(), null);
  assert.equal(store.listPendingAdds().length, 1);
});

test("releasing a claim puts the entry back in line", () => {
  store.addPending(sample());
  const claimed = store.claimNextPending();

  store.releasePlacing(claimed.id);

  assert.equal(store.listPlaceable().length, 1);
});

test("confirming placement retires the entry so it cannot be resurrected", () => {
  const entry = store.addPending(sample());

  const placed = store.markPlaced(entry.id);

  assert.equal(placed.state, "placed");
  assert.equal(store.listPendingAdds().length, 0);
  assert.equal(store.getPendingAdd(entry.id), null);
});

test("a placing claim does not survive a restart", async () => {
  const entry = store.addPending(sample());
  store.claimNextPending();

  const reloaded = await freshImport();

  // The drainer died mid-placement; the entry must be eligible again, and the
  // true-up is what stops it becoming a duplicate.
  const placeable = reloaded.listPlaceable();
  assert.equal(placeable.length, 1);
  assert.equal(placeable[0].id, entry.id);
});

test("entries from a previous party are dropped on load", async () => {
  const stale = {
    id: "old-1",
    uri: "spotify:track:lastnight",
    trackId: "lastnight",
    name: "Last Night",
    state: "pending",
    createdAt: Date.now() - 7 * 60 * 60_000,
    updatedAt: Date.now() - 7 * 60 * 60_000,
  };
  fs.writeFileSync(TMP_FILE, JSON.stringify([stale]), "utf8");

  const reloaded = await freshImport();

  assert.equal(reloaded.listPendingAdds().length, 0);
});

test("a restart during the party keeps pending entries", async () => {
  const recent = {
    id: "live-1",
    uri: "spotify:track:tonight",
    trackId: "tonight",
    name: "Tonight",
    state: "pending",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
  };
  fs.writeFileSync(TMP_FILE, JSON.stringify([recent]), "utf8");

  const reloaded = await freshImport();

  assert.equal(reloaded.listPendingAdds().length, 1);
});

test("finds this guest's live entry so repeat taps stay idempotent", () => {
  store.addPending(sample({ requestedByUser: "Dave" }));

  assert.ok(store.findPendingForGuest("Dave", "abc123"));
  assert.ok(store.findPendingForGuest("dave", "abc123"), "match is case-insensitive");
  assert.equal(store.findPendingForGuest("Maria", "abc123"), null);
  assert.equal(store.findPendingForGuest("Dave", "other"), null);
});

test("pending entries read as searched queue rows for fairness", () => {
  store.addPending(sample({ requestedByUser: "Dave", requestedBy: "Big Dave" }));

  const [row] = store.pendingAsQueueRows();

  assert.equal(row.searched, true);
  assert.equal(row.setRequest, false);
  assert.equal(row.requestedByUser, "Dave");
  assert.equal(row.uri, "spotify:track:abc123");
  assert.equal(row.pending, true);
});

test("a failed entry stays visible and stops being placeable", () => {
  const entry = store.addPending(sample());

  store.markFailed(entry.id, "Sonos said no");

  assert.equal(store.listPlaceable().length, 0);
  const [row] = store.listPendingAdds();
  assert.equal(row.state, "failed");
  assert.equal(row.lastError, "Sonos said no");
});

test("a failed entry no longer counts against fairness quota", () => {
  const entry = store.addPending(sample());
  assert.equal(store.pendingAsQueueRows().length, 1);

  store.markFailed(entry.id, "nope");

  assert.equal(store.pendingAsQueueRows().length, 0);
});

test("retry puts a failed entry back in line with a clean slate", () => {
  const entry = store.addPending(sample());
  store.claimNextPending();
  store.markFailed(entry.id, "nope");

  const res = store.retryPendingAdd(entry.id, { user: "Dave" });

  assert.equal(res.ok, true);
  assert.equal(res.entry.state, "pending");
  assert.equal(res.entry.attempts, 0);
  assert.equal(res.entry.lastError, null);
  assert.equal(store.listPlaceable().length, 1);
});

test("only the requester can retry their song", () => {
  const entry = store.addPending(sample({ requestedByUser: "Dave" }));
  store.markFailed(entry.id, "nope");

  const res = store.retryPendingAdd(entry.id, { user: "Maria" });

  assert.equal(res.ok, false);
  assert.equal(store.listPlaceable().length, 0);
});

test("recording an attempt error leaves the entry retryable", () => {
  const entry = store.addPending(sample());
  store.claimNextPending();

  store.recordAttemptError(entry.id, "timed out");

  const [row] = store.listPendingAdds();
  assert.equal(row.state, "pending");
  assert.equal(row.lastError, "timed out");
  assert.equal(store.listPlaceable().length, 1, "claim released for another pass");
});

test("clearing drops every waiting add so none repopulate the queue", () => {
  store.addPending(sample({ uri: "spotify:track:one" }));
  store.addPending(sample({ uri: "spotify:track:two" }));

  const removed = store.clearPendingAdds();

  assert.equal(removed, 2);
  assert.deepEqual(store.listPendingAdds(), []);
});

test("failed rows age out but pending rows never do", () => {
  const keep = store.addPending(sample({ uri: "spotify:track:keep" }));
  const drop = store.addPending(sample({ uri: "spotify:track:drop" }));
  store.markFailed(drop.id, "nope");

  const removed = store.expireFailedAdds(-1);

  assert.equal(removed, 1);
  assert.deepEqual(
    store.listPendingAdds().map((e) => e.id),
    [keep.id]
  );
});

test("the store stays bounded under a wedged speaker", () => {
  for (let i = 0; i < 320; i++) {
    store.addPending(sample({ uri: `spotify:track:t${i}` }));
  }

  const rows = store.listPendingAdds();
  assert.equal(rows.length, 300);
  // Oldest evicted first, so the newest adds survive.
  assert.equal(rows[rows.length - 1].uri, "spotify:track:t319");
});

/**
 * queue-view imports pending-adds directly, so both must come from the same
 * module instance — the cache-busted `store` used elsewhere in this file is a
 * different copy with its own in-memory entries.
 */
async function sharedStoreAndView() {
  const shared = await import("../src/pending-adds.js");
  const view = await import("../src/queue-view.js");
  shared.resetPendingAddsCache();
  shared.clearPendingAdds();
  return { shared, view };
}

test("write-behind adds are on unless explicitly switched off", async () => {
  const { asyncAddsEnabled } = await import("../src/async-adds.js");
  const previous = process.env.PARTYQUEUE_ASYNC_ADDS;
  try {
    // 14.0.0 flipped the default. Only an explicit "0" goes back to the
    // synchronous path, so an unset or empty variable must not disable it.
    delete process.env.PARTYQUEUE_ASYNC_ADDS;
    assert.equal(asyncAddsEnabled(), true);
    process.env.PARTYQUEUE_ASYNC_ADDS = "1";
    assert.equal(asyncAddsEnabled(), true);
    process.env.PARTYQUEUE_ASYNC_ADDS = "0";
    assert.equal(asyncAddsEnabled(), false);
  } finally {
    process.env.PARTYQUEUE_ASYNC_ADDS = previous ?? "0";
  }
});

test("the feature flag is a real kill switch for the queue view", async () => {
  const { shared, view } = await sharedStoreAndView();
  shared.addPending(sample());

  // Flag off: rolling back must not leave a stale store painting songs that
  // nothing is going to place.
  process.env.PARTYQUEUE_ASYNC_ADDS = "0";
  assert.deepEqual(view.pendingViewRows(), []);
  assert.deepEqual(view.buildQueuePayload([{ uri: "spotify:track:live" }]).tracks, [
    { uri: "spotify:track:live" },
  ]);

  process.env.PARTYQUEUE_ASYNC_ADDS = "1";
  try {
    const rows = view.pendingViewRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pending, true);
    assert.equal(rows[0].title, "Nine Ball");
  } finally {
    process.env.PARTYQUEUE_ASYNC_ADDS = "0";
  }
});

test("a song being placed is not shown twice once it reaches Sonos", async () => {
  const { shared, view } = await sharedStoreAndView();
  const entry = shared.addPending(sample());
  // claimPending is what the drainer holds while AddURIToQueue is in flight.
  shared.claimPending(entry.id);
  const liveRow = { uri: sample().uri, id: shared.listPendingAdds()[0].trackId };

  process.env.PARTYQUEUE_ASYNC_ADDS = "1";
  try {
    assert.deepEqual(
      view.buildQueuePayload([liveRow]).tracks,
      [liveRow],
      "the Sonos row alone - the outbox copy would read as a duplicate"
    );

    // Still worth showing while the speaker has not taken it yet.
    assert.equal(view.pendingViewRows([]).length, 1);
    assert.equal(view.pendingViewRows([{ uri: "spotify:track:other" }]).length, 1);
  } finally {
    process.env.PARTYQUEUE_ASYNC_ADDS = "0";
    shared.clearPendingAdds();
  }
});

test("an add still waiting its turn is shown even if that song is queued", async () => {
  const { shared, view } = await sharedStoreAndView();
  // No claim: nobody is placing this one, so a copy already in the queue is
  // somebody else's add and must not hide this guest's request.
  shared.addPending(sample());
  const liveRow = { uri: sample().uri, id: shared.listPendingAdds()[0].trackId };

  process.env.PARTYQUEUE_ASYNC_ADDS = "1";
  try {
    const rows = view.pendingViewRows([liveRow]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pending, true);
  } finally {
    process.env.PARTYQUEUE_ASYNC_ADDS = "0";
    shared.clearPendingAdds();
  }
});

test("failed rows reach the view with their reason", async () => {
  const { shared, view } = await sharedStoreAndView();
  const entry = shared.addPending(sample());
  shared.markFailed(entry.id, "Sonos timeout");

  process.env.PARTYQUEUE_ASYNC_ADDS = "1";
  try {
    const [row] = view.pendingViewRows();
    assert.equal(row.failed, true);
    assert.equal(row.pending, false);
    assert.equal(row.pendingId, entry.id);
    // The raw Sonos error carries speaker IPs and SOAP URLs, so guests get a
    // fixed message and the detail stays on the entry for the log.
    assert.equal(row.failedReason, view.GUEST_FAILURE_REASON);
    assert.doesNotMatch(row.failedReason, /Sonos timeout/);
    assert.equal(shared.listPendingAdds()[0].lastError, "Sonos timeout");
  } finally {
    process.env.PARTYQUEUE_ASYNC_ADDS = "0";
    shared.clearPendingAdds();
  }
});

test("a corrupt store file degrades to empty instead of throwing", async () => {
  fs.writeFileSync(TMP_FILE, "{ not json", "utf8");

  const reloaded = await freshImport();

  assert.deepEqual(reloaded.listPendingAdds(), []);
  assert.doesNotThrow(() => reloaded.addPending(sample()));
});

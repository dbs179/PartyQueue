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
  store?.resetPendingAddsCache?.();
  try {
    fs.unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
  delete process.env.PARTYQUEUE_PENDING_ADDS_FILE;
});

test("an add is durable before it is acknowledged", async () => {
  store.addPending(sample());
  await store.whenPendingAddsDurable();

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

test("a placed entry is kept for display but can never be placed again", () => {
  const entry = store.addPending(sample());

  const placed = store.markPlaced(entry.id);

  // Kept, because deleting it here makes the song vanish off every phone until
  // Sonos gets round to showing the row.
  assert.equal(placed.state, "placed");
  assert.equal(store.getPendingAdd(entry.id).state, "placed");

  // ...but nothing can turn it back into work.
  assert.deepEqual(store.listPlaceable(), []);
  assert.equal(store.claimPending(entry.id), null);
  assert.equal(store.retryPendingAdd(entry.id).ok, false);
});

test("a song handed to the speaker is charged once, never twice or not at all", () => {
  const entry = store.addPending(sample());
  store.markPlaced(entry.id);

  // Sonos has not surfaced the row yet, so our copy is the only thing stopping
  // the guest slipping an extra song past their cap during the handover.
  assert.equal(store.pendingAsQueueRows([]).length, 1);

  // Once the row really is there, counting both would block them a song early.
  assert.deepEqual(
    store.pendingAsQueueRows([{ id: entry.trackId, uri: entry.uri }]),
    []
  );
});

test("a placed entry is retired once Sonos confirms the song", () => {
  const entry = store.addPending(sample());
  store.markPlaced(entry.id);

  assert.ok(store.retirePlacedAdd(entry.id));
  assert.equal(store.getPendingAdd(entry.id), null);
  // Only placed entries: a waiting add must not be silently dropped.
  const waiting = store.addPending(sample());
  assert.equal(store.retirePlacedAdd(waiting.id), null);
  assert.equal(store.getPendingAdd(waiting.id).state, "pending");
});

test("a placed entry the speaker never confirms is not drawn forever", async () => {
  const entry = store.addPending(sample());
  store.markPlaced(entry.id);

  assert.equal(store.expirePlacedAdds(60_000), 0, "still inside the window");
  await store.whenPendingAddsDurable();
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  raw.find((row) => row.id === entry.id).placedAt = Date.now() - 60_000;
  fs.writeFileSync(TMP_FILE, JSON.stringify(raw), "utf8");
  store.resetPendingAddsCache();

  assert.equal(store.expirePlacedAdds(1000), 1);
  assert.equal(store.listPendingAdds().length, 0);
  await store.whenPendingAddsDurable();
});

test("a placing claim does not survive a restart", async () => {
  const entry = store.addPending(sample());
  await store.whenPendingAddsDurable();
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

test("attempt bookkeeping is coalesced but not lost on shutdown", async () => {
  const entry = store.addPending(sample());
  await store.whenPendingAddsDurable();
  const onDisk = () => JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.equal(onDisk().length, 1, "the add itself is written through");

  store.claimPending(entry.id);
  assert.equal(onDisk()[0].attempts, 0, "the attempt counter can wait");

  store.flushPendingAdds();
  assert.equal(onDisk()[0].attempts, 1, "but it still survives a shutdown");
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

test("failed rows age out but pending rows never do", async () => {
  const keep = store.addPending(sample({ uri: "spotify:track:keep" }));
  const drop = store.addPending(sample({ uri: "spotify:track:drop" }));
  store.markFailed(drop.id, "nope");
  await store.whenPendingAddsDurable();
  // Backdate on disk. A same-millisecond expire used to pass on Windows, where
  // the sync write crossed the clock, and fail on Ubuntu CI, where it did not.
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  raw.find((row) => row.id === drop.id).failedAt = Date.now() - 60_000;
  fs.writeFileSync(TMP_FILE, JSON.stringify(raw), "utf8");
  store.resetPendingAddsCache();

  const removed = store.expireFailedAdds(1000);

  assert.equal(removed, 1);
  assert.deepEqual(
    store.listPendingAdds().map((e) => e.id),
    [keep.id]
  );
  await store.whenPendingAddsDurable();
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

test("making room drops a shadow row before a guest's waiting song", () => {
  const waiting = store.addPending(sample({ uri: "spotify:track:waiting" }));
  const shadow = store.addPending(sample({ uri: "spotify:track:shadow" }));
  store.markPlaced(shadow.id);
  for (let i = 0; i < 298; i++) {
    store.addPending(sample({ uri: `spotify:track:t${i}` }));
  }

  store.addPending(sample({ uri: "spotify:track:newest" }));

  const ids = store.listPendingAdds().map((e) => e.id);
  assert.equal(ids.length, 300);
  assert.ok(ids.includes(waiting.id), "nobody's request is thrown away first");
  assert.ok(!ids.includes(shadow.id), "the song already on the speaker went");
});

test("making room never drops the song being placed right now", () => {
  const first = store.addPending(sample({ uri: "spotify:track:first" }));
  // The drainer always claims the oldest, which is also the eviction target.
  store.claimPending(first.id);
  for (let i = 0; i < 300; i++) {
    store.addPending(sample({ uri: `spotify:track:t${i}` }));
  }

  const ids = store.listPendingAdds().map((e) => e.id);
  assert.equal(ids.length, 300);
  assert.ok(ids.includes(first.id), "still in the store while it is in flight");
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
  await shared.whenPendingAddsDurable();
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
    await shared.whenPendingAddsDurable();
  }
});

test("a placed song keeps its row until Sonos actually shows it", async () => {
  const { shared, view } = await sharedStoreAndView();
  const entry = shared.addPending(sample());
  shared.markPlaced(entry.id);
  const trackId = shared.listPendingAdds()[0].trackId;

  process.env.PARTYQUEUE_ASYNC_ADDS = "1";
  try {
    // Sonos has not surfaced the row yet. Dropping ours here is what made the
    // song blink out of the list and invited the guest to add it again.
    const [row] = view.pendingViewRows([]);
    assert.equal(row.pending, true, "still reads as landing, so it cannot be reordered");
    assert.equal(row.failed, false);

    // The moment the real row shows up, ours gets out of the way.
    assert.deepEqual(view.pendingViewRows([{ uri: sample().uri, id: trackId }]), []);
  } finally {
    process.env.PARTYQUEUE_ASYNC_ADDS = "0";
    shared.clearPendingAdds();
    await shared.whenPendingAddsDurable();
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
    await shared.whenPendingAddsDurable();
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
    await shared.whenPendingAddsDurable();
  }
});

test("a burst of adds shares one write of the outbox", async () => {
  const original = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (...args) => {
    writes += 1;
    return original.apply(fs, args);
  };
  try {
    store.addPending(sample({ uri: "spotify:track:one", name: "One" }));
    store.addPending(sample({ uri: "spotify:track:two", name: "Two" }));
    assert.equal(writes, 0, "neither add blocks on its own write");
    await store.whenPendingAddsDurable();
    const rows = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
    assert.equal(writes, 1);
    assert.deepEqual(
      rows.map((row) => row.name),
      ["One", "Two"]
    );
  } finally {
    fs.writeFileSync = original;
  }
});

test("a corrupt store file degrades to empty instead of throwing", async () => {
  fs.writeFileSync(TMP_FILE, "{ not json", "utf8");

  const reloaded = await freshImport();

  assert.deepEqual(reloaded.listPendingAdds(), []);
  assert.doesNotThrow(() => reloaded.addPending(sample()));
});

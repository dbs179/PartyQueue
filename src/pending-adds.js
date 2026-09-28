// Outbox of guest adds that Sonos has not confirmed yet.
//
// POST /api/queue used to hold the guest's phone open until the speaker
// answered. On a bad night that meant 28-second "Adding..." buttons. Now the
// request is recorded here, acknowledged immediately, and placed on the speaker
// by add-drainer.js off the request path.
//
// This is an OUTBOX, not a mirror of the Sonos queue. It only ever holds adds
// we have not confirmed landed, and the reconciler's only power is to place
// something that was never placed. It never removes a song from Sonos.
//
// That distinction matters because PartyQueue removes songs from the Sonos
// queue itself - queue-maintenance.js trims them once they have played, the
// host skips, Clear Queue wipes the lot. So "in our list but not in Sonos"
// does NOT mean "the add failed"; most of the time it means "already played".
// A store that tried to mirror the queue would fight its own trim loop and
// resurrect songs the party already heard.
//
// Confirmation is therefore one-way: a placed entry can never become placeable
// again. It is kept only long enough to stay on screen while Sonos catches up
// (see markPlaced), and the true-up drops it the moment the real row appears.
//
// Persisted states are "pending", "placed" and "failed". "placing" is
// deliberately in-memory: if the process dies mid-placement the entry reverts
// to pending on boot, and the true-up in queue-maintenance.js suppresses the
// duplicate by checking the live queue before re-placing.
//
// Honors PARTYQUEUE_PENDING_ADDS_FILE to point the store elsewhere (tests).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomic-write.js";
import { spotifyTrackId } from "./sampler.js";
import { sanitizeDedication, sanitizeDisplayName } from "./display-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE =
  process.env.PARTYQUEUE_PENDING_ADDS_FILE ||
  path.join(__dirname, "..", "data", "pending-adds.json");

// Cap so a wedged speaker plus an enthusiastic room can't grow the file without
// bound. Far more than any party queues in one night.
const MAX = 300;

// Entries older than this are from a previous party. Dropped on load so a
// morning restart never re-adds last night's songs; a restart DURING a party is
// well inside the window and drains normally.
const STALE_MS = 6 * 60 * 60_000;

/** @type {object[]|null} */
let entries = null;

// In-memory placement claims (entry id -> true). Not persisted: see header.
const placing = new Set();

function nowMs() {
  return Date.now();
}

function cleanText(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const uri = cleanText(raw.uri);
  if (!uri) return null;
  const state =
    raw.state === "failed" || raw.state === "placed" ? raw.state : "pending";
  const createdAt = Number(raw.createdAt) || 0;
  if (!createdAt) return null;
  return {
    id: cleanText(raw.id) || randomUUID(),
    uri,
    trackId: cleanText(raw.trackId) || spotifyTrackId(uri) || null,
    name: cleanText(raw.name),
    artist: cleanText(raw.artist),
    requestedBy: sanitizeDisplayName(raw.requestedBy),
    requestedByUser: sanitizeDisplayName(raw.requestedByUser),
    alias: sanitizeDisplayName(raw.alias),
    dedication: sanitizeDedication(raw.dedication),
    force: !!raw.force,
    state,
    attempts: Math.max(0, Math.floor(Number(raw.attempts) || 0)),
    lastError: cleanText(raw.lastError),
    failedAt: Number(raw.failedAt) || 0,
    placedAt: Number(raw.placedAt) || 0,
    // Only meaningful within one process lifetime; Clear Queue / Party's Over
    // bump the generation to cancel work that predates them.
    preemptGeneration: Number(raw.preemptGeneration) || 0,
    createdAt,
    updatedAt: Number(raw.updatedAt) || createdAt,
  };
}

function load() {
  if (entries) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    const cutoff = nowMs() - STALE_MS;
    entries = Array.isArray(raw)
      ? raw
          .map(normalizeEntry)
          .filter((e) => e && e.createdAt >= cutoff)
      : [];
  } catch {
    entries = [];
  }
  // A restart cannot leave anything mid-placement: that claim lived in memory.
  placing.clear();
}

// Retry bookkeeping - the attempt counter and the last error - changes several
// times per song and none of it is worth its own write. Losing a second of it
// to a crash costs one redundant placement attempt, which the true-up already
// makes safe.
//
// Song-list changes share one write of this file. A burst of adds updates
// memory immediately and waits on the same snapshot, so the event loop takes
// one sync write instead of one per tap. The HTTP ack awaits
// whenPendingAddsDurable() and does not answer until that snapshot is on disk.
const BOOKKEEPING_DEBOUNCE_MS = 1000;
let bookkeepingTimer = null;
let writeTimer = null;
let writeNeeded = false;
let resolveDurable = null;
let durablePromise = Promise.resolve();

function cancelBookkeepingWrite() {
  if (!bookkeepingTimer) return;
  clearTimeout(bookkeepingTimer);
  bookkeepingTimer = null;
}

function cancelQueuedWrite() {
  if (!writeTimer) return;
  clearImmediate(writeTimer);
  writeTimer = null;
}

function writeSnapshot() {
  if (entries == null) return;
  writeFileAtomic(STORE_FILE, JSON.stringify(entries));
}

function finishDurableWrite() {
  const resolve = resolveDurable;
  resolveDurable = null;
  writeTimer = null;
  const needed = writeNeeded;
  writeNeeded = false;
  try {
    if (needed) writeSnapshot();
  } catch (err) {
    console.error("[pending-adds] save failed:", err.message);
  }
  resolve?.();
}

/**
 * Queue one write of the latest entries. Further calls before it runs join
 * the same snapshot. Resolves even when the write fails: the song is already
 * in memory, and a disk error must not hang the ack.
 */
function armDurableWrite() {
  writeNeeded = true;
  if (writeTimer) return durablePromise;
  durablePromise = new Promise((resolve) => {
    resolveDurable = resolve;
  });
  writeTimer = setImmediate(finishDurableWrite);
  return durablePromise;
}

/** Wait until the newest queued snapshot has been written. Already settled if nothing is queued. */
export function whenPendingAddsDurable() {
  return durablePromise;
}

/** Song-list changes. Durable before the HTTP ack, which awaits whenPendingAddsDurable(). */
function persist() {
  cancelBookkeepingWrite();
  armDurableWrite();
}

/** Coalesce attempt bookkeeping - see BOOKKEEPING_DEBOUNCE_MS. */
function persistSoon() {
  // A song-list write is already queued and reads entries when it runs, so
  // this attempt counter rides along instead of starting its own write.
  if (bookkeepingTimer || writeTimer) return;
  bookkeepingTimer = setTimeout(() => {
    bookkeepingTimer = null;
    armDurableWrite();
  }, BOOKKEEPING_DEBOUNCE_MS);
  bookkeepingTimer.unref?.();
}

/**
 * Flush a queued song-list or bookkeeping write. Called on shutdown, so it
 * writes now instead of waiting for the timer.
 */
export function flushPendingAdds() {
  const bookkeeping = !!bookkeepingTimer;
  cancelBookkeepingWrite();
  if (!bookkeeping && !writeNeeded) return;
  writeNeeded = true;
  cancelQueuedWrite();
  finishDurableWrite();
}

/** Public shape handed to routes and the drainer (never the live object). */
function snapshot(entry) {
  return { ...entry, placing: placing.has(entry.id) };
}

function sameUser(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// Cheapest rows to lose first. A "placed" entry is a shadow of a song already
// sitting on the speaker, a "failed" one is a notice the guest has probably
// read, and only a "pending" entry is a song nobody has heard yet.
const EVICTION_ORDER = ["placed", "failed", "pending"];

/**
 * Make room for one new add. Evicting the oldest row outright could throw away
 * a guest's waiting request while display-only leftovers survived it.
 */
function evictOne() {
  for (const state of EVICTION_ORDER) {
    // The drainer always takes the oldest pending entry, so without the placing
    // check the likeliest row to be evicted is the one being placed right now.
    const at = entries.findIndex(
      (e) => e.state === state && !placing.has(e.id)
    );
    if (at !== -1) {
      entries.splice(at, 1);
      return;
    }
  }
  entries.shift();
}

/**
 * Record a guest add. Durable before we acknowledge, so a crash between the
 * ack and placement still plays the song.
 *
 * @param {{
 *   uri: string, name?: string|null, artist?: string|null,
 *   requestedBy?: string|null, requestedByUser?: string|null,
 *   alias?: string|null, dedication?: string|null,
 *   force?: boolean, preemptGeneration?: number,
 * }} input
 * @returns {object} the stored entry
 */
export function addPending(input) {
  load();
  const ts = nowMs();
  const entry = normalizeEntry({ ...input, state: "pending", createdAt: ts, updatedAt: ts });
  if (!entry) throw new Error("Missing track uri.");
  entries.push(entry);
  while (entries.length > MAX) evictOne();
  persist();
  return snapshot(entry);
}

/** Every live entry (pending + failed) in creation order. */
export function listPendingAdds() {
  load();
  return entries.map(snapshot);
}

/** Pending-only, oldest first — the order guests tapped Add. */
export function listPlaceable() {
  load();
  return entries
    .filter((e) => e.state === "pending" && !placing.has(e.id))
    .map(snapshot);
}

export function getPendingAdd(id) {
  load();
  const entry = entries.find((e) => e.id === id);
  return entry ? snapshot(entry) : null;
}

/**
 * Store a dedication on this guest's outbox row.
 *
 * The add toast offers Dedicate before Sonos has the song, and the origin
 * store is only written at placement. Without this, that tap is rejected.
 * Placement reads the row again, so the note still reaches the DJ.
 *
 * @returns {object|null} the updated entry, or null when this guest has no
 *   pending or placed row for the track
 */
export function setPendingDedication(trackId, dedication, { user = null } = {}) {
  load();
  if (!trackId || !user) return null;
  let entry = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i];
    if (candidate.trackId !== trackId) continue;
    if (candidate.state !== "pending" && candidate.state !== "placed") continue;
    if (!sameUser(candidate.requestedByUser || candidate.requestedBy, user)) continue;
    entry = candidate;
    break;
  }
  if (!entry) return null;
  entry.dedication = sanitizeDedication(dedication);
  entry.updatedAt = nowMs();
  persist();
  return snapshot(entry);
}

/**
 * This guest's live entry for a track, used to make repeat taps idempotent the
 * same way an upcoming Sonos row does.
 *
 * "placed" counts too. That row is the shadow we keep on screen until Sonos
 * Browse catches up; treating it as gone is what made a phone retry add the
 * song a second time. "failed" does not count — Retry has to be able to run.
 */
export function findPendingForGuest(user, trackId) {
  load();
  if (!user || !trackId) return null;
  const entry = entries.find(
    (e) =>
      e.trackId === trackId &&
      (e.state === "pending" || e.state === "placed") &&
      sameUser(e.requestedByUser || e.requestedBy, user)
  );
  return entry ? snapshot(entry) : null;
}

/**
 * Outbox entries as queue-shaped rows so evaluateRequestFairness() can count
 * them without a live Sonos read. Quota is consumed at acknowledgement, which
 * is why markFailed() refunds it - a failed entry is not counted here.
 *
 * `liveRows` is the queue these are counted alongside, and it has to be passed
 * for the same reason pendingViewRows() needs it. A song we have handed to the
 * speaker must keep counting until the Sonos row appears, or for those few
 * seconds it is counted nowhere and a guest can slip one past their cap; but
 * once the row IS visible, counting our copy too would charge them twice and
 * block them a song early. Only one of the pair is ever live.
 */
export function pendingAsQueueRows(liveRows = []) {
  load();
  const live = new Set();
  for (const row of liveRows) {
    const id = row?.id || spotifyTrackId(row?.uri);
    if (id) live.add(id);
  }
  const counts = (e) => {
    if (e.state === "failed") return false;
    const handedOver = placing.has(e.id) || e.state === "placed";
    return !(handedOver && e.trackId && live.has(e.trackId));
  };
  return entries
    .filter(counts)
    .map((e) => ({
      uri: e.uri,
      id: e.trackId,
      title: e.name,
      name: e.name,
      artist: e.artist,
      searched: true,
      setRequest: false,
      requestedBy: e.requestedBy,
      requestedByUser: e.requestedByUser,
      dedication: e.dedication,
      pending: true,
    }));
}

/** Claim the oldest pending entry for placement. In-memory only, by design. */
export function claimNextPending() {
  load();
  const entry = entries.find((e) => e.state === "pending" && !placing.has(e.id));
  return entry ? claimPending(entry.id) : null;
}

/**
 * Claim one specific entry. The drainer picks which entry is due (it owns the
 * retry backoff); the store only guarantees two workers can't hold the same one.
 */
export function claimPending(id) {
  load();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.state !== "pending" || placing.has(entry.id)) return null;
  placing.add(entry.id);
  entry.attempts += 1;
  entry.updatedAt = nowMs();
  persistSoon();
  return snapshot(entry);
}

/** Release a claim without resolving the entry (it stays pending). */
export function releasePlacing(id) {
  placing.delete(id);
}

/**
 * Confirm placement. The entry stops being placeable immediately, but it is
 * kept - not deleted - until a live Sonos read actually shows the song.
 *
 * Deleting here used to make the song vanish off every phone for a few seconds:
 * AddURIToQueue returning and getQueueList surfacing the new row are not the
 * same instant, so between the two there was nothing to render. A song that
 * disappears invites the guest to add it again, which is the duplicate this
 * whole store exists to prevent.
 *
 * "placed" is display-only and cannot be resurrected: listPlaceable() ignores
 * it, retryPendingAdd() refuses it, and it consumes no fairness quota. The
 * true-up deletes it once the speaker confirms the song, expirePlacedAdds()
 * if the speaker never does.
 *
 * @returns {object|null} the placed entry, or null if it was already gone
 */
export function markPlaced(id) {
  load();
  placing.delete(id);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.state = "placed";
  entry.placedAt = nowMs();
  entry.updatedAt = entry.placedAt;
  persist();
  return snapshot(entry);
}

/** Drop a placed entry once Sonos has confirmed the song (see add-trueup.js). */
export function retirePlacedAdd(id) {
  load();
  const at = entries.findIndex((e) => e.id === id && e.state === "placed");
  if (at === -1) return null;
  const [entry] = entries.splice(at, 1);
  persist();
  return entry;
}

/**
 * Backstop for placed entries the speaker never confirmed - the song played and
 * was trimmed before a true-up saw it, or the host removed it. Without this a
 * shadow row could sit on the TV all night.
 */
export function expirePlacedAdds(maxAgeMs) {
  load();
  const cutoff = nowMs() - Math.max(0, Number(maxAgeMs) || 0);
  const before = entries.length;
  entries = entries.filter((e) => e.state !== "placed" || e.placedAt >= cutoff);
  const removed = before - entries.length;
  if (removed) persist();
  return removed;
}

/**
 * Give up on an entry. It stays visible so the guest learns the truth instead
 * of waiting for a song that is never coming; callers refund fairness quota.
 */
export function markFailed(id, error) {
  load();
  placing.delete(id);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.state = "failed";
  entry.lastError = cleanText(error) || "Could not add to the Sonos queue.";
  entry.failedAt = nowMs();
  entry.updatedAt = entry.failedAt;
  persist();
  return snapshot(entry);
}

/** Record a failed attempt while leaving the entry eligible to retry. */
export function recordAttemptError(id, error) {
  load();
  placing.delete(id);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.lastError = cleanText(error) || "Sonos did not respond.";
  entry.updatedAt = nowMs();
  persistSoon();
  return snapshot(entry);
}

/**
 * Put a failed entry back in line. Safe against duplicates: placement still
 * runs through the drainer, and the true-up checks the live queue first.
 */
export function retryPendingAdd(id, { user = null } = {}) {
  load();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: "That request is no longer waiting." };
  if (user && !sameUser(entry.requestedByUser || entry.requestedBy, user)) {
    return { ok: false, error: "Only the person who asked for this song can retry it." };
  }
  // A placed entry is still on screen while we wait for Sonos to show the row,
  // so Retry must not be able to queue the song a second time.
  if (entry.state !== "failed") {
    return { ok: false, error: "That song is already on its way." };
  }
  entry.state = "pending";
  entry.attempts = 0;
  entry.lastError = null;
  entry.failedAt = 0;
  entry.updatedAt = nowMs();
  persist();
  return { ok: true, entry: snapshot(entry) };
}

/** Clear everything. Called when the host empties the queue, and by tests. */
export function clearPendingAdds() {
  load();
  const removed = entries.length;
  entries = [];
  placing.clear();
  persist();
  return removed;
}

/**
 * Age out failed rows so they don't sit on the TV all night. Pending entries
 * are never expired here — only the drainer decides an add is hopeless.
 */
export function expireFailedAdds(maxAgeMs) {
  load();
  const cutoff = nowMs() - Math.max(0, Number(maxAgeMs) || 0);
  const before = entries.length;
  entries = entries.filter((e) => e.state !== "failed" || e.failedAt >= cutoff);
  const removed = before - entries.length;
  if (removed) persist();
  return removed;
}

/** Drop in-memory state so tests can start from the file again. */
export function resetPendingAddsCache() {
  // Before entries goes null, or a queued write would land as an empty store.
  cancelBookkeepingWrite();
  writeNeeded = false;
  cancelQueuedWrite();
  const resolve = resolveDurable;
  resolveDurable = null;
  durablePromise = Promise.resolve();
  entries = null;
  placing.clear();
  resolve?.();
}

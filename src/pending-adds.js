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
// Confirmation is therefore a DELETE: once an entry is placed it leaves the
// store for good, which makes resurrection structurally impossible rather than
// something we have to remember to guard against.
//
// Persisted states are only "pending" and "failed". "placing" is deliberately
// in-memory: if the process dies mid-placement the entry reverts to pending on
// boot, and the true-up in queue-maintenance.js suppresses the duplicate by
// checking the live queue before re-placing.
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
  const state = raw.state === "failed" ? "failed" : "pending";
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

function persist() {
  try {
    writeFileAtomic(STORE_FILE, JSON.stringify(entries ?? []));
  } catch (err) {
    console.error("[pending-adds] save failed:", err.message);
  }
}

/** Public shape handed to routes and the drainer (never the live object). */
function snapshot(entry) {
  return { ...entry, placing: placing.has(entry.id) };
}

function sameUser(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
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
  // Oldest-first eviction; a pending entry this old is never going to place.
  while (entries.length > MAX) entries.shift();
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
 * This guest's live entry for a track, used to make repeat taps idempotent the
 * same way an upcoming Sonos row does.
 */
export function findPendingForGuest(user, trackId) {
  load();
  if (!user || !trackId) return null;
  const entry = entries.find(
    (e) =>
      e.trackId === trackId &&
      e.state === "pending" &&
      sameUser(e.requestedByUser || e.requestedBy, user)
  );
  return entry ? snapshot(entry) : null;
}

/**
 * Pending entries as queue-shaped rows so evaluateRequestFairness() can count
 * them without a live Sonos read. Quota is consumed at acknowledgement, which
 * is why markFailed() refunds it.
 */
export function pendingAsQueueRows() {
  load();
  return entries
    .filter((e) => e.state === "pending")
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
  persist();
  return snapshot(entry);
}

/** Release a claim without resolving the entry (it stays pending). */
export function releasePlacing(id) {
  placing.delete(id);
}

/**
 * Confirm placement. Deletes the entry: Sonos owns the song from here, and a
 * record that no longer exists cannot be resurrected by the true-up.
 *
 * @returns {object|null} the retired entry, or null if it was already gone
 */
export function markPlaced(id) {
  load();
  placing.delete(id);
  const at = entries.findIndex((e) => e.id === id);
  if (at === -1) return null;
  const [entry] = entries.splice(at, 1);
  persist();
  return { ...entry, state: "placed" };
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
  persist();
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
  entries = null;
  placing.clear();
}

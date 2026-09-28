# Plan: decouple guest adds from Sonos

Status: **Shipped in 14.0.0, on by default.** `PARTYQUEUE_ASYNC_ADDS=0` forces
the old synchronous path back without a redeploy.
Phases 0 and 1 were skipped — Phase 2 supersedes both. See §9 for what shipped
and where it diverged from this plan.
Written after the 2026-09-26 party incident. Full incident report lives in
`C:\APPS\PartyQueue-backups\docker-logs-incident-20260927-102621\INCIDENT.md`.

---

## 1. The problem

On party night, all 40 guest adds returned HTTP 200. None were rejected, rate
limited, or lost. What failed was latency:

| Condition | `POST /api/queue` response time |
|---|---|
| Healthy | 141–378 ms |
| Office flapping | 5.2 s, 5.3 s, 6.4 s, 6.8 s, 7.9 s, 8.5 s |
| Peak (during Ungroup All timeouts) | **28,508 ms** |

The guest-facing effect is worse than the number suggests, because the Add
button disables itself for the whole duration:

```js
// public/js/search-ui.js:402
btn.disabled = true;
btn.textContent = "Adding...";
const res = await fetchFn("/api/queue", { ... });   // no timeout
```

Twenty-eight seconds of a greyed-out "Adding…" reads as a broken app. That is
the origin of "Party Queue would not let folks add music."

### Where the time goes

Four layers stack, all inside the request:

1. **`withRequestFairnessLock`** (`src/request-fairness.js:10`) wraps the entire
   handler body — fairness check, Sonos write, and stats write. Guests are
   serialized behind each other, so one 8-second add delays everyone queued
   behind it.
2. **A live `GetQueue`** for the fairness snapshot (`src/routes/queue.js:169`)
   before any useful work happens.
3. **`sonos.addTrackToQueue`** (`src/routes/queue.js:196`) — the global 30 s
   write lane, shared with Never-Ending refills, trims, and DJ inserts. Beneath
   it: coordinator resolution (up to 3 topology probes × 4 s), another live
   `GetQueue`, an optional reorder, then `AddURIToQueue`. **No per-SOAP
   timeouts** — only the 30 s outer envelope.
4. **The DJ shout**, when the song lands next up
   (`src/routes/queue.js:358`, `awaitInsert: nextUp`) — an OpenAI script call,
   ElevenLabs TTS, an ffmpeg bake, and another Sonos insert, all before
   `res.json` at line 396.

### The root cause

Sonos is the only record of what a guest asked for. There is nothing to
acknowledge until the speaker confirms. The codebase already names this problem
in the one place it was solved:

```js
// src/queue-origin.js:13
// Sonos has nowhere to stash this, so we keep a small, bounded, JSON-backed
// list in data/queue-origin.json.
```

---

## 2. What the synchronous path buys us

This is the hard part of the plan and the reason it is not a small change. The
current handler returns a rich result that the UI depends on, and **every field
below requires a live read of the Sonos queue**:

| Field | Meaning | Used by |
|---|---|---|
| `queuePosition` | Guest-facing slot (#1 = next up), computed as absolute index minus now-playing offset | Add toast |
| `absoluteQueuePosition` | Real Sonos index | DJ announce insert placement |
| `promoted` | An existing *filler* copy was reordered up to become this request | Button text "Moved up" |
| `duplicated` | A second copy was enqueued because the reorder failed | Internal |
| `alreadyRequested` | This guest already has an upcoming copy — idempotent no-op | Button "Already queued", toast |
| `requestCreated` | Whether fairness quota and Party Stats should be consumed | `recordRequest`, fairness |
| `queueWasEmpty` / `deferredStart` / `started` | Whether to auto-start playback or hold for a DJ shout | Playback start logic |

See `src/sonos-queue-mutations.js:587-602` for the full return shape.

The promotion path in particular (`sonos-queue-mutations.js:491-542`) is real
logic, not a detail: if Random already queued the song as filler, we *reorder
that row up* rather than adding a duplicate, and re-badge it as "searched".

**Any async design must decide what to do about each of these at acknowledgement
time, when the Sonos queue has not been read.** Hand-waving this is how we ship
a regression.

---

## 3. Proposed phasing

Three phases. Phase 1 is independently shippable and delivers most of the
party-night benefit. Phase 2 is the real fix. Phase 0 is half a day and makes
both measurable.

### Phase 0 — Instrument first (0.5 day)

We know the total was 28.5 s. We do **not** know the split between write-lane
queueing, topology failover, SOAP, and TTS. Guessing wrong means optimising the
wrong layer.

- Add a timing breadcrumb to the add path: time spent waiting for the fairness
  lock, waiting for the write lane, in topology resolution, in `GetQueue`, in
  `AddURIToQueue`, and in the shout.
- Log it as one structured line per add, only when total exceeds a threshold
  (say 1 s) so it does not add to the log-volume problem.
- Re-run `scripts/sim-busy-party.mjs` against a deliberately degraded speaker to
  get a baseline.

**Exit criteria:** we can state where the 28 seconds went.

### Phase 1 — Cut the stacking (1–2 days, no contract change)

Three changes, none of which alter the API contract or the UI. Low risk.

**1a. Stop blocking the response on the DJ shout.**
`src/routes/queue.js:358` passes `{ awaitInsert: nextUp }`. Make it always
`false`. The shout still happens; the guest no longer waits for TTS.
*Risk:* for a next-up request the shout may land a beat later relative to the
song. The lead-buffer logic in `src/shout-lead-buffer.js` already re-glues the
announce to its request by URI, so this should be safe — **needs verification**,
this is the one part of 1a that could regress announce placement.

**1b. Narrow the fairness lock.**
Today it spans the fairness read, the Sonos write, and `recordRequest`. Shrink
it to cover only the policy decision and a reservation, then release before
calling Sonos. This removes guest-blocks-guest entirely — the single biggest
compounding factor on a busy night.
*Requires:* a small in-memory "reserved" set so two simultaneous adds cannot
both pass the same rolling quota while neither has hit Sonos yet.

**1c. Per-call timeouts inside the add path.**
`readLiveQueueForInsert` and `enqueueMeta` currently inherit only the 30 s write
lane. Give each SOAP call its own budget (~4 s) so a single wedged call cannot
hold the lane for 30 seconds and starve every queued add behind it.

**Expected result:** the 28.5 s case becomes low single digits. Not 200 ms, but
no longer "the app is broken."

### Phase 2 — Server-side queue with reconciliation (the real fix, ~1 week)

Invert the order: **record the request, acknowledge it, place it in the
background, and true up between songs.**

#### 2.0 The model: outbox, not mirror

This is the decision that makes the whole design safe, so it goes first.

The server-side list is an **outbox of unconfirmed adds**, not a mirror of the
Sonos queue. It tracks only "a guest asked for this and we have not confirmed it
landed." Once an entry is confirmed placed it **retires permanently** and Sonos
owns that song from then on.

The reconciler's only power is to **add** something that was never successfully
placed. It never removes from Sonos and never re-adds a retired entry.

The rejected alternative was a desired-state mirror, where PartyQueue's list is
authoritative and the reconciler enforces it.

**Why it fails: PartyQueue removes songs from the Sonos queue itself.**
`src/queue-maintenance.js` trims tracks once they have played, and is
deliberately the only caller of `trimPlayedTracks()`. The host skips songs.
Clear Queue wipes the lot. All of that is normal operation, which means
**"in our list but not in Sonos" does not mean "it failed"** — most of the time
it means "played, then trimmed." A mirror would fight its own trim loop and
resurrect songs that already played.

This holds even though PartyQueue is effectively the only controller during a
party (guests do not have the Sonos app). Sole ownership does not help, because
the conflicting writer is PartyQueue.

The outbox model resolves it: only entries **never confirmed placed** are ever
eligible for reconciliation.

**What sole ownership does buy us** is confidence in the *match*. With no other
writer, a live-queue row matching a pending entry's `trackId` is almost
certainly the add we are looking for, so confirming against it is safe. That is
what makes §2d's duplicate suppression reliable.

#### 2a. New durable store — `src/pending-adds.js`

Modelled directly on `src/queue-origin.js`: bounded, JSON-backed via
`src/atomic-write.js`, at `data/pending-adds.json`, with a
`PARTYQUEUE_PENDING_ADDS_FILE` override for tests.

Each entry:

```
{
  id,                // uuid, also the client-visible handle
  uri, trackId,      // trackId = Spotify ID, the key the true-up matches on
  name, artist,
  requestedByUser, requestedBy, dedication,
  force,
  state,             // "pending" | "placing" | "placed" | "failed" | "cancelled"
  attempts, lastError,
  partyGeneration,   // see §5 "restart safety"
  createdAt, updatedAt
}
```

`placed` is terminal. An entry that reaches it is never reconsidered, which is
what stops the true-up from re-adding a song that has since played and been
trimmed.

#### 2b. Rewritten `POST /api/queue`

1. Validate (unchanged).
2. Take the fairness lock **briefly**: evaluate policy against the *cached*
   queue snapshot (`sonos-cache.js`, 3 s TTL) **plus** current pending entries,
   rather than a live `GetQueue`.
3. Dedupe: if this guest already has a pending or upcoming copy, return
   `alreadyRequested` without creating a new entry.
4. Append to `pending-adds.json`, release the lock.
5. Respond immediately with an optimistic position and `pending: true`.

Target: **sub-200 ms regardless of Sonos health.**

#### 2c. Background drainer — `src/add-drainer.js`

A single server-side loop, modelled on `src/autofill.js` and
`src/queue-maintenance.js` (both already exactly this shape: a self-scheduling
timer that does Sonos work off the request path).

Note this is a separate **loop in the same Node process**, not a separate OS
process. Two processes would mean IPC plus two independent writers against
Sonos, which is worse than what we have today. The responsiveness win comes from
leaving the HTTP request path, not from leaving the process.

- Processes pending entries **in creation order** so guests land in the order
  they tapped.
- Calls the existing `addTrackToQueue` unchanged — all the promotion, dedupe and
  positioning logic is reused as-is, just off the request path.
- On success: mark `placed`, call `recordRequest`, fire the DJ shout.
- On failure: exponential backoff, `attempts++`. Entries stay `pending` and
  become the true-up's problem rather than being retried aggressively in place.
- Respects `queueWorkGeneration()` preemption so Clear Queue / Party's Over
  invalidate pending work.

#### 2d. The true-up — inside the queue-maintenance tick

**This is what makes retrying safe.** The failure mode that kills a naive retry
loop is the ambiguous timeout: we call `AddURIToQueue`, it times out, we assume
failure and retry — and the song is now queued twice. Party night had exactly
those conditions (28 s adds, transport-lane timeouts), so a blind retry would
have turned a slow party into one where songs played twice.

The true-up removes the ambiguity by **reading the live Sonos queue before
retrying anything**. That converts at-least-once delivery into effectively
exactly-once. Reconciliation is not a repair afterthought here; it is the
precondition for retrying at all.

Placement: fold into the existing `src/queue-maintenance.js` tick rather than
adding a fourth timer. That loop already runs every 45 s while playing, already
backs off on error, and is deliberately the **only** caller of
`trimPlayedTracks()` so removals never race the browsers. The true-up wants the
same property for the same reason, and it wants to run when the write lane is
naturally idle — between songs.

Each pass:

1. Read the live queue once (the tick already does this for trim — reuse it, do
   not add a second `GetQueue`).
2. For each entry **not** in a terminal state, match against the live queue on
   `(trackId, requestedByUser)`.
3. **Found** → mark `placed` and retire it. This is the duplicate suppression:
   an add that actually succeeded but whose response timed out gets confirmed
   here instead of retried.
4. **Not found and never placed** → hand back to the drainer for another
   attempt.
5. After N passes still unplaced → mark `failed` and surface it (see §5).

**Announce collision guard.** The tick already skips when a DJ announce is
armed — the logs show `[trim] skip (dj-announce-armed)` 110 times on party
night. The true-up must honour the same guard, since inserting a track mid
announce is precisely the race that guard exists to prevent.

#### 2e. Merged queue view

`GET /api/queue/list` (`src/routes/queue.js:1014`) returns Sonos truth today.
It should return Sonos rows **plus** pending entries, flagged so the UI can
badge them. The guest sees their song appear instantly and watch it settle.

Entries in the `failed` state are included too, flagged for the retry affordance
described in §5.

#### 2f. Read-side resilience — keep the display alive

The outbox fixes the write path. The read path has the same weakness and it
matters just as much, because guests have no other view of the party: the TV
display and every phone read `/api/queue/list`, which hits Sonos live. On party
night those reads were degrading at exactly the moment people were staring at
them.

- Keep a **last-known-good queue snapshot** in memory, written on every
  successful read (the maintenance tick already performs one every 45 s, so the
  snapshot stays warm even with no guests browsing).
- When a live read fails or exceeds its budget, serve the snapshot with an
  `stale: true` flag and the timestamp of the last good read, rather than
  returning an error.
- The UI shows a quiet "reconnecting" indicator on stale data. It must not
  disable the Add button — adds are independent of the display once Phase 2
  lands, and that independence is the point.
- Pending entries are merged on top of the snapshot as usual, so a guest adding
  during a Sonos outage still sees their song appear.

This is deliberately a cache, not a second source of truth: it is only ever a
copy of the last thing Sonos told us, and it never feeds the reconciler in §2d.
The true-up must always work from a genuinely live read, or it could confirm a
placement against stale data.

#### 2g. Client changes

`public/js/search-ui.js:367` — button returns to normal immediately, toast says
the song is queued. The existing "Moved up" / "Already queued" states move to
best-effort (see §4).

---

## 4. Behaviour changes we are accepting

| # | Change | Impact | Status |
|---|---|---|---|
| 1 | Drop `queuePosition` from the ack response entirely | Toast becomes `Added "X" to the queue` | **Decided** — see below |
| 2 | `promoted` ("Moved up") computed against the cached snapshot, so it can be wrong | Button may say "Added" when it technically promoted a filler row | **Decided** — accept best-effort |
| 3 | A song can be acknowledged and then **fail** to place | Row stays in the queue in a "couldn't add" state with a retry | **Decided** — see §5 |
| 4 | Fairness counts pending entries, so the upcoming cap is consumed at ack | Freed automatically when an entry is marked `failed`; rolling quota is never consumed until placement | **Resolved** — see §9 |
| 5 | Closing-time ritual (`src/routes/queue.js:252`) currently fires synchronously on the End-of-Night song | Switches off Never-Ending and flips Party's Over | Suggest keeping this one path sync |

### Decision on #1 — drop the position from the toast

Guests read their position off the TV display and the queue on their phone, so
the toast does not need to carry it. **This requires no client change**: every
branch of `formatAddToastMessage` (`public/js/add-toast.js:37-52`) already
handles a missing or non-finite `queuePosition` and falls back to
`Added "X" to the queue`.

Two consequences, both good:

- The inconsistency in #1 disappears rather than being mitigated — there is no
  estimate to be wrong.
- Computing the position was one of the reasons to read the Sonos queue at ack
  time. Removing it makes the sub-200 ms target materially easier.

**Not lost:** `queuePosition` appears nine more times in `src/routes/queue.js`,
but all of those are DJ announce placement via `absoluteQueuePosition`. That
work moves into the drainer, which holds the live queue, so announce placement
keeps full accuracy.

### Decision on #2 — best-effort `promoted`

Accepted. The failure mode is benign: the button may say "Added" for what was
technically a promotion. It never misleads a guest into re-adding a song.

**`alreadyRequested` is explicitly out of scope for this trade-off.** The
"Already queued" state is what stops a guest tapping twice, and it can be made
reliable: the pending store gives exact knowledge of this guest's in-flight
adds, and `invalidateSonosSnapshots()` is already called on placement, so the
cached snapshot stays fresh for placed rows. Treat this as a correctness
requirement, not best-effort.

---

## 5. Failure modes

**Placement fails permanently.** The guest was told "queued" and it never
plays. **Decided:** the row stays visible in the queue list in a `failed`
state — "couldn't add" — with a retry affordance, rather than being toasted
once or silently dropped. It is honest, and it is self-healing: by the time a
guest notices and taps retry, the speaker that caused the failure has usually
recovered, and the retry runs through the same drainer and true-up, so it cannot
produce a duplicate.

Two requirements follow:

- **Quota refund.** Fairness consumes quota at ack time (§4, change 4). Marking
  an entry `failed` must refund it, or a guest is penalised for our failure.
  Retrying re-consumes it normally.
- **Failed entries expire.** They should not accumulate on the TV display all
  night. Age them out after a few minutes, or clear them at the party
  generation boundary along with everything else.

**Container restarts with pending entries.** This is why the store is durable —
but we must not re-add last night's songs on a morning restart. Stamp each entry
with a `partyGeneration` and discard entries from a previous party on boot. A
restart *during* a party should drain normally.

**Clear Queue / Party's Over mid-drain.** Reuse the existing
`queueWorkGeneration()` preemption. Pending entries older than the preempt
generation are cancelled, not placed.

**Guest double-taps.** Dedupe on `(user, trackId)` across pending + upcoming, so
the second tap returns `alreadyRequested` as it does today.

**Ambiguous timeout — the add actually succeeded.** Covered by §2d: the true-up
finds the song in the live queue and retires the entry rather than re-adding it.
This is the single most important correctness property of the design, and it is
worth a dedicated test.

**A placed song legitimately disappears.** Trimmed after playing, removed by the
host, wiped by Clear Queue, or skipped. The outbox model handles this by
construction — `placed` is terminal, so the true-up never sees the entry again
and cannot resurrect it.

**Something outside PartyQueue touches the queue.** Not expected during a party
— guests do not have the Sonos app — but the host may use it, the speakers have
physical transport buttons, and the household Node-RED flows keep running
regardless. The outbox model tolerates all of this for free: the reconciler only
adds things that were never placed, so an unexpected external change cannot
cause it to remove or resurrect anything. Worth stating so nobody later assumes
sole ownership as a *correctness* requirement — it is a convenience, not a
guarantee the design leans on.

**Drainer wedges.** It holds no HTTP request, so worst case is songs stop
appearing while the UI stays responsive — strictly better than today. Add a
watchdog log line if the head of the queue is older than ~60 s.

---

## 6. Test plan

Existing tests that assume the synchronous contract and will need rework:
`test/http-queue.test.js`, `test/request-fairness.test.js`,
`test/set-request-fairness.test.js`, `test/queue-origin.test.js`.

New coverage needed:

- Ack latency stays under budget when the Sonos mock hangs for 30 s.
- Pending entries drain in creation order.
- Dedupe: same guest, same track, twice → one entry.
- **Ambiguous timeout: the mock accepts the add but never responds. The true-up
  must find the track and retire the entry — no duplicate.**
- **A `placed` entry whose track is later trimmed is never re-added.**
- **The true-up skips while a DJ announce is armed.**
- The true-up never issues a removal against Sonos.
- Preemption: Clear Queue cancels pending entries.
- Restart: entries from a previous `partyGeneration` are discarded.
- Quota refund on permanent placement failure, and re-consumption on retry.
- Retrying a `failed` entry does not create a duplicate.
- **Read path: when the live queue read fails, `/api/queue/list` serves the
  last-known-good snapshot with `stale: true` instead of erroring.**
- **The true-up never runs against the cached snapshot.**
- `scripts/sim-busy-party.mjs` extended to assert ack latency under a degraded
  speaker, which is the scenario that actually bit us.

---

## 7. Rollout

Phase 1 ships on its own and is safe to deploy before the next party.

Phase 2 shipped in 14.0.0 defaulting **on**. Rollback is `PARTYQUEUE_ASYNC_ADDS=0`
in the Unraid `.env` plus a container restart — no rebuild, no redeploy.

Watch for in the first party: `[add-drainer] placed ...` lines (normal),
`[add-drainer] attempt N ... failed` (speaker struggling, still recovering),
`[true-up] confirmed ...` (an add landed but the call timed out — the duplicate
was suppressed), and `[add-drainer] giving up ...` (a guest saw "Couldn't add").

---

## 8. Open questions

1. **Scope** — Phase 1 only before the next party, or commit to Phase 2 now?
2. **Phase 1a risk** — am I clear to change `awaitInsert` to always-false, given
   it may shift next-up announce timing? This is the one change in Phase 1 that
   could regress DJ behaviour, and DJ announce placement has been reworked
   several times already.

**Answered 2026-09-27:**

- *Position accuracy* — drop `queuePosition` from the ack entirely. Guests read
  position off the TV and their phone queue. See §4.
- *"Moved up"* — keep as best-effort. See §4.
- *Outbox vs desired-state mirror* — **outbox**. The server-side list tracks only
  unconfirmed adds, never removes from Sonos, and retires entries once placed.
  See §2.0. Confirmed that PartyQueue is the only controller during a party;
  this does not change the answer, because the writer a mirror would conflict
  with is PartyQueue's own trim loop.
- *True-up cadence* — fold into the existing `src/queue-maintenance.js` tick
  (45 s while playing) rather than adding a fourth timer, reusing its live queue
  read and its DJ-announce guard. See §2d.
- *Failed placement UX* — keep the row visible in a "couldn't add" state with a
  retry, refund quota, and expire the row. See §5.
- *Read-side resilience* — in scope for Phase 2. Serve a last-known-good queue
  snapshot when live reads fail so the TV and phones never go blank. See §2f.

---

## 9. What actually shipped (2026-09-27)

Fallback point before any of this: branch `backup/main-12.1.1-pre-phase2`, tag
`v12.1.1-pre-phase2`, commit `32465eb`, plus source and data zips in
`C:\APPS\PartyQueue-backups\`.

| File | Role |
|---|---|
| `src/pending-adds.js` | The outbox. Durable, bounded, `data/pending-adds.json` |
| `src/add-drainer.js` | Self-scheduling placement loop, nudged on each add |
| `src/add-trueup.js` | Reconciliation pass; the duplicate suppressor |
| `src/queue-view.js` | Merged queue payload + last-known-good fallback |
| `src/async-adds.js` | The feature flag |

Changed: `src/routes/queue.js` (async ack path, retry/dismiss endpoints, merged
list), `src/queue-maintenance.js` (hosts the true-up), `src/sonos-cache.js`
(`peek()`), `src/server.js` (wiring), `public/js/queue-ui.js` and
`public/styles.css` (pending/failed rows).

Tests: `test/pending-adds.test.js`, `test/async-adds.test.js`,
`test/queue-outbox-ui.test.js`. Full suite 1316 passing.

### Where it diverged from the plan

- **Confirmation is deletion, not a `placed` state.** Retiring an entry removes
  it from the store, so resurrection is structurally impossible rather than a
  rule we have to keep remembering. Persisted states are only `pending` and
  `failed`.
- **`placing` is in-memory, not persisted.** A crash mid-placement reverts the
  entry to pending on boot, and the true-up suppresses the duplicate. This is
  strictly safer than persisting a claim that might never be released.
- **`partyGeneration` became a staleness window.** Entries older than six hours
  are dropped on load, which handles the morning-restart case without inventing
  a new party identity. In-party cancellation still uses the existing
  `queueWorkGeneration()`.
- **The true-up does its own queue read** rather than sharing trim's, because
  `trimPlayedTracks()` does not return the list. It only reads when something is
  actually waiting, so a healthy party adds no extra Sonos traffic.
- **Phase 1 was skipped.** `awaitInsert` is simply `false` on the async path,
  which made open question 2 moot. The synchronous path is untouched and runs
  only when `PARTYQUEUE_ASYNC_ADDS=0`. The async path is the default as of
  14.0.0.
- **The toast needed no client change at all**, exactly as predicted in §4.

### Still open

- `POST /api/queue/set-request` still waits on the five Sonos writes before
  that phone is answered. It no longer holds the fairness lock while it does
  that, so other guests' Adds return from the outbox. The shout is not awaited.

### Correction to §4, change 4

The plan assumed fairness quota is consumed at acknowledgement and therefore
needs an explicit refund on failure. Reading the shipped code, that is only half
right, and the half that matters needs no refund:

- **Upcoming cap** counts pending entries, so it *is* consumed at ack — but
  `markFailed()` moves the entry out of `pendingAsQueueRows()`, which frees the
  slot automatically.
- **Rolling window** is driven by `request-log.js`, and `recordRequest()` is
  called by the drainer on successful placement, never at ack. A song that never
  places never consumes rolling quota in the first place.

So there is nothing to refund, and no refund code was written. Worth
re-checking against a live fairness config before the next party.

---

## 10. What this does not fix

Worth stating plainly: **none of this fixes Sonos.** If Office drops off the
network again, songs will still be slow to *land* — they just will not block the
guest's phone while they do. The speaker-side resilience work (topology
fallback, health-ranked probes, gating Group All / Ungroup All) is tracked
separately in the incident report and is the other half of the job.

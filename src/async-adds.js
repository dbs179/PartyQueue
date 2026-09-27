// Feature flag for write-behind guest adds.
//
// On by default as of 14.0.0. Guest adds are recorded in the outbox
// (pending-adds.js), acknowledged immediately, placed by add-drainer.js, and
// reconciled by add-trueup.js between songs.
//
// PARTYQUEUE_ASYNC_ADDS=0 forces the old synchronous path back on, where the
// guest's request waits for Sonos to confirm. That remains a working rollback
// without a redeploy: nothing persists across the switch except the outbox
// file, and the queue view ignores it while the flag is off.

export function asyncAddsEnabled() {
  return process.env.PARTYQUEUE_ASYNC_ADDS !== "0";
}

// Feature flag for write-behind guest adds.
//
// Off by default so the synchronous path stays the shipped behaviour until a
// real party has been run with this on. Rollback is an env var, not a redeploy.
//
// PARTYQUEUE_ASYNC_ADDS=1 turns it on.

export function asyncAddsEnabled() {
  return process.env.PARTYQUEUE_ASYNC_ADDS === "1";
}

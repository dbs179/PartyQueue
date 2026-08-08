/** Client-side SSE snapshot cursor (session + sequence dedupe). */

/**
 * @typedef {{ session: string, sequence: number }} StreamCursor
 */

/** @returns {StreamCursor} */
export function createStreamCursor() {
  return { session: "", sequence: 0 };
}

/** @returns {StreamCursor} */
export function resetStreamCursor() {
  return createStreamCursor();
}

/**
 * Advance the cursor for an incoming snapshot. Stale same-session sequences
 * are rejected; a new session resets the sequence baseline.
 *
 * @param {StreamCursor} cursor
 * @param {{ streamSession?: string, streamSequence?: number }|null|undefined} snapshot
 * @returns {{ accept: boolean, cursor: StreamCursor }}
 */
export function advanceStreamCursor(cursor, snapshot) {
  const prev = cursor || createStreamCursor();
  const session =
    typeof snapshot?.streamSession === "string" ? snapshot.streamSession : "";
  const sequence = Number(snapshot?.streamSequence);

  if (
    session &&
    session === prev.session &&
    Number.isFinite(sequence) &&
    sequence <= prev.sequence
  ) {
    return { accept: false, cursor: prev };
  }

  let nextSession = prev.session;
  let nextSequence = prev.sequence;
  if (session && session !== prev.session) {
    nextSession = session;
    nextSequence = 0;
  }
  if (Number.isFinite(sequence)) nextSequence = sequence;

  return {
    accept: true,
    cursor: { session: nextSession, sequence: nextSequence },
  };
}

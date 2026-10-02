// Group All hands the house to Living Room and keeps the current queue.
// Pure planning lives here so the speaker order can be tested without Sonos.

export const GROUP_ALL_ROOM = "Living Room";

/**
 * @param {{ uuid?: string, coordinatorUuid?: string, skipped?: boolean }|null|undefined} living
 * @param {string} [anchorUuid]
 */
export function planLivingRoomHandoff({ living, anchorUuid } = {}) {
  if (!living) return { action: "abort", reason: "missing" };
  if (living.skipped) return { action: "abort", reason: "unreachable" };
  if (living.uuid && living.uuid === anchorUuid) return { action: "join-only" };
  return {
    action: "delegate",
    joinLivingRoomFirst: living.coordinatorUuid !== anchorUuid,
  };
}

export function groupAllAbortError(reason) {
  const error = new Error(
    reason === "missing"
      ? "Living Room is not in this Sonos system, so speakers were left as they are."
      : "Living Room is not responding, so speakers were left as they are."
  );
  error.statusCode = 502;
  return error;
}

/** Copy only a real party queue. TV, line-in, and radio stay where they are. */
export function shouldCopyQueue(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.playingFromQueue &&
      Array.isArray(snapshot.uris) &&
      snapshot.uris.length > 0
  );
}

function findRoom(devices, roomName) {
  const want = String(roomName || "").trim().toLowerCase();
  if (!want) return null;
  return (
    (devices || []).find(
      (device) => String(device?.name || "").trim().toLowerCase() === want
    ) || null
  );
}

/**
 * Hand the current group to Living Room, then join everyone else.
 * `ops.rebuild` runs only after delegation fails. A failure to pull Living
 * Room into the group stops before any ungroup.
 *
 * @param {{
 *   devices: Array<{ name: string, uuid: string, coordinatorUuid?: string, skipped?: boolean }>,
 *   anchor: { name: string, uuid: string },
 *   roomName?: string,
 *   ops: {
 *     join: (device: object, target: object) => Promise<void>,
 *     delegate: (anchor: object, living: object) => Promise<void>,
 *     rebuild: (anchor: object, living: object) => Promise<object|null>,
 *     setTarget: (name: string) => void|Promise<void>,
 *     joinOutsiders: (living: object) => Promise<void>,
 *   },
 * }} args
 */
export async function coordinateGroupAll({
  devices,
  anchor,
  roomName = GROUP_ALL_ROOM,
  ops,
}) {
  const living = findRoom(devices, roomName);
  const plan = planLivingRoomHandoff({ living, anchorUuid: anchor?.uuid });
  if (plan.action === "abort") throw groupAllAbortError(plan.reason);

  let mode = plan.action === "join-only" ? "already" : "delegated";
  let playback = null;

  if (plan.action === "delegate") {
    if (plan.joinLivingRoomFirst) {
      try {
        await ops.join(living, anchor);
      } catch (err) {
        const error = new Error(
          "Could not add Living Room to the current group, so speakers were left as they are."
        );
        error.statusCode = 502;
        error.cause = err;
        throw error;
      }
    }
    try {
      await ops.delegate(anchor, living);
    } catch (err) {
      console.error(
        `[group-all] coordinator handoff failed: ${err?.message || err}`
      );
      mode = "rebuilt";
      playback = await ops.rebuild(anchor, living);
    }
  }

  await ops.setTarget(living.name);
  await ops.joinOutsiders(living);
  return { mode, playback, livingName: living.name };
}

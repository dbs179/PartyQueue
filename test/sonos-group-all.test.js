import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coordinateGroupAll,
  planLivingRoomHandoff,
  shouldCopyQueue,
} from "../src/sonos-group-all.js";

const office = { name: "Office", uuid: "office", coordinatorUuid: "office" };
const livingAlone = {
  name: "Living Room",
  uuid: "living",
  coordinatorUuid: "living",
};
const livingMember = {
  name: "Living Room",
  uuid: "living",
  coordinatorUuid: "office",
};
const kitchen = { name: "Kitchen", uuid: "kitchen", coordinatorUuid: "office" };

test("planLivingRoomHandoff aborts when Living Room is missing or skipped", () => {
  assert.deepEqual(planLivingRoomHandoff({ living: null, anchorUuid: "office" }), {
    action: "abort",
    reason: "missing",
  });
  assert.deepEqual(
    planLivingRoomHandoff({
      living: { ...livingAlone, skipped: true },
      anchorUuid: "office",
    }),
    { action: "abort", reason: "unreachable" }
  );
});

test("planLivingRoomHandoff joins when Living Room already coordinates", () => {
  assert.deepEqual(
    planLivingRoomHandoff({ living: livingAlone, anchorUuid: "living" }),
    { action: "join-only" }
  );
});

test("planLivingRoomHandoff delegates, joining Living Room first when it is outside the group", () => {
  assert.deepEqual(
    planLivingRoomHandoff({ living: livingMember, anchorUuid: "office" }),
    { action: "delegate", joinLivingRoomFirst: false }
  );
  assert.deepEqual(
    planLivingRoomHandoff({ living: livingAlone, anchorUuid: "office" }),
    { action: "delegate", joinLivingRoomFirst: true }
  );
});

test("shouldCopyQueue keeps a party queue and leaves TV or radio alone", () => {
  assert.equal(
    shouldCopyQueue({
      playingFromQueue: true,
      uris: ["spotify:track:1"],
    }),
    true
  );
  assert.equal(
    shouldCopyQueue({ playingFromQueue: false, uris: ["spotify:track:1"] }),
    false
  );
  assert.equal(shouldCopyQueue({ playingFromQueue: true, uris: [] }), false);
  assert.equal(shouldCopyQueue(null), false);
});

function recordingOps(extra = {}) {
  const calls = [];
  return {
    calls,
    ops: {
      join: async (device, target) => {
        calls.push(["join", device.name, target.name]);
        if (extra.joinFails) throw new Error("join failed");
      },
      delegate: async () => {
        calls.push(["delegate"]);
        if (extra.delegateFails) throw new Error("delegate failed");
      },
      rebuild: async () => {
        calls.push(["rebuild"]);
        return { copied: true, track: 3, positionSec: 12, play: true };
      },
      setTarget: (name) => {
        calls.push(["target", name]);
      },
      joinOutsiders: async (living) => {
        calls.push(["outsiders", living.name]);
      },
    },
  };
}

test("coordinateGroupAll leaves the house alone when Living Room is missing", async () => {
  const { calls, ops } = recordingOps();
  await assert.rejects(
    () =>
      coordinateGroupAll({
        devices: [office, kitchen],
        anchor: office,
        ops,
      }),
    /left as they are/
  );
  assert.deepEqual(calls, []);
});

test("coordinateGroupAll does not delegate when Living Room is already coordinator", async () => {
  const { calls, ops } = recordingOps();
  const result = await coordinateGroupAll({
    devices: [{ ...livingAlone, coordinatorUuid: "living" }, { ...office, coordinatorUuid: "living" }],
    anchor: { name: "Living Room", uuid: "living" },
    ops,
  });
  assert.equal(result.mode, "already");
  assert.deepEqual(calls, [
    ["target", "Living Room"],
    ["outsiders", "Living Room"],
  ]);
});

test("coordinateGroupAll delegates in place when Living Room is already a member", async () => {
  const { calls, ops } = recordingOps();
  const result = await coordinateGroupAll({
    devices: [office, livingMember, kitchen],
    anchor: office,
    ops,
  });
  assert.equal(result.mode, "delegated");
  assert.equal(result.playback, null);
  assert.deepEqual(calls, [
    ["delegate"],
    ["target", "Living Room"],
    ["outsiders", "Living Room"],
  ]);
});

test("coordinateGroupAll pulls Living Room in before delegating", async () => {
  const { calls, ops } = recordingOps();
  await coordinateGroupAll({
    devices: [office, livingAlone],
    anchor: office,
    ops,
  });
  assert.deepEqual(calls[0], ["join", "Living Room", "Office"]);
  assert.deepEqual(calls[1], ["delegate"]);
});

test("a failed Living Room join does not ungroup or rebuild", async () => {
  const { calls, ops } = recordingOps({ joinFails: true });
  await assert.rejects(
    () =>
      coordinateGroupAll({
        devices: [office, livingAlone],
        anchor: office,
        ops,
      }),
    /left as they are/
  );
  assert.deepEqual(calls, [["join", "Living Room", "Office"]]);
});

test("a failed handoff rebuilds the queue before joining the rest of the house", async () => {
  const { calls, ops } = recordingOps({ delegateFails: true });
  const result = await coordinateGroupAll({
    devices: [office, livingMember],
    anchor: office,
    ops,
  });
  assert.equal(result.mode, "rebuilt");
  assert.equal(result.playback.copied, true);
  assert.equal(result.playback.track, 3);
  assert.deepEqual(calls, [
    ["delegate"],
    ["rebuild"],
    ["target", "Living Room"],
    ["outsiders", "Living Room"],
  ]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PARTY_DISPLAY_IDLE_AFTER_MS,
  createPartyDisplayIdle,
  partyDisplayShouldBeIdle,
} from "../public/js/party-display-idle.js";

test("partyDisplayShouldBeIdle requires kiosk display and quiet timeout", () => {
  const now = 1_000_000;
  assert.equal(
    partyDisplayShouldBeIdle({
      displayActive: true,
      kiosk: true,
      isPlaying: true,
      hasTrack: true,
      quietSince: now - PARTY_DISPLAY_IDLE_AFTER_MS,
      now,
    }),
    false
  );
  assert.equal(
    partyDisplayShouldBeIdle({
      displayActive: true,
      kiosk: false,
      isPlaying: false,
      hasTrack: false,
      quietSince: now - PARTY_DISPLAY_IDLE_AFTER_MS,
      now,
    }),
    false
  );
  assert.equal(
    partyDisplayShouldBeIdle({
      displayActive: true,
      kiosk: true,
      isPlaying: false,
      hasTrack: true,
      quietSince: now - 1_000,
      now,
    }),
    false
  );
  assert.equal(
    partyDisplayShouldBeIdle({
      displayActive: true,
      kiosk: true,
      isPlaying: false,
      hasTrack: false,
      quietSince: now - PARTY_DISPLAY_IDLE_AFTER_MS,
      now,
    }),
    true
  );
});

test("createPartyDisplayIdle starts Fully screensaver when quiet, wakes on play", () => {
  const now = 50_000;
  const calls = [];
  const fully = {
    startScreensaver() {
      calls.push("startScreensaver");
    },
    stopScreensaver() {
      calls.push("stopScreensaver");
    },
    turnScreenOn() {
      calls.push("turnScreenOn");
    },
  };

  const idle = createPartyDisplayIdle({
    idleAfterMs: 0,
    getFully: () => fully,
    now: () => now,
    documentRef: null,
  });

  idle.setDisplayState({ active: true, kiosk: true });
  idle.syncPlayback({ isPlaying: false, hasTrack: true });
  assert.equal(idle.isIdle(), true);
  assert.deepEqual(calls, ["startScreensaver"]);

  idle.syncPlayback({ isPlaying: true, hasTrack: true });
  assert.equal(idle.isIdle(), false);
  assert.deepEqual(calls, [
    "startScreensaver",
    "stopScreensaver",
    "turnScreenOn",
  ]);

  idle.destroy();
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/sonos-transport.js"),
  "utf8"
);
const clearSrc = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/sonos-queue-mutations.js"
  ),
  "utf8"
);

test("pauseUnlocked cancels DJ volume handoff before Pause, like Skip", () => {
  const fn = src.match(/async function pauseUnlocked\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "pauseUnlocked should exist");
  assert.match(fn[0], /cancelActiveDjVolumeHandoff\("host pause"\)/);
  assert.match(fn[0], /pausePlaybackUnlocked\(\)/);
  assert.ok(
    fn[0].indexOf("cancelActiveDjVolumeHandoff") <
      fn[0].indexOf("pausePlaybackUnlocked()"),
    "cancel must run before Pause so the 150ms watcher cannot Play/Next after host pause"
  );
});

test("pausePlaybackUnlocked is a raw Pause that does not cancel the DJ handoff", () => {
  const fn = src.match(/async function pausePlaybackUnlocked\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "pausePlaybackUnlocked should exist");
  assert.match(fn[0], /coordinator\.Pause\(\)/);
  assert.doesNotMatch(fn[0], /cancelActiveDjVolumeHandoff/);
});

test("previousUnlocked cancels DJ volume handoff before Previous", () => {
  const fn = src.match(/async function previousUnlocked\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "previousUnlocked should exist");
  assert.match(fn[0], /cancelActiveDjVolumeHandoff\("host previous"\)/);
  assert.ok(
    fn[0].indexOf("cancelActiveDjVolumeHandoff") <
      fn[0].indexOf("coordinator.Previous()"),
    "cancel must run before Previous"
  );
});

test("clearQueueUnlocked cancels DJ volume handoff before wiping the queue", () => {
  const fn = clearSrc.match(/async function clearQueueUnlocked\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "clearQueueUnlocked should exist");
  assert.match(fn[0], /cancelActiveDjVolumeHandoff\("queue cleared"\)/);
});

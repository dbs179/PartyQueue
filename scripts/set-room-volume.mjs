#!/usr/bin/env node
/**
 * Set one room's volume to an exact level. Used before live announce tests so
 * a boosted DJ clip cannot surprise the house.
 *
 *   node scripts/set-room-volume.mjs Office 6
 */
import { getManager } from "../src/sonos-core.js";

const room = process.argv[2] || "Office";
const level = Math.max(0, Math.min(100, Number(process.argv[3] ?? 6)));

const manager = await getManager();
const device = manager.Devices.find(
  (d) => d.Name?.toLowerCase() === room.toLowerCase()
);
if (!device) {
  console.error(
    `no such room: ${room} (have: ${manager.Devices.map((d) => d.Name).join(", ")})`
  );
  process.exit(1);
}

const before = await device.RenderingControlService.GetVolume({
  InstanceID: 0,
  Channel: "Master",
});
await device.RenderingControlService.SetVolume({
  InstanceID: 0,
  Channel: "Master",
  DesiredVolume: level,
});
const after = await device.RenderingControlService.GetVolume({
  InstanceID: 0,
  Channel: "Master",
});
console.log(`${device.Name}: ${before.CurrentVolume} -> ${after.CurrentVolume}`);
process.exit(0);

#!/usr/bin/env node
/**
 * Read the target coordinator's raw transport state. Used to tell a PartyQueue
 * bug apart from a speaker that simply is not pointed at its own queue.
 *
 *   node scripts/smoke-transport-probe.mjs
 *   node scripts/smoke-transport-probe.mjs --fix-transport
 */
import { getManager, resolveCoordinator } from "../src/sonos-core.js";

const m = await getManager();
const roomArg = process.argv.indexOf("--room");
const coordinator =
  roomArg >= 0
    ? m.Devices.find(
        (d) =>
          String(d.Name).toLowerCase() ===
          String(process.argv[roomArg + 1]).toLowerCase()
      )
    : await resolveCoordinator(m);
if (!coordinator) throw new Error("room not found");
console.log("coordinator:", coordinator.Name, coordinator.Uuid);

const [media, transport, position] = await Promise.all([
  coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }),
  coordinator.AVTransportService.GetTransportInfo({ InstanceID: 0 }),
  coordinator.AVTransportService.GetPositionInfo({ InstanceID: 0 }),
]);
console.log("CurrentURI:", media.CurrentURI);
console.log("NrTracks:", media.NrTracks);
console.log("TransportState:", transport.CurrentTransportState);
console.log("Track:", position.Track, "TrackURI:", position.TrackURI);

const queue = await coordinator.GetQueue();
const items = Array.isArray(queue.Result) ? queue.Result : [];
console.log(`queue rows: ${items.length}`);
items.forEach((row, i) => {
  console.log(`  ${i + 1}. ${row.Title ?? "?"} | ${row.TrackUri ?? row.uri ?? "?"}`);
});

const playArg = process.argv.indexOf("--play-track");
if (playArg >= 0) {
  const n = Number(process.argv[playArg + 1]);
  console.log(`\nSeekTrack ${n} then Play...`);
  try {
    await coordinator.SeekTrack(n);
    await coordinator.Play();
    await new Promise((r) => setTimeout(r, 4000));
    const t = await coordinator.AVTransportService.GetTransportInfo({
      InstanceID: 0,
    });
    const p = await coordinator.AVTransportService.GetPositionInfo({
      InstanceID: 0,
    });
    console.log(`-> ${t.CurrentTransportState} on track ${p.Track}: ${p.TrackURI}`);
  } catch (err) {
    console.log(`-> FAILED: ${err.message}`);
  }
}

const wantUri = `x-rincon-queue:${coordinator.Uuid}#0`;
if (media.CurrentURI !== wantUri) {
  console.log(`\n!! transport is not on its own queue (want ${wantUri})`);
  if (process.argv.includes("--fix-transport")) {
    await coordinator.AVTransportService.SetAVTransportURI({
      InstanceID: 0,
      CurrentURI: wantUri,
      CurrentURIMetaData: "",
    });
    console.log("SetAVTransportURI -> queue");
  }
} else {
  console.log("\ntransport is on its own queue");
}
process.exit(0);

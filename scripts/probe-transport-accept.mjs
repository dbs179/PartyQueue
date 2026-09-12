#!/usr/bin/env node
/**
 * Ask a room whether it will ACCEPT transport commands, without changing what
 * the guests hear: the only mutation attempted is a Seek to the position the
 * track is already at. Reports the UPnP error per command so a refusal can be
 * told apart from a real failure.
 *
 *   node scripts/probe-transport-accept.mjs Office
 */
import { getManager } from "../src/sonos-core.js";

const name = process.argv[2] || "Office";
const m = await getManager();
const d = m.Devices.find(
  (x) => String(x.Name).toLowerCase() === name.toLowerCase()
);
if (!d) {
  console.log(`${name} not found`);
  process.exit(1);
}

const pos = await d.AVTransportService.GetPositionInfo();
const ti = await d.AVTransportService.GetTransportInfo();
const mi = await d.AVTransportService.GetMediaInfo({ InstanceID: 0 });
console.log(`[${name}] state=${ti.CurrentTransportState} track=${pos.Track}`);
console.log(`  RelTime=${pos.RelTime} Duration=${pos.TrackDuration}`);
console.log(`  NrTracks=${mi.NrTracks} CurrentURI=${String(mi.CurrentURI).slice(0, 50)}`);

const tryIt = async (label, fn) => {
  try {
    await fn();
    console.log(`  ACCEPTED  ${label}`);
  } catch (err) {
    console.log(`  REFUSED   ${label}  -> ${err.message}`);
  }
};

// Seek to where it already is: same audio, but exercises the same UPnP action
// the app's seek-near-end path uses. This is the only safe probe — a TRACK_NR
// seek is NOT a no-op even when it targets the current track, because Sonos
// restarts that track from 0:00.
await tryIt(`Seek REL_TIME ${pos.RelTime} (no audible change)`, () =>
  d.AVTransportService.Seek({
    InstanceID: 0,
    Unit: "REL_TIME",
    Target: pos.RelTime,
  })
);

process.exit(0);

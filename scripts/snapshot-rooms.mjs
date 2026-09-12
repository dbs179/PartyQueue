#!/usr/bin/env node
/**
 * One-shot read of the coordinator PartyQueue resolves plus the raw transport
 * and queue state of each named room. Read-only: no transport calls are sent.
 *
 *   node scripts/snapshot-rooms.mjs Office Kitchen "Living Room"
 */
import { getManager, resolveCoordinator } from "../src/sonos-core.js";

const rooms = process.argv.slice(2);
const m = await getManager();

try {
  const coord = await resolveCoordinator(m);
  console.log(`PartyQueue resolves coordinator -> ${coord.Name} ${coord.Uuid}`);
} catch (err) {
  console.log(`PartyQueue coordinator resolve FAILED: ${err.message}`);
}

for (const name of rooms.length ? rooms : ["Office"]) {
  const d = m.Devices.find(
    (x) => String(x.Name).toLowerCase() === name.toLowerCase()
  );
  if (!d) {
    console.log(`\n[${name}] not found`);
    continue;
  }
  const [q, mi, ti, pi] = await Promise.all([
    d.GetQueue().catch(() => ({ Result: [] })),
    d.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({})),
    d.AVTransportService.GetTransportInfo({ InstanceID: 0 }).catch(() => ({})),
    d.AVTransportService.GetPositionInfo({ InstanceID: 0 }).catch(() => ({})),
  ]);
  const items = Array.isArray(q.Result) ? q.Result : [];
  console.log(
    `\n[${d.Name}] group=${d.GroupName} coordinator=${d.Coordinator?.Name ?? "(self)"}`
  );
  console.log(
    `   GetQueue rows: ${items.length} | NrTracks: ${mi.NrTracks} | ` +
      `state: ${ti.CurrentTransportState} | Track: ${pi.Track}`
  );
  console.log(`   CurrentURI: ${String(mi.CurrentURI ?? "").slice(0, 64)}`);
  console.log(`   TrackURI  : ${String(pi.TrackURI ?? "").slice(0, 74)}`);
  items.slice(0, 12).forEach((row, i) => {
    const uri = String(row.TrackUri ?? row.uri ?? "");
    const tag = /silence-ramp/.test(uri)
      ? "RAMP"
      : /silence-3s/.test(uri)
        ? "RESTORE"
        : /tts_proxy|media\/tts/.test(uri)
          ? "TTS "
          : "song";
    console.log(`     ${String(i + 1).padStart(2)}. ${tag} ${row.Title ?? "?"}`);
  });
}
process.exit(0);

#!/usr/bin/env node
/**
 * Poll one room's raw transport + queue and flag the reads that disagree.
 *
 * Sonos has been answering GetQueue/NrTracks with an empty queue while the
 * device actually holds tracks, which is what makes PartyQueue seek to rows it
 * thinks are missing (711) and then clear a queue it believes is empty. Logging
 * the disagreement is the only way to catch it in the act.
 *
 *   node scripts/watch-room-state.mjs Office
 */
import { getManager } from "../src/sonos-core.js";

const room = process.argv[2] || "Office";
const m = await getManager();
const dev = m.Devices.find(
  (d) => String(d.Name).toLowerCase() === room.toLowerCase()
);
if (!dev) throw new Error(`room not found: ${room}`);

console.log(`watching ${dev.Name} ${dev.Uuid}`);
let last = "";
for (;;) {
  const [queue, media, transport, position] = await Promise.all([
    dev.GetQueue().catch((e) => ({ Result: e.message })),
    dev.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({})),
    dev.AVTransportService.GetTransportInfo({ InstanceID: 0 }).catch(() => ({})),
    dev.AVTransportService.GetPositionInfo({ InstanceID: 0 }).catch(() => ({})),
  ]);
  const rows = Array.isArray(queue.Result) ? queue.Result.length : 0;
  const nr = Number(media.NrTracks ?? -1);
  const track = Number(position.Track ?? 0);
  const state = transport.CurrentTransportState ?? "?";
  const uri = String(position.TrackURI ?? "");
  const kind = /silence-ramp/.test(uri)
    ? "RAMP"
    : /tts_proxy|media\/tts/.test(uri)
      ? "TTS"
      : /silence-3s/.test(uri)
        ? "RESTORE"
        : uri
          ? "song"
          : "-";
  // The tell: a playhead sitting on a real row while the queue reads as empty.
  const suspect = track >= 1 && (rows === 0 || nr === 0) ? "  <== EMPTY READ" : "";
  const line = `rows=${rows} nr=${nr} track=${track} ${state} ${kind}${suspect}`;
  if (line !== last) {
    console.log(new Date().toISOString().slice(11, 19), line);
    last = line;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

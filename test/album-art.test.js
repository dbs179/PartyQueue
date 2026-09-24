import { test } from "node:test";
import assert from "node:assert/strict";
import {
  albumArtCacheKey,
  albumArtTrackId,
  buildAlbumArtProxyUrl,
  trackIdFromArtUrl,
} from "../src/album-art.js";

const TRACK_A = "0R7zNgqeiBBY1dXEKk9NOI";
const TRACK_B = "4uLU6hMCjMI75M1A2tKUQC";

test("trackIdFromArtUrl unwraps multi-encoded Sonos getaa URLs", () => {
  const encoded = `http://10.10.20.196:1400/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a${TRACK_A}%3fsid%3d12`;
  assert.equal(trackIdFromArtUrl(encoded), TRACK_A);
});

test("albumArtCacheKey prefers the playing track over a lagged getaa URL", () => {
  const staleGetaa = `http://10.10.20.196:1400/getaa?s=1&u=x-sonos-spotify:spotify%3atrack%3a${TRACK_A}`;
  assert.equal(
    albumArtCacheKey({ u: staleGetaa, t: TRACK_B }),
    `t:${TRACK_B}`
  );
  assert.equal(albumArtCacheKey({ t: TRACK_B }), `t:${TRACK_B}`);
  assert.equal(albumArtCacheKey({ u: staleGetaa }), `t:${TRACK_A}`);
});

test("albumArtTrackId accepts a bare Spotify id or a queue URI", () => {
  assert.equal(albumArtTrackId(TRACK_B, ""), TRACK_B);
  assert.equal(
    albumArtTrackId(`x-sonos-spotify:spotify%3atrack%3a${TRACK_B}?sid=12`, ""),
    TRACK_B
  );
});

test("buildAlbumArtProxyUrl pins t= to the playing URI even when DIDL art lags", () => {
  const staleArt = `/getaa?s=1&u=x-sonos-spotify:spotify%3atrack%3a${TRACK_A}`;
  const url = buildAlbumArtProxyUrl(
    staleArt,
    "10.10.20.196",
    `x-sonos-spotify:spotify:track:${TRACK_B}?sid=12`
  );
  assert.match(url, /^\/api\/albumart\?/);
  const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.equal(qs.get("t"), TRACK_B);
  assert.match(qs.get("u") || "", new RegExp(TRACK_A));
});

test("buildAlbumArtProxyUrl still serves Spotify art when AlbumArtUri is missing", () => {
  const url = buildAlbumArtProxyUrl(
    null,
    "10.10.20.196",
    `spotify:track:${TRACK_B}`
  );
  const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.equal(qs.get("t"), TRACK_B);
  assert.equal(qs.get("u"), null);
});

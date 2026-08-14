import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mainQueueCountLabel,
  partyQueueCountLabel,
  queueTrackSig,
  queueOriginBadgeHtml,
  queueGenreLabel,
  queueGenreBadgeHtml,
  queuePlaylistBadgeHtml,
  queueBadgeHtml,
} from "../public/js/queue-ui.js";

test("count labels", () => {
  assert.equal(mainQueueCountLabel(0), "");
  assert.equal(mainQueueCountLabel(3), "(3)");
  assert.equal(partyQueueCountLabel(0), "");
  assert.equal(partyQueueCountLabel(2), "2 queued");
});

test("queueTrackSig ignores absolute Sonos position shifts", () => {
  const a = {
    uri: "spotify:track:1",
    position: 5,
    title: "A",
    artist: "B",
    searched: true,
  };
  const b = { ...a, position: 2 };
  assert.equal(queueTrackSig(a), queueTrackSig(b));
});

test("queueTrackSig changes with genre flag and badges inputs", () => {
  const track = {
    uri: "spotify:track:1",
    position: 2,
    title: "A",
    artist: "B",
    searched: true,
    requestedBy: "Dave",
  };
  const a = queueTrackSig(track, { showQueueGenre: false });
  const b = queueTrackSig(track, { showQueueGenre: true });
  assert.notEqual(a, b);
  assert.equal(queueTrackSig(track, { showQueueGenre: false }), a);
});

test("queueTrackSig includes dedication and requestedByUser for row refresh", () => {
  const base = {
    uri: "spotify:track:1",
    title: "A",
    artist: "B",
    searched: true,
    requestedBy: "Dave",
    requestedByUser: "Dave",
  };
  assert.notEqual(
    queueTrackSig(base),
    queueTrackSig({ ...base, dedication: "For Sam" })
  );
  assert.notEqual(
    queueTrackSig(base),
    queueTrackSig({ ...base, requestedByUser: "Maria" })
  );
});

test("queueOriginBadgeHtml covers dedication, request, discover, era, random", () => {
  assert.match(
    queueOriginBadgeHtml({ moodPick: true }, { eraLabel: "80s" }),
    /80s Hit/
  );
  assert.match(queueOriginBadgeHtml({ discovered: true }), /Discover/);
  assert.match(
    queueOriginBadgeHtml({ reactionSet: "loved" }),
    /Most Loved/
  );
  assert.match(
    queueOriginBadgeHtml({ reactionSet: "hated" }),
    /Most Hated/
  );
  assert.match(
    queueOriginBadgeHtml({ reactionSet: "requested" }),
    /Most Requested/
  );
  assert.match(
    queueOriginBadgeHtml({ searched: true, dedication: "For Sam", requestedBy: "Alex" }),
    /For Sam/
  );
  assert.match(
    queueOriginBadgeHtml({ searched: true, requestedBy: "Alex" }),
    /Requested/
  );
  assert.equal(queueOriginBadgeHtml({ djVoice: true }), "");
  assert.match(queueOriginBadgeHtml({}), /Random/);
});

test("queueGenreLabel prefers genreLabels then genreLabel then lane", () => {
  assert.equal(queueGenreLabel({ genreLabels: ["Pop"], genreLabel: "Rock" }), "Pop");
  assert.equal(queueGenreLabel({ genreLabel: "Rock", genreLane: "metal" }), "Rock");
  assert.equal(queueGenreLabel({ genreLane: "metal" }), "metal");
  assert.equal(queueGenreLabel({ djVoice: true, genreLabel: "Rock" }), "");
  assert.equal(queueGenreLabel({}), "");
});

test("genre and playlist badges respect showQueueGenre", () => {
  const track = {
    genreLabel: "Pop",
    fromPlaylist: true,
  };
  assert.equal(queueGenreBadgeHtml(track, { showQueueGenre: false }), "");
  assert.match(queueGenreBadgeHtml(track, { showQueueGenre: true }), /Pop/);
  assert.doesNotMatch(
    queueGenreBadgeHtml(track, { showQueueGenre: true }),
    /is-unknown/
  );
  assert.equal(queuePlaylistBadgeHtml(track, { showQueueGenre: false }), "");
  assert.match(
    queuePlaylistBadgeHtml(track, { showQueueGenre: true }),
    /From Playlists/
  );
  assert.equal(
    queueGenreBadgeHtml({ ...track, djVoice: true }, { showQueueGenre: true }),
    ""
  );
});

test("missing genre shows muted Unknown badge when showQueueGenre is on", () => {
  const html = queueGenreBadgeHtml({}, { showQueueGenre: true });
  assert.match(html, /Unknown/);
  assert.match(html, /is-unknown/);
  assert.match(html, /Genre not matched yet/);
});

test("queueBadgeHtml concatenates origin + genre + playlist", () => {
  const html = queueBadgeHtml(
    {
      searched: true,
      requestedBy: "Alex",
      genreLabel: "Rock",
      fromPlaylist: true,
    },
    { showQueueGenre: true }
  );
  assert.match(html, /Requested/);
  assert.match(html, /Rock/);
  assert.match(html, /From Playlists/);
});

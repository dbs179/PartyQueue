import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-reactions-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_REACTIONS_FILE = TMP_FILE;

const reactions = await import("../src/reactions.js");

beforeEach(() => {
  reactions.clearReactions();
  try {
    fs.rmSync(TMP_FILE, { force: true });
  } catch {
    /* ignore */
  }
});

test("mood reaction is one per guest; tap again clears", () => {
  const a = reactions.setReaction("t1", "up", "guestaaaa", {
    name: "Song",
    artist: "Art",
  });
  assert.equal(a.ok, true);
  assert.equal(a.up, 1);
  assert.equal(a.mine, "up");

  const again = reactions.setReaction("t1", "up", "guestaaaa");
  assert.equal(again.up, 0);
  assert.equal(again.mine, null);
});

test("switching mood moves the vote; mic is independent", () => {
  reactions.setReaction("t1", "fire", "guestbbbb");
  const switched = reactions.setReaction("t1", "heart", "guestbbbb");
  assert.equal(switched.fire, 0);
  assert.equal(switched.heart, 1);
  assert.equal(switched.mine, "heart");

  const micOn = reactions.setReaction("t1", "mic", "guestbbbb", {
    name: "Song",
    artist: "Art",
  });
  assert.equal(micOn.mic, 1);
  assert.equal(micOn.micMine, true);
  assert.equal(micOn.heart, 1);
  assert.equal(micOn.mine, "heart");

  const micOff = reactions.setReaction("t1", "mic", "guestbbbb");
  assert.equal(micOff.mic, 0);
  assert.equal(micOff.micMine, false);
  assert.equal(micOff.heart, 1);
});

test("two guests can each have one mood reaction", () => {
  reactions.setReaction("t1", "up", "guest1111");
  reactions.setReaction("t1", "down", "guest2222");
  const row = reactions.getReactions("t1");
  assert.equal(row.up, 1);
  assert.equal(row.down, 1);
});

test("listKaraokeTracks ranks by unique mic voters", () => {
  reactions.setReaction("a", "mic", "guest1111", {
    name: "Song A",
    artist: "Art A",
  });
  reactions.setReaction("b", "mic", "guest1111", {
    name: "Song B",
    artist: "Art B",
  });
  reactions.setReaction("b", "mic", "guest2222", {
    name: "Song B",
    artist: "Art B",
  });
  const list = reactions.listKaraokeTracks(10);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "b");
  assert.equal(list[0].count, 2);
  assert.equal(list[1].id, "a");
  assert.equal(list[1].count, 1);
});

test("rejects unknown kinds and short guest ids", () => {
  assert.equal(reactions.setReaction("t1", "clap", "guestaaaa").ok, false);
  assert.equal(reactions.setReaction("t1", "up", "short").ok, false);
});

test("persists votes to disk", () => {
  reactions.setReaction("t9", "fire", "guestpersist1", { by: "Alex" });
  reactions.setReaction("t9", "mic", "guestpersist1", {
    name: "Mic Song",
    artist: "Singer",
    by: "Alex",
  });
  reactions.flushReactionsPersist(); // writes are debounced
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.equal(raw.byTrack.t9.votes.guestpersist1.kind, "fire");
  assert.equal(raw.byTrack.t9.votes.guestpersist1.by, "Alex");
  assert.equal(raw.byTrack.t9.micVotes.guestpersist1.by, "Alex");
  assert.equal(raw.byTrack.t9.name, "Mic Song");
});

test("clearMoodReactions keeps karaoke; clearKaraokeReactions keeps mood", () => {
  reactions.setReaction("t1", "heart", "guest1111", {
    name: "Song",
    artist: "Art",
  });
  reactions.setReaction("t1", "mic", "guest1111");
  reactions.setReaction("t2", "up", "guest2222");
  reactions.setReaction("t3", "mic", "guest2222", {
    name: "Mic Only",
    artist: "Solo",
  });

  reactions.clearMoodReactions();
  assert.equal(reactions.getReactions("t1").heart, 0);
  assert.equal(reactions.getReactions("t1").mic, 1);
  assert.equal(reactions.getReactions("t2").up, 0);
  assert.equal(reactions.listKaraokeTracks(10).length, 2);

  reactions.setReaction("t1", "fire", "guest1111");
  reactions.clearKaraokeReactions();
  assert.equal(reactions.getReactions("t1").fire, 1);
  assert.equal(reactions.getReactions("t1").mic, 0);
  assert.equal(reactions.listKaraokeTracks(10).length, 0);
});

test("lists include display names; empty by shows as Guest", () => {
  reactions.setReaction("t1", "fire", "guest1111", {
    name: "Hot Song",
    artist: "Band",
    by: "Alex",
  });
  reactions.setReaction("t1", "heart", "guest2222", { by: "Riley" });
  reactions.setReaction("t1", "mic", "guest1111", { by: "Alex" });
  reactions.setReaction("t1", "mic", "guest3333", { by: "Mark" });

  const karaoke = reactions.listKaraokeTracks(10);
  assert.equal(karaoke.length, 1);
  assert.deepEqual(karaoke[0].by, ["Alex", "Mark"]);

  const reacted = reactions.listReactedTracks(10);
  assert.equal(reacted.length, 1);
  assert.equal(reacted[0].count, 2);
  const fire = reacted[0].reactions.find((r) => r.kind === "fire");
  const heart = reacted[0].reactions.find((r) => r.kind === "heart");
  assert.deepEqual(fire.by, ["Alex"]);
  assert.deepEqual(heart.by, ["Riley"]);

  reactions.setReaction("t2", "up", "guestaaaa", {
    name: "No Name",
    artist: "Anon",
  });
  reactions.setReaction("t2", "mic", "guestbbbb");
  const karaoke2 = reactions.listKaraokeTracks(10).find((r) => r.id === "t2");
  assert.deepEqual(karaoke2.by, ["Guest"]);
  const reacted2 = reactions.listReactedTracks(10).find((r) => r.id === "t2");
  assert.deepEqual(reacted2.reactions.find((r) => r.kind === "up").by, [
    "Guest",
  ]);
});

test("mood switch updates by; mic stays independent", () => {
  reactions.setReaction("t1", "fire", "guestcccc", { by: "Alex" });
  reactions.setReaction("t1", "mic", "guestcccc", { by: "Alex" });
  reactions.setReaction("t1", "heart", "guestcccc", { by: "Casey" });
  const reacted = reactions.listReactedTracks(10);
  assert.equal(reacted[0].reactions.length, 1);
  assert.equal(reacted[0].reactions[0].kind, "heart");
  assert.deepEqual(reacted[0].reactions[0].by, ["Casey"]);
  assert.deepEqual(reactions.listKaraokeTracks(10)[0].by, ["Alex"]);
});

test("top liked, party music, and most hated rank by kind groups", () => {
  reactions.setReaction("liked1", "fire", "guest1111", {
    name: "Hot",
    artist: "A",
    by: "Alex",
  });
  reactions.setReaction("liked1", "heart", "guest2222", { by: "Riley" });
  reactions.setReaction("liked2", "up", "guest3333", {
    name: "Okay",
    artist: "B",
    by: "Mark",
  });
  reactions.setReaction("party1", "party", "guest1111", {
    name: "Banger",
    artist: "C",
    by: "Alex",
  });
  reactions.setReaction("hate1", "down", "guest2222", {
    name: "Nope",
    artist: "D",
    by: "Riley",
  });
  reactions.setReaction("hate1", "vomit", "guest3333", { by: "Mark" });
  // Laugh alone should not appear on liked / party / hated lists
  reactions.setReaction("funny1", "laugh", "guest1111", {
    name: "Joke",
    artist: "E",
    by: "Alex",
  });

  const liked = reactions.listTopLikedTracks(10);
  assert.equal(liked[0].id, "liked1");
  assert.equal(liked[0].count, 2);
  assert.equal(liked.length, 2);

  const party = reactions.listPartyMusicTracks(10);
  assert.equal(party.length, 1);
  assert.equal(party[0].id, "party1");

  const hated = reactions.listMostHatedTracks(10);
  assert.equal(hated.length, 1);
  assert.equal(hated[0].id, "hate1");
  assert.equal(hated[0].count, 2);

  assert.ok(!liked.some((r) => r.id === "funny1"));
  assert.ok(!party.some((r) => r.id === "funny1"));
  assert.ok(!hated.some((r) => r.id === "funny1"));
});

test("legacy string and boolean vote shapes still count as Guest", () => {
  fs.writeFileSync(
    TMP_FILE,
    JSON.stringify({
      byTrack: {
        old1: {
          name: "Old Song",
          artist: "Old Art",
          votes: { guestlegacy1: "fire" },
          micVotes: { guestlegacy2: true },
          micAt: 1000,
        },
      },
    })
  );
  reactions.resetCacheForTests();

  assert.equal(reactions.getReactions("old1").fire, 1);
  assert.equal(reactions.getReactions("old1").mic, 1);
  assert.deepEqual(reactions.listKaraokeTracks(10)[0].by, ["Guest"]);
  const reacted = reactions.listReactedTracks(10);
  assert.deepEqual(reacted[0].reactions[0].by, ["Guest"]);
  assert.equal(reacted[0].reactions[0].kind, "fire");
});

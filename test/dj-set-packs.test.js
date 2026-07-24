import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  armDjNextSet,
  clearDjNextSet,
  consumeDjNextSet,
  getDjNextSetState,
  getDjSetPack,
  listDjSetPacks,
  peekDjNextSet,
  resetDjSetPacksForTests,
} from "../src/dj-set-packs.js";
import {
  resetDjAnnounceOrdinal,
  writeSetScript,
} from "../src/dj-voice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = fs.readFileSync(
  path.join(__dirname, "../src/routes/api.js"),
  "utf8"
);

// writeSetScript must exercise the offline template path, never a live
// Home Assistant / LLM call: stash real credentials for the duration.
// getHaCredentials() reads env + store lazily, so this is safe post-import.
const HA_STORE = path.join(__dirname, "..", "data", "home-assistant.json");
const HA_STORE_BAK = HA_STORE + ".testbak";
let savedHaUrl;
let savedHaToken;

describe("dj-set-packs", () => {
  before(() => {
    savedHaUrl = process.env.HA_URL;
    savedHaToken = process.env.HA_TOKEN;
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
    if (fs.existsSync(HA_STORE)) fs.renameSync(HA_STORE, HA_STORE_BAK);
  });

  after(() => {
    if (savedHaUrl != null) process.env.HA_URL = savedHaUrl;
    if (savedHaToken != null) process.env.HA_TOKEN = savedHaToken;
    if (fs.existsSync(HA_STORE_BAK)) fs.renameSync(HA_STORE_BAK, HA_STORE);
  });

  beforeEach(() => {
    resetDjSetPacksForTests();
    resetDjAnnounceOrdinal();
  });

  it("lists maria-cooking in the registry", () => {
    const packs = listDjSetPacks();
    assert.ok(packs.some((pack) => pack.id === "maria-cooking"));
    const pack = getDjSetPack("maria-cooking");
    assert.equal(pack.label, "Maria is cooking dinner");
    assert.ok(pack.intros.length >= 4);
    assert.ok(pack.blurbs.length >= 4);
    assert.ok(pack.outros.length >= 4);
  });

  it("rejects unknown packs", () => {
    assert.throws(
      () => armDjNextSet("not-a-real-pack"),
      (err) =>
        err.code === "UNKNOWN_DJ_SET_PACK" &&
        /Known packs:.*maria-cooking/i.test(err.message)
    );
    assert.equal(getDjNextSetState().armed, false);
  });

  it("arms, peeks, and consumes a one-shot pack", () => {
    const armed = armDjNextSet("maria-cooking", { now: 1_000, ttlMs: 60_000 });
    assert.equal(armed.armed, true);
    assert.equal(armed.pack, "maria-cooking");
    assert.equal(armed.expiresAt, 61_000);
    assert.ok(armed.packs.some((pack) => pack.id === "maria-cooking"));

    const peeked = peekDjNextSet({ now: 2_000 });
    assert.equal(peeked.id, "maria-cooking");
    assert.equal(getDjNextSetState({ now: 2_000 }).armed, true);

    const consumed = consumeDjNextSet({ now: 2_000 });
    assert.equal(consumed.id, "maria-cooking");
    assert.equal(getDjNextSetState({ now: 2_000 }).armed, false);
    assert.equal(peekDjNextSet({ now: 2_000 }), null);
  });

  it("expires a stale arm", () => {
    armDjNextSet("maria-cooking", { now: 1_000, ttlMs: 100 });
    assert.equal(peekDjNextSet({ now: 1_200 }), null);
    assert.equal(getDjNextSetState({ now: 1_200 }).armed, false);
  });

  it("clear disarms without speaking", () => {
    armDjNextSet("maria-cooking");
    assert.equal(clearDjNextSet().armed, false);
    assert.equal(peekDjNextSet(), null);
  });

  it("registers host-auth next-set API routes", () => {
    assert.match(apiSrc, /app\.get\("\/api\/dj-voice\/next-set"/);
    assert.match(apiSrc, /app\.post\("\/api\/dj-voice\/next-set"/);
    assert.match(apiSrc, /app\.delete\("\/api\/dj-voice\/next-set"/);
    assert.match(apiSrc, /armDjNextSet/);
    assert.match(apiSrc, /requireHost/);
  });

  it("writeSetScript uses the armed pack once, then normal banks", async () => {
    const pack = getDjSetPack("maria-cooking");
    armDjNextSet("maria-cooking");

    const first = await writeSetScript({
      event: "session_refill",
      count: 5,
      highlights: [{ artist: "Test Artist", title: "Test Song" }],
      nameIntro: false,
      openerShape: "cold_open",
      includeOutro: true,
    });
    // LLM may paraphrase the intro; outro cues are usually kept literally.
    const usedIntro = pack.intros.some((intro) => first.includes(intro));
    const usedOutro = pack.outros.some((outro) => first.includes(outro));
    assert.ok(
      usedIntro || usedOutro || /kitchen|dinner|Maria|house boss/i.test(first),
      `expected pack flavor in: ${first}`
    );
    assert.equal(getDjNextSetState().armed, false);

    await writeSetScript({
      event: "session_refill",
      count: 5,
      highlights: [{ artist: "Other Artist", title: "Other Song" }],
      nameIntro: false,
      openerShape: "cold_open",
      includeOutro: true,
    });
    assert.equal(
      getDjNextSetState().armed,
      false,
      "second announce must not re-arm the one-shot pack"
    );
  });
});

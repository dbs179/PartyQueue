import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDjForAnnounce,
  DJ_PERSONA_HOLY_ROLLER,
  DJ_PERSONA_SISTER_STATIC,
} from "../src/dj-roster.js";

function rngFrom(values) {
  const queue = [...values];
  return () => (queue.length ? queue.shift() : 0.99);
}

const mix = {
  djRosterMode: "mix",
  djMixHolyRollerPercent: 70,
  djBanterPercent: 15,
};

test("default and Holy Roller mode always pick Holy Roller", () => {
  const a = resolveDjForAnnounce({
    kind: "set",
    roster: { djRosterMode: "holy-roller" },
  });
  assert.equal(a.type, "solo");
  assert.equal(a.personaId, DJ_PERSONA_HOLY_ROLLER);

  const b = resolveDjForAnnounce({
    kind: "set",
    roster: { djRosterMode: DJ_PERSONA_HOLY_ROLLER },
  });
  assert.equal(b.personaId, DJ_PERSONA_HOLY_ROLLER);
});

test("Sister Static mode always picks Sister Static", () => {
  const a = resolveDjForAnnounce({
    kind: "shout",
    roster: { djRosterMode: DJ_PERSONA_SISTER_STATIC },
  });
  assert.equal(a.type, "solo");
  assert.equal(a.personaId, DJ_PERSONA_SISTER_STATIC);
});

test("last-call recap is always Holy Roller", () => {
  const a = resolveDjForAnnounce({
    kind: "recap",
    roster: { ...mix, djRosterMode: DJ_PERSONA_SISTER_STATIC },
    rng: () => 0,
  });
  assert.equal(a.type, "solo");
  assert.equal(a.personaId, DJ_PERSONA_HOLY_ROLLER);
});

test("Mix set announce can roll a Holy Roller then Sister Static duet", () => {
  const a = resolveDjForAnnounce({
    kind: "set",
    roster: { ...mix, djBanterPercent: 100 },
    rng: rngFrom([0]),
  });
  assert.equal(a.type, "duet");
  assert.equal(a.leadId, DJ_PERSONA_HOLY_ROLLER);
  assert.equal(a.punchId, DJ_PERSONA_SISTER_STATIC);
});

test("Mix shouts never duet even at 100% banter", () => {
  const a = resolveDjForAnnounce({
    kind: "shout",
    roster: { ...mix, djBanterPercent: 100, djMixHolyRollerPercent: 0 },
    rng: () => 0,
  });
  assert.equal(a.type, "solo");
  assert.equal(a.personaId, DJ_PERSONA_SISTER_STATIC);
  assert.equal(a.punchId, null);
});

test("Mix missed banter uses the Holy Roller mix percent", () => {
  const hr = resolveDjForAnnounce({
    kind: "set",
    roster: { ...mix, djBanterPercent: 0, djMixHolyRollerPercent: 100 },
    rng: () => 0.5,
  });
  assert.equal(hr.type, "solo");
  assert.equal(hr.personaId, DJ_PERSONA_HOLY_ROLLER);

  const ss = resolveDjForAnnounce({
    kind: "set",
    roster: { ...mix, djBanterPercent: 0, djMixHolyRollerPercent: 0 },
    rng: () => 0.5,
  });
  assert.equal(ss.personaId, DJ_PERSONA_SISTER_STATIC);
});

test("Mix anti-streak flips the third consecutive solo when mix is 20–80", () => {
  const flipped = resolveDjForAnnounce({
    kind: "set",
    roster: { ...mix, djBanterPercent: 0, djMixHolyRollerPercent: 70 },
    lastSolo: { personaId: DJ_PERSONA_HOLY_ROLLER, streak: 2 },
    rng: () => 0.5,
  });
  assert.equal(flipped.type, "solo");
  assert.equal(flipped.personaId, DJ_PERSONA_SISTER_STATIC);

  const extreme = resolveDjForAnnounce({
    kind: "set",
    roster: { ...mix, djBanterPercent: 0, djMixHolyRollerPercent: 90 },
    lastSolo: { personaId: DJ_PERSONA_HOLY_ROLLER, streak: 2 },
    rng: () => 0.5,
  });
  assert.equal(extreme.personaId, DJ_PERSONA_HOLY_ROLLER);
});

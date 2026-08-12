import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSonosPlayerType,
  lookupSonosPlayerType,
  iconForSonosGroup,
  DEFAULT_SONOS_PLAYER_TYPE,
  GROUP_SONOS_ICON,
} from "../src/sonos-player-types.js";
import {
  iconForGroupChip,
  iconForSpeakerChip,
  sonosIconUrl,
} from "../public/js/sonos-player-types.js";

test("normalizeSonosPlayerType accepts catalog ids only", () => {
  assert.equal(normalizeSonosPlayerType("Arc"), "arc");
  assert.equal(normalizeSonosPlayerType("play1"), "play1");
  assert.equal(normalizeSonosPlayerType("group"), null);
  assert.equal(normalizeSonosPlayerType("nope"), null);
});

test("lookupSonosPlayerType is case-insensitive on room names", () => {
  const map = { Kitchen: "arc", Patio: "move" };
  assert.equal(lookupSonosPlayerType(map, "kitchen"), "arc");
  assert.equal(lookupSonosPlayerType(map, "PATIO"), "move");
  assert.equal(lookupSonosPlayerType(map, "Den"), null);
});

test("iconForSonosGroup uses group icon when multi-member", () => {
  const map = { Kitchen: "arc", Den: "play1" };
  assert.equal(
    iconForSonosGroup(
      { members: ["Kitchen", "Den"], memberCount: 2, coordinator: "Kitchen" },
      map
    ),
    GROUP_SONOS_ICON
  );
  assert.equal(
    iconForSonosGroup(
      { members: ["Kitchen"], memberCount: 1, coordinator: "Kitchen" },
      map
    ),
    "arc"
  );
  assert.equal(
    iconForSonosGroup(
      { members: ["Office"], memberCount: 1, coordinator: "Office" },
      map
    ),
    DEFAULT_SONOS_PLAYER_TYPE
  );
});

test("client icon helpers match solo vs group rules", () => {
  const speakers = [
    { name: "Kitchen", playerType: "amp" },
    { name: "Den", playerType: "roam" },
  ];
  assert.equal(
    iconForGroupChip(
      {
        members: ["Kitchen", "Den"],
        memberCount: 2,
        icon: "group",
      },
      speakers
    ),
    "group"
  );
  assert.equal(
    iconForGroupChip(
      { members: ["Kitchen"], memberCount: 1, coordinator: "Kitchen" },
      speakers
    ),
    "amp"
  );
  // Live speaker type wins over a stale group.icon from an earlier payload.
  assert.equal(
    iconForGroupChip(
      {
        members: ["Kitchen"],
        memberCount: 1,
        coordinator: "Kitchen",
        icon: "default",
      },
      [{ name: "Kitchen", playerType: "arc" }]
    ),
    "arc"
  );
  assert.equal(iconForSpeakerChip({ playerType: "connect" }), "connect");
  assert.equal(iconForSpeakerChip({}), "default");
  assert.match(sonosIconUrl("move"), /^\/sonos-icons\/move\.svg\?v=/);
  assert.match(sonosIconUrl("group"), /^\/sonos-icons\/group\.svg\?v=/);
  assert.match(sonosIconUrl("nope"), /^\/sonos-icons\/default\.svg\?v=/);
});

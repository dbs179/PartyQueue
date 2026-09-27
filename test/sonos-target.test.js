import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickGroupByTarget } from "../src/sonos.js";
import { resolveTargetGroup } from "../src/sonos-queue-policy.js";

const groups = [
  {
    coordinator: { name: "Kitchen" },
    members: [{ name: "Kitchen" }, { name: "Dining Room" }],
  },
  {
    coordinator: { name: "Living Room" },
    members: [{ name: "Living Room" }],
  },
  {
    coordinator: { name: "Patio" },
    members: [{ name: "Patio" }, { name: "Deck" }],
  },
];

describe("pickGroupByTarget", () => {
  it("returns the first group when no target is set", () => {
    assert.equal(pickGroupByTarget(groups, null), groups[0]);
    assert.equal(pickGroupByTarget(groups, ""), groups[0]);
  });

  it("matches by coordinator name (case-insensitive)", () => {
    assert.equal(pickGroupByTarget(groups, "living room"), groups[1]);
  });

  it("matches by member name when coordinator differs", () => {
    assert.equal(pickGroupByTarget(groups, "Dining Room"), groups[0]);
    assert.equal(pickGroupByTarget(groups, "deck"), groups[2]);
  });

  it("returns null when nothing matches", () => {
    assert.equal(pickGroupByTarget(groups, "Attic"), null);
    assert.equal(pickGroupByTarget([], "Kitchen"), null);
  });
});

const picker = [
  { coordinator: "Kitchen", label: "Kitchen + Dining Room", isTarget: false },
  { coordinator: "Living Room", label: "Living Room", isTarget: true },
];

describe("resolveTargetGroup", () => {
  it("uses the group the topology actually marked as the target", () => {
    const out = resolveTargetGroup(picker, "Living Room");
    assert.equal(out.visible, true);
    assert.equal(out.group, picker[1]);
  });

  it("defaults to the first group only when nothing has been chosen yet", () => {
    const unset = picker.map((g) => ({ ...g, isTarget: false }));
    const out = resolveTargetGroup(unset, null);
    assert.equal(out.visible, true);
    assert.equal(out.group, unset[0]);
  });

  it("does not invent a target when the chosen room is missing from this read", () => {
    const unseen = picker.map((g) => ({ ...g, isTarget: false }));
    const out = resolveTargetGroup(unseen, "Office");
    assert.equal(out.visible, false);
    assert.equal(out.group, null);
  });
});

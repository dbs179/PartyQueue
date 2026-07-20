import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickGroupByTarget } from "../src/sonos.js";

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

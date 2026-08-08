import { test } from "node:test";
import assert from "node:assert/strict";
import { speakersFromGroups } from "../public/js/speakers.js";

test("speakersFromGroups flattens members and flags the target group", () => {
  const speakers = speakersFromGroups([
    {
      label: "Kitchen + Patio",
      coordinator: "Kitchen",
      isTarget: true,
      members: ["Kitchen", "Patio"],
    },
    {
      label: "Bedroom",
      coordinator: "Bedroom",
      isTarget: false,
      members: ["Bedroom"],
    },
  ]);
  assert.deepEqual(
    speakers.map((s) => s.name),
    ["Bedroom", "Kitchen", "Patio"]
  );
  assert.deepEqual(
    speakers.find((s) => s.name === "Kitchen"),
    {
      name: "Kitchen",
      inTargetGroup: true,
      isTargetCoordinator: true,
    }
  );
  assert.deepEqual(
    speakers.find((s) => s.name === "Bedroom"),
    {
      name: "Bedroom",
      inTargetGroup: false,
      isTargetCoordinator: false,
    }
  );
});

test("speakersFromGroups falls back to the first group when none is target", () => {
  const speakers = speakersFromGroups([
    { coordinator: "A", members: ["A", "B"] },
    { coordinator: "C", members: ["C"] },
  ]);
  assert.equal(speakers.find((s) => s.name === "A").inTargetGroup, true);
  assert.equal(speakers.find((s) => s.name === "C").inTargetGroup, false);
});

test("speakersFromGroups handles empty input", () => {
  assert.deepEqual(speakersFromGroups([]), []);
  assert.deepEqual(speakersFromGroups(null), []);
});

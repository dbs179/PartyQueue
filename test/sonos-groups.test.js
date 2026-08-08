import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGroupsPayload,
  ungroupAllToastMessage,
} from "../public/js/sonos-groups.js";

test("normalizeGroupsPayload uses speakers when provided", () => {
  const speakers = [{ name: "Kitchen", inTargetGroup: true }];
  const out = normalizeGroupsPayload({
    groups: [{ label: "Kitchen", isTarget: true }],
    speakers,
    targetLabel: "Kitchen",
  });
  assert.equal(out.speakers, speakers);
  assert.equal(out.targetLabel, "Kitchen");
});

test("normalizeGroupsPayload derives speakers and target label", () => {
  const out = normalizeGroupsPayload({
    groups: [
      {
        label: "Patio",
        isTarget: false,
        coordinator: "Patio",
        members: ["Patio"],
      },
      {
        label: "Kitchen",
        isTarget: true,
        coordinator: "Kitchen",
        members: ["Kitchen", "Den"],
      },
    ],
  });
  assert.equal(out.targetLabel, "Kitchen");
  assert.ok(out.speakers.some((s) => s.name === "Den" && s.inTargetGroup));
});

test("ungroupAllToastMessage pluralizes", () => {
  assert.equal(ungroupAllToastMessage(0), "All speakers were already alone");
  assert.equal(ungroupAllToastMessage(1), "Ungrouped 1 speaker");
  assert.equal(ungroupAllToastMessage(3), "Ungrouped 3 speakers");
});

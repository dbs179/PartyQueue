import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGroupsPayload,
  ungroupAllToastMessage,
  sonosIconImgHtml,
  isGroupTileSelectClick,
} from "../public/js/sonos-groups.js";
import { iconForGroupChip } from "../public/js/sonos-player-types.js";

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

test("sonosIconImgHtml escapes url and alt", () => {
  const html = sonosIconImgHtml("arc", 'Arc "bar"');
  assert.match(html, /src="\/sonos-icons\/arc\.svg\?v=/);
  assert.match(html, /alt="Arc &quot;bar&quot;"/);
});

test("isGroupTileSelectClick ignores icon button hits", () => {
  const icon = { closest: (sel) => (sel === ".group-chip-icon-btn" ? icon : null) };
  const label = { closest: () => null };
  assert.equal(isGroupTileSelectClick({ target: icon }), false);
  assert.equal(isGroupTileSelectClick({ target: label }), true);
  assert.equal(isGroupTileSelectClick({ target: null }), true);
});

test("grouped chips prefer shared group icon over member types", () => {
  const speakers = [
    { name: "Kitchen", playerType: "arc" },
    { name: "Den", playerType: "play1" },
  ];
  assert.equal(
    iconForGroupChip(
      { members: ["Kitchen", "Den"], memberCount: 2 },
      speakers
    ),
    "group"
  );
});

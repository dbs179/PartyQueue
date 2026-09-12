#!/usr/bin/env node
/**
 * Compare the coordinator PartyQueue would send transport commands to against
 * the coordinator Sonos actually reports for that room's group. Read-only.
 */
import { getManager, resolveCoordinator } from "../src/sonos-core.js";

const m = await getManager();
const target = process.argv[2] || "Office";

const resolved = await resolveCoordinator(m).catch((e) => {
  console.log(`resolveCoordinator failed: ${e.message}`);
  return null;
});
if (resolved) {
  console.log(
    `PartyQueue would send transport to: ${resolved.Name} (${resolved.Uuid})`
  );
}

// Ask a device for the live topology rather than trusting the manager cache.
const dev = m.Devices.find(
  (d) => String(d.Name).toLowerCase() === target.toLowerCase()
);
if (!dev) {
  console.log(`${target} not found`);
  process.exit(0);
}

const state = await dev.ZoneGroupTopologyService.GetZoneGroupState();
const groups = state?.ZoneGroupState?.ZoneGroups?.ZoneGroup ?? [];
const list = Array.isArray(groups) ? groups : [groups];
console.log("\nLIVE ZONE TOPOLOGY (straight from the speaker):");
for (const g of list) {
  const members = Array.isArray(g.ZoneGroupMember)
    ? g.ZoneGroupMember
    : [g.ZoneGroupMember].filter(Boolean);
  const coordUuid = g.Coordinator;
  const coordName =
    members.find((x) => x.UUID === coordUuid)?.ZoneName ?? coordUuid;
  console.log(
    `  group coordinator=${coordName} members=[${members
      .map((x) => x.ZoneName + (x.UUID === coordUuid ? "*" : ""))
      .join(", ")}]`
  );
  const hit = members.find(
    (x) => String(x.ZoneName).toLowerCase() === target.toLowerCase()
  );
  if (hit) {
    console.log(
      `    -> ${target} IS ${hit.UUID === coordUuid ? "" : "NOT "}the coordinator ` +
        `of its group (true coordinator: ${coordName} / ${coordUuid})`
    );
  }
}

console.log(
  `\nmanager cache says: ${target}.GroupName=${dev.GroupName} ` +
    `Coordinator=${dev.Coordinator?.Name ?? "(self)"} ` +
    `CoordinatorUuid=${dev.Coordinator?.Uuid ?? dev.Uuid}`
);
process.exit(0);

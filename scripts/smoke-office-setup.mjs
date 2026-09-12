#!/usr/bin/env node
/**
 * Isolate the Office speaker for live smoke runs, then put the house back.
 * Saves the current grouping and volume to .smoke-room-state.json so a crashed
 * run can still be undone.
 *
 *   node scripts/smoke-office-setup.mjs isolate
 *   node scripts/smoke-office-setup.mjs restore
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { api, ensureHostAuth, sleep, vol, nudgeVolumeTo } from "./smoke-lib.mjs";

const STATE_FILE = new URL("../.smoke-room-state.json", import.meta.url);
const ROOM = process.env.PQ_SMOKE_ROOM || "Office";
const TEST_VOLUME = Math.max(
  0,
  Math.min(40, Math.round(Number(process.env.PQ_SMOKE_VOLUME) || 8))
);

async function isolate() {
  await ensureHostAuth();
  const groups = await api("GET", "/api/groups");
  const before = {
    targetRoom: groups.targetRoom,
    volume: await vol(),
    groups: groups.groups.map((g) => ({
      coordinator: g.coordinator,
      members: g.members,
    })),
    savedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(before, null, 2));
  console.log("saved layout:", JSON.stringify(before));

  const home = groups.groups.find((g) => g.members.includes(ROOM));
  if (home && home.members.length > 1) {
    console.log(`leaving ${ROOM} from "${home.label}"`);
    await api("POST", "/api/groups/leave", { room: ROOM });
    await sleep(3000);
  }
  await api("POST", "/api/groups/select", { room: ROOM });
  await sleep(1500);

  const after = await api("GET", "/api/groups");
  console.log("target now:", after.targetRoom, "|", after.targetLabel);
  if (after.targetRoom !== ROOM) {
    throw new Error(`target is ${after.targetRoom}, expected ${ROOM}`);
  }
  const members = after.groups.find((g) => g.coordinator === ROOM)?.members ?? [];
  if (members.length !== 1) {
    throw new Error(`${ROOM} still grouped with ${members.join(", ")}`);
  }
  const v = await nudgeVolumeTo(TEST_VOLUME);
  console.log(`volume ${before.volume} -> ${v}`);
}

async function restore() {
  await ensureHostAuth();
  if (!existsSync(STATE_FILE)) {
    console.log("no saved layout; nothing to restore");
    return;
  }
  const before = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  console.log("restoring:", JSON.stringify(before));

  try {
    await api("POST", "/api/pause");
  } catch {
    /* already stopped */
  }
  await nudgeVolumeTo(Math.min(before.volume, 25));

  // Re-select the original coordinator first, then pull its members back in:
  // /api/groups/join always attaches to the current target.
  const home = before.groups.find((g) => g.members.length > 1);
  if (home) {
    await api("POST", "/api/groups/select", { room: home.coordinator });
    await sleep(1500);
    for (const member of home.members) {
      if (member === home.coordinator) continue;
      console.log(`rejoining ${member}`);
      await api("POST", "/api/groups/join", { room: member });
      await sleep(2500);
    }
  }
  await api("POST", "/api/groups/select", { room: before.targetRoom });
  await sleep(1500);
  const v = await nudgeVolumeTo(before.volume);

  const after = await api("GET", "/api/groups");
  console.log("target now:", after.targetRoom, "|", after.targetLabel);
  console.log("volume now:", v);
  rmSync(STATE_FILE, { force: true });
}

const mode = process.argv[2];
if (mode !== "isolate" && mode !== "restore") {
  console.error("usage: smoke-office-setup.mjs <isolate|restore>");
  process.exit(2);
}
await (mode === "isolate" ? isolate() : restore());

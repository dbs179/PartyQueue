// Checkbox overlay for a Mood holiday.
//
// Turning Halloween on checks playlists whose names match Halloween
// ("Holidays - Halloween", and the same name rules as playlistMatchesHoliday).
// Turning it off unchecks only the playlists that check added. A playlist the
// host already had checked stays checked.

import { playlistMatchesHoliday, selectableHolidayId } from "./holidays.js";

/**
 * @param {Array<{ id?: string, name?: string }>|null|undefined} playlists
 * @param {Iterable<string>|null|undefined} selectedIds
 * @param {{
 *   fromHolidayId?: string|null,
 *   toHolidayId?: string|null,
 *   autoCheckedIds?: Iterable<string>|null,
 * }} [change]
 * @returns {{ selectedIds: string[], autoCheckedIds: string[] }}
 */
export function applyHolidayPlaylistChecks(playlists, selectedIds, change = {}) {
  const fromId = selectableHolidayId(change.fromHolidayId);
  const toId = selectableHolidayId(change.toHolidayId);
  const selected = [];
  const seen = new Set();
  for (const id of selectedIds || []) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    selected.push(id);
  }
  const previousAuto = [];
  const previousAutoSet = new Set();
  for (const id of change.autoCheckedIds || []) {
    if (typeof id !== "string" || !id || previousAutoSet.has(id)) continue;
    previousAutoSet.add(id);
    previousAuto.push(id);
  }

  if (fromId && fromId !== toId) {
    for (const id of previousAuto) {
      const idx = selected.indexOf(id);
      if (idx >= 0) selected.splice(idx, 1);
      seen.delete(id);
    }
  }

  const autoCheckedIds = [];
  if (toId && toId !== fromId) {
    for (const pl of playlists || []) {
      const id = pl?.id;
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      if (!playlistMatchesHoliday(pl, toId)) continue;
      selected.push(id);
      seen.add(id);
      autoCheckedIds.push(id);
    }
  } else if (toId && toId === fromId) {
    for (const id of previousAuto) {
      if (seen.has(id)) autoCheckedIds.push(id);
    }
  }

  return { selectedIds: selected, autoCheckedIds };
}

/** Sonos group picker + Edit groups (join/leave). */

import { speakersFromGroups } from "./speakers.js";
import { escapeHtml } from "./format.js";

export const GROUPS_MS = 5000;

/**
 * @param {object|null|undefined} data
 */
export function normalizeGroupsPayload(data) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const speakers = data?.speakers?.length
    ? data.speakers
    : speakersFromGroups(groups);
  const targetLabel =
    data?.targetLabel ||
    groups.find((g) => g.isTarget)?.label ||
    groups[0]?.label ||
    null;
  return { groups, speakers, targetLabel };
}

/**
 * @param {number|null|undefined} ungrouped
 */
export function ungroupAllToastMessage(ungrouped) {
  const n = Number(ungrouped) || 0;
  return n
    ? `Ungrouped ${n} speaker${n === 1 ? "" : "s"}`
    : "All speakers were already alone";
}

/**
 * @param {{
 *   groupChips?: HTMLElement|null,
 *   groupEmpty?: HTMLElement|null,
 *   groupIntro?: HTMLElement|null,
 *   groupPicker?: HTMLElement|null,
 *   groupEdit?: HTMLElement|null,
 *   groupEditAnchor?: HTMLElement|null,
 *   groupMembers?: HTMLElement|null,
 *   groupAvailable?: HTMLElement|null,
 *   groupEditEmpty?: HTMLElement|null,
 *   groupEditToggle?: HTMLElement|null,
 *   groupUngroupAllBtn?: HTMLElement|null,
 * }} els
 * @param {{
 *   fetch?: typeof fetch,
 *   hostFetch: typeof fetch,
 *   showToast: (msg: string, isError?: boolean) => void,
 *   refreshSonos: () => void,
 *   now?: () => number,
 * }} deps
 */
export function createSonosGroups(els, deps) {
  const {
    groupChips,
    groupEmpty,
    groupIntro,
    groupPicker,
    groupEdit,
    groupEditAnchor,
    groupMembers,
    groupAvailable,
    groupEditEmpty,
    groupEditToggle,
    groupUngroupAllBtn,
  } = els || {};
  const fetchFn = deps?.fetch || fetch;
  const hostFetch = deps.hostFetch;
  const showToast = deps.showToast;
  const refreshSonos = deps.refreshSonos;
  const now = deps.now || Date.now;

  let groupsCache = [];
  let speakersCache = [];
  let groupsTargetLabel = null;
  let groupsLoading = false;
  let lastGroupsAt = 0;
  let groupEditMode = false;

  function invalidate() {
    lastGroupsAt = 0;
  }

  function renderGroupEdit() {
    if (!groupMembers || !groupAvailable) return;
    groupMembers.innerHTML = "";
    groupAvailable.innerHTML = "";

    const members = speakersCache.filter((s) => s.inTargetGroup);
    const available = speakersCache.filter((s) => !s.inTargetGroup);

    if (groupEditAnchor) {
      groupEditAnchor.textContent = groupsTargetLabel
        ? `Target group: ${groupsTargetLabel}`
        : "Target group: (none selected)";
    }

    for (const s of members) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className =
        "genre-chip group-chip on" +
        (s.isTargetCoordinator ? " group-chip-coord" : "");
      chip.title = s.isTargetCoordinator
        ? `${s.name} (coordinator) — tap to leave group`
        : `Remove ${s.name} from this group`;
      chip.innerHTML = `<span class="genre-name">${escapeHtml(s.name)}</span>${
        s.isTargetCoordinator ? '<span class="genre-cnt">lead</span>' : ""
      }`;
      chip.addEventListener("click", () => leaveSpeaker(s.name));
      groupMembers.appendChild(chip);
    }

    for (const s of available) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "genre-chip group-chip";
      chip.title = `Join ${s.name} to the target group`;
      chip.innerHTML = `<span class="genre-name">${escapeHtml(
        s.name
      )}</span><span class="genre-cnt">+</span>`;
      chip.addEventListener("click", () => joinSpeaker(s.name));
      groupAvailable.appendChild(chip);
    }

    if (groupEditEmpty) {
      const empty = speakersCache.length === 0;
      groupEditEmpty.hidden = !empty;
      if (empty) {
        groupEditEmpty.textContent =
          groupsCache.length === 0
            ? "No Sonos speakers found. Check that speakers are online, then tap Done and try again."
            : "Couldn't load speakers. Tap Done, hard-refresh the page, then try Edit groups again.";
      }
    }
  }

  function renderGroups() {
    if (groupEditMode) {
      renderGroupEdit();
      return;
    }
    if (!groupChips) return;
    groupChips.innerHTML = "";
    if (groupEmpty) groupEmpty.hidden = groupsCache.length > 0;

    for (const g of groupsCache) {
      const on = g.isTarget;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "genre-chip group-chip" + (on ? " on" : "");
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", on ? "true" : "false");
      chip.title = g.members?.length > 1 ? g.members.join(", ") : g.label;
      const count =
        g.memberCount > 1
          ? `<span class="genre-cnt">${g.memberCount}</span>`
          : "";
      const playing = g.isPlaying
        ? '<span class="group-playing" aria-hidden="true">&#9654;</span>'
        : "";
      chip.innerHTML = `${playing}<span class="genre-name">${escapeHtml(
        g.label
      )}</span>${count}`;
      if (!on) chip.addEventListener("click", () => pickGroup(g.coordinator));
      groupChips.appendChild(chip);
    }
  }

  function setGroupEditMode(on) {
    groupEditMode = !!on;
    if (groupPicker) groupPicker.hidden = groupEditMode;
    if (groupEdit) groupEdit.hidden = !groupEditMode;
    if (groupUngroupAllBtn) groupUngroupAllBtn.hidden = !groupEditMode;
    if (groupEditToggle) {
      groupEditToggle.setAttribute("aria-pressed", String(groupEditMode));
      groupEditToggle.textContent = groupEditMode ? "Done" : "Edit groups";
    }
    if (groupIntro) {
      groupIntro.textContent = groupEditMode
        ? "Edit mode: tap a speaker under Available to join, or tap one under In this group to leave."
        : "Songs go to this group's queue. Pick a group below, or Edit groups to join / leave speakers.";
    }
    renderGroups();
  }

  async function loadGroups(force = false) {
    if (groupsLoading) return;
    if (!force && now() - lastGroupsAt < GROUPS_MS) return;
    groupsLoading = true;
    try {
      const res = await fetchFn("/api/groups");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load groups.");
      const normalized = normalizeGroupsPayload(data);
      groupsCache = normalized.groups;
      speakersCache = normalized.speakers;
      groupsTargetLabel = normalized.targetLabel;
      lastGroupsAt = now();
      renderGroups();
    } catch (err) {
      if (force || !groupsCache.length) {
        showToast(err.message || "Could not load Sonos groups.", true);
      }
    } finally {
      groupsLoading = false;
    }
  }

  async function pickGroup(room) {
    try {
      const res = await hostFetch("/api/groups/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not select group.");
      invalidate();
      await loadGroups(true);
      refreshSonos();
      showToast(`Targeting ${data.label}`);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function joinSpeaker(room) {
    try {
      const res = await hostFetch("/api/groups/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not join speaker.");
      invalidate();
      await loadGroups(true);
      refreshSonos();
      if (data.alreadyInGroup) showToast(`${room} is already in the group`);
      else showToast(`Joined ${room}`);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function leaveSpeaker(room) {
    try {
      const res = await hostFetch("/api/groups/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not ungroup speaker.");
      invalidate();
      await loadGroups(true);
      refreshSonos();
      if (data.alreadyStandalone) showToast(`${room} is already alone`);
      else showToast(`Ungrouped ${room}`);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  groupEditToggle?.addEventListener("click", () => {
    setGroupEditMode(!groupEditMode);
    if (groupEditMode) loadGroups(true);
  });

  groupUngroupAllBtn?.addEventListener("click", async () => {
    groupUngroupAllBtn.disabled = true;
    try {
      const res = await hostFetch("/api/groups/ungroup-all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not ungroup speakers.");
      invalidate();
      await loadGroups(true);
      refreshSonos();
      showToast(ungroupAllToastMessage(data.ungrouped));
    } catch (err) {
      showToast(err.message, true);
    } finally {
      groupUngroupAllBtn.disabled = false;
    }
  });

  return {
    loadGroups,
    setGroupEditMode,
    invalidate,
  };
}

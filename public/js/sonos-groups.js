/** Sonos group picker + Edit groups (join/leave) + player-type icons. */

import { speakersFromGroups } from "./speakers.js";
import { escapeHtml } from "./format.js";
import {
  SONOS_PLAYER_TYPES,
  sonosIconUrl,
  iconForGroupChip,
  iconForSpeakerChip,
} from "./sonos-player-types.js";

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
 * @param {string} typeId
 * @param {string} [alt]
 */
export function sonosIconImgHtml(typeId, alt = "") {
  return `<img class="group-chip-icon-img" src="${escapeHtml(
    sonosIconUrl(typeId)
  )}" alt="${escapeHtml(alt)}" width="52" height="52" draggable="false" />`;
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
 *   typePicker?: HTMLElement|null,
 *   typePickerRoom?: HTMLElement|null,
 *   typePickerOptions?: HTMLElement|null,
 *   typePickerCancel?: HTMLElement|null,
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
    typePicker,
    typePickerRoom,
    typePickerOptions,
    typePickerCancel,
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
  let pendingForceLoad = false;
  let lastGroupsAt = 0;
  let groupEditMode = false;
  let topologyReloadTimer = null;

  function invalidate() {
    lastGroupsAt = 0;
  }

  function closeTypePicker() {
    if (!typePicker) return;
    typePicker.hidden = true;
    typePicker.setAttribute("hidden", "");
  }

  function openTypePicker(room, currentType) {
    if (!typePicker || !typePickerOptions) {
      showToast("Player type picker is unavailable — hard-refresh the page.", true);
      return;
    }
    const roomName = String(room || "").trim();
    if (!roomName) return;
    // Escape any transformed/overflow ancestors so the modal always covers the viewport.
    if (typePicker.parentElement !== document.body) {
      document.body.appendChild(typePicker);
    }
    if (typePickerRoom) typePickerRoom.textContent = roomName;
    typePickerOptions.innerHTML = "";
    const selected =
      currentType && currentType !== "default" ? currentType : null;
    for (const t of SONOS_PLAYER_TYPES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sonos-type-option" + (t.id === selected ? " on" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", t.id === selected ? "true" : "false");
      btn.innerHTML = `${sonosIconImgHtml(t.id, t.label)}<span>${escapeHtml(
        t.label
      )}</span>`;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        savePlayerType(roomName, t.id);
      });
      typePickerOptions.appendChild(btn);
    }
    typePicker.hidden = false;
    typePicker.removeAttribute("hidden");
  }

  function bindIconPicker(iconBtn, room, typeId) {
    iconBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTypePicker(room, typeId);
    });
  }

  async function savePlayerType(room, type) {
    try {
      const res = await hostFetch("/api/groups/player-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save player type.");
      const savedType = data.type || type;
      const key = String(room).toLowerCase();
      let touched = false;
      speakersCache = speakersCache.map((s) => {
        if (String(s.name || "").toLowerCase() !== key) return s;
        touched = true;
        return { ...s, playerType: savedType };
      });
      // Room might only appear in groups (not speakers) on a sparse payload.
      if (!touched) {
        speakersCache = [
          ...speakersCache,
          { name: room, playerType: savedType, inTargetGroup: false },
        ];
      }
      groupsCache = groupsCache.map((g) => {
        const next = { ...g };
        delete next.icon;
        next.icon = iconForGroupChip(next, speakersCache);
        return next;
      });
      closeTypePicker();
      invalidate();
      renderGroups();
      showToast(
        `${room}: ${
          SONOS_PLAYER_TYPES.find((t) => t.id === savedType)?.label || savedType
        }`
      );
      // Refresh from server so the next poll doesn’t stomp with a stale icon.
      await loadGroups(true);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function appendSpeakerEditChip(parent, s, { inGroup }) {
    const typeId = iconForSpeakerChip(s);
    const wrap = document.createElement("div");
    wrap.className =
      "genre-chip group-chip group-chip-tile" +
      (inGroup ? " on" : "") +
      (s.isTargetCoordinator ? " group-chip-coord" : "");

    const iconBtn = document.createElement("button");
    iconBtn.type = "button";
    iconBtn.className = "group-chip-icon-btn";
    iconBtn.title = `Set player type for ${s.name}`;
    iconBtn.setAttribute("aria-label", `Set player type for ${s.name}`);
    iconBtn.innerHTML = sonosIconImgHtml(typeId, "");
    bindIconPicker(iconBtn, s.name, typeId);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "group-chip-action";
    if (inGroup) {
      action.title = s.isTargetCoordinator
        ? `${s.name} (coordinator) — tap to leave group`
        : `Remove ${s.name} from this group`;
      action.innerHTML = `<span class="group-chip-body"><span class="genre-name">${escapeHtml(
        s.name
      )}</span>${
        s.isTargetCoordinator ? '<span class="genre-cnt">lead</span>' : ""
      }</span>`;
      action.addEventListener("click", () => leaveSpeaker(s.name));
    } else {
      action.title = `Join ${s.name} to the target group`;
      action.innerHTML = `<span class="group-chip-body"><span class="genre-name">${escapeHtml(
        s.name
      )}</span><span class="genre-cnt">+</span></span>`;
      action.addEventListener("click", () => joinSpeaker(s.name));
    }

    wrap.appendChild(iconBtn);
    wrap.appendChild(action);
    parent.appendChild(wrap);
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
      appendSpeakerEditChip(groupMembers, s, { inGroup: true });
    }
    for (const s of available) {
      appendSpeakerEditChip(groupAvailable, s, { inGroup: false });
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
      const members = Array.isArray(g.members)
        ? g.members.filter(Boolean)
        : [];
      const multi = (Number(g.memberCount) || members.length) > 1;
      const typeId = iconForGroupChip(g, speakersCache);
      const soloRoom = !multi ? members[0] || g.coordinator || g.label : null;

      // Div tile (not one big button) so the icon can open the type picker.
      const chip = document.createElement("div");
      chip.className =
        "genre-chip group-chip group-chip-tile" + (on ? " on" : "");
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", on ? "true" : "false");
      chip.title = multi ? members.join(", ") : g.label;

      const iconBtn = document.createElement("button");
      iconBtn.type = "button";
      iconBtn.className = "group-chip-icon-btn";
      if (soloRoom) {
        iconBtn.title = `Set player type for ${soloRoom}`;
        iconBtn.setAttribute(
          "aria-label",
          `Set player type for ${soloRoom}`
        );
        iconBtn.innerHTML = sonosIconImgHtml(typeId, "");
        bindIconPicker(iconBtn, soloRoom, typeId);
      } else {
        iconBtn.title = members.join(", ");
        iconBtn.tabIndex = -1;
        iconBtn.setAttribute("aria-hidden", "true");
        iconBtn.innerHTML = sonosIconImgHtml(typeId, "");
        iconBtn.disabled = true;
      }

      const action = document.createElement("button");
      action.type = "button";
      action.className = "group-chip-action";
      action.setAttribute("aria-checked", on ? "true" : "false");
      const playing = g.isPlaying
        ? '<span class="group-playing" aria-hidden="true">&#9654;</span>'
        : "";
      const namesHtml = multi
        ? `<ul class="group-chip-members">${members
            .map((n) => `<li>${escapeHtml(n)}</li>`)
            .join("")}</ul>`
        : `<span class="genre-name">${escapeHtml(
            members[0] || g.label || ""
          )}</span>`;
      const count =
        multi && members.length
          ? `<span class="genre-cnt">${members.length}</span>`
          : "";
      action.innerHTML = `<span class="group-chip-body">${namesHtml}</span><span class="group-chip-meta">${playing}${count}</span>`;
      if (!on) {
        action.title = `Target ${g.label}`;
        action.addEventListener("click", () => pickGroup(g.coordinator));
      } else {
        action.title = `Targeting ${g.label}`;
        action.disabled = true;
      }

      chip.appendChild(iconBtn);
      chip.appendChild(action);
      groupChips.appendChild(chip);
    }
  }

  function setGroupEditMode(on) {
    groupEditMode = !!on;
    if (!groupEditMode) closeTypePicker();
    if (groupPicker) groupPicker.hidden = groupEditMode;
    if (groupEdit) groupEdit.hidden = !groupEditMode;
    if (groupUngroupAllBtn) groupUngroupAllBtn.hidden = !groupEditMode;
    if (groupEditToggle) {
      groupEditToggle.setAttribute("aria-pressed", String(groupEditMode));
      groupEditToggle.textContent = groupEditMode ? "Done" : "Edit groups";
    }
    if (groupIntro) {
      groupIntro.textContent = groupEditMode
        ? "Edit mode: tap a speaker name to join or leave. Tap the icon above the name to choose Arc, Play 1, Amp, Roam, Move, or Connect."
        : "Songs go to this group's queue. Pick a group below. Use Edit groups to join/leave speakers or tap a speaker icon to set its player type.";
    }
    renderGroups();
  }

  async function loadGroups(force = false) {
    if (groupsLoading) {
      if (force) pendingForceLoad = true;
      return;
    }
    if (!force && now() - lastGroupsAt < GROUPS_MS) return;
    groupsLoading = true;
    try {
      do {
        pendingForceLoad = false;
        const res = await fetchFn("/api/groups", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load groups.");
        const normalized = normalizeGroupsPayload(data);
        groupsCache = normalized.groups;
        speakersCache = normalized.speakers;
        groupsTargetLabel = normalized.targetLabel;
        lastGroupsAt = now();
        renderGroups();
      } while (pendingForceLoad);
    } catch (err) {
      if (force || !groupsCache.length) {
        showToast(err.message || "Could not load Sonos groups.", true);
      }
    } finally {
      groupsLoading = false;
      if (pendingForceLoad) {
        pendingForceLoad = false;
        loadGroups(true);
      }
    }
  }

  /** Immediate refresh + one follow-up — Sonos topology often lags SETTLE_MS. */
  async function reloadAfterTopologyChange() {
    invalidate();
    await loadGroups(true);
    refreshSonos();
    if (topologyReloadTimer) clearTimeout(topologyReloadTimer);
    topologyReloadTimer = setTimeout(() => {
      topologyReloadTimer = null;
      invalidate();
      loadGroups(true);
      refreshSonos();
    }, 900);
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
      await reloadAfterTopologyChange();
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
      await reloadAfterTopologyChange();
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
      await reloadAfterTopologyChange();
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
      await reloadAfterTopologyChange();
      showToast(ungroupAllToastMessage(data.ungrouped));
    } catch (err) {
      showToast(err.message, true);
    } finally {
      groupUngroupAllBtn.disabled = false;
    }
  });

  typePickerCancel?.addEventListener("click", () => closeTypePicker());
  typePicker?.addEventListener("click", (e) => {
    if (e.target === typePicker) closeTypePicker();
  });

  return {
    loadGroups,
    setGroupEditMode,
    invalidate,
    reloadAfterTopologyChange,
  };
}

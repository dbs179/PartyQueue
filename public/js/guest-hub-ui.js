/** DJ Booth → Users hub grid + per-guest editor (notes / birthday / rename). */

import { guestHubStat, guestHubDesc } from "./guest.js";

/**
 * @param {{ birthday?: string|null, birthdayRole?: string }|null|undefined} g
 */
export function guestBirthdayFormValues(g) {
  const bday = String(g?.birthday || "");
  const [mm, dd] = bday.split("-");
  return {
    month: mm ? String(Number(mm)) : "",
    day: dd ? String(Number(dd)) : "",
    role: g?.birthdayRole || "star",
  };
}

/**
 * @param {{ notes?: string|string[] }|null|undefined} g
 * @returns {string[]}
 */
export function guestNotesList(g) {
  return Array.isArray(g?.notes) ? g.notes : g?.notes ? [g.notes] : [];
}

/**
 * @param {{
 *   hubGrid?: HTMLElement|null,
 *   listEl?: HTMLElement|null,
 *   nameInput?: HTMLInputElement|null,
 *   notesInput?: HTMLTextAreaElement|HTMLInputElement|null,
 *   saveBtn?: HTMLElement|null,
 *   bdayMonth?: HTMLSelectElement|HTMLInputElement|null,
 *   bdayDay?: HTMLSelectElement|HTMLInputElement|null,
 *   bdayRole?: HTMLSelectElement|HTMLInputElement|null,
 *   bdaySaveBtn?: HTMLElement|null,
 *   bdayForgetBtn?: HTMLElement|null,
 *   removeBtn?: HTMLElement|null,
 *   renameBtn?: HTMLElement|null,
 *   editTitle?: HTMLElement|null,
 * }} els
 * @param {{
 *   hostFetch: typeof fetch,
 *   fetch?: typeof fetch,
 *   showToast: (msg: string, isError?: boolean) => void,
 *   confirmModal: (message: string, confirmLabel?: string, cancelLabel?: string) => Promise<boolean>,
 *   navigate: (name: string, opts?: { replace?: boolean }) => void,
 * }} deps
 */
export function createGuestHubUi(els, deps) {
  const {
    hubGrid,
    listEl,
    nameInput,
    notesInput,
    saveBtn,
    bdayMonth,
    bdayDay,
    bdayRole,
    bdaySaveBtn,
    bdayForgetBtn,
    removeBtn,
    renameBtn,
    editTitle,
  } = els || {};
  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const confirmModal = deps.confirmModal;
  const navigate = deps.navigate;

  /** @type {Array<{name?: string, notes?: string[], birthday?: string|null, birthdayRole?: string}>} */
  let cachedGuests = [];
  /** Name of guest currently open in the edit view, or null for Add user. */
  let editingGuestName = null;

  function fillGuestBirthdayForm(g) {
    if (nameInput) nameInput.value = g?.name || "";
    if (notesInput) notesInput.value = "";
    const vals = guestBirthdayFormValues(g);
    if (bdayMonth) bdayMonth.value = vals.month;
    if (bdayDay) bdayDay.value = vals.day;
    if (bdayRole) bdayRole.value = vals.role;
  }

  function setGuests(guests) {
    cachedGuests = Array.isArray(guests) ? guests : [];
    renderGuestHub(cachedGuests);
    refreshGuestEditNotes();
  }

  function openGuestEditor(guest) {
    editingGuestName = guest?.name || null;
    fillGuestBirthdayForm(guest || {});
    if (editTitle) {
      editTitle.textContent = editingGuestName || "Add user";
    }
    if (removeBtn) removeBtn.hidden = !editingGuestName;
    if (renameBtn) renameBtn.hidden = !editingGuestName;
    refreshGuestEditNotes();
    navigate("settings-user-edit");
    setTimeout(() => {
      if (editingGuestName) notesInput?.focus();
      else nameInput?.focus();
    }, 50);
  }

  function renderGuestHub(guests) {
    if (!hubGrid) return;
    hubGrid.innerHTML = "";
    const list = Array.isArray(guests) ? guests : [];

    for (const g of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-hub-card";
      btn.innerHTML = `
      <span class="settings-hub-title"></span>
      <span class="settings-hub-stat"></span>
      <span class="settings-hub-desc"></span>
    `;
      btn.querySelector(".settings-hub-title").textContent = g.name || "Guest";
      btn.querySelector(".settings-hub-stat").textContent = guestHubStat(g);
      btn.querySelector(".settings-hub-desc").textContent = guestHubDesc(g);
      btn.addEventListener("click", () => openGuestEditor(g));
      hubGrid.appendChild(btn);
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "settings-hub-card settings-hub-card-full";
    addBtn.id = "guest-add-card";
    addBtn.innerHTML = `
    <span class="settings-hub-title">Add user</span>
    <span class="settings-hub-desc">New requestor notes and birthday</span>
  `;
    addBtn.addEventListener("click", () => openGuestEditor(null));
    hubGrid.appendChild(addBtn);
  }

  function refreshGuestEditNotes() {
    if (!listEl) return;
    listEl.innerHTML = "";
    const name = (nameInput?.value || editingGuestName || "").trim();
    const g =
      cachedGuests.find(
        (x) => (x.name || "").toLowerCase() === name.toLowerCase()
      ) || null;
    const notes = guestNotesList(g);

    if (!name) {
      const empty = document.createElement("p");
      empty.className = "guest-list-empty";
      empty.textContent = "Enter a name, then add notes.";
      listEl.appendChild(empty);
      return;
    }
    if (!notes.length) {
      const empty = document.createElement("p");
      empty.className = "guest-list-empty";
      empty.textContent = "No notes yet — add one below.";
      listEl.appendChild(empty);
      return;
    }

    const notesUl = document.createElement("ul");
    notesUl.className = "guest-note-list";
    notes.forEach((note, idx) => {
      const li = document.createElement("li");
      li.className = "guest-note-item";
      const text = document.createElement("span");
      text.textContent = note;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "pill-btn guest-note-remove";
      rm.textContent = "×";
      rm.title = "Remove note";
      rm.setAttribute("aria-label", "Remove note");
      rm.addEventListener("click", async () => {
        try {
          const res = await fetchFn(
            `/api/guests/${encodeURIComponent(g.name || "")}/notes/${idx}`,
            { method: "DELETE" }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Could not remove note.");
          setGuests(data.guests);
        } catch (err) {
          showToast(err.message, true);
        }
      });
      li.appendChild(text);
      li.appendChild(rm);
      notesUl.appendChild(li);
    });
    listEl.appendChild(notesUl);
  }

  async function loadGuests() {
    try {
      const res = await hostFetch("/api/guests");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load users.");
      setGuests(data.guests);
    } catch {
      /* leave list as-is on transient errors */
    }
  }

  saveBtn?.addEventListener("click", async () => {
    const name = nameInput?.value?.trim() || "";
    const note = notesInput?.value?.trim() || "";
    if (!name) {
      showToast("Enter a name.", true);
      return;
    }
    if (!note) {
      showToast("Enter a short note.", true);
      return;
    }
    saveBtn.disabled = true;
    try {
      const res = await hostFetch("/api/guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save note.");
      editingGuestName = name;
      if (editTitle) editTitle.textContent = name;
      if (removeBtn) removeBtn.hidden = false;
      setGuests(data.guests);
      if (notesInput) notesInput.value = "";
      showToast("Note added");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  bdaySaveBtn?.addEventListener("click", async () => {
    const name = nameInput?.value?.trim() || "";
    if (!name) {
      showToast("Enter a name.", true);
      return;
    }
    const month = bdayMonth?.value || "";
    const day = bdayDay?.value || "";
    const birthday = month && day ? `${month}/${day}` : null;
    const birthdayRole = bdayRole?.value || "star";
    bdaySaveBtn.disabled = true;
    try {
      const res = await hostFetch("/api/guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, birthday, birthdayRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save birthday.");
      editingGuestName = name;
      if (editTitle) editTitle.textContent = name;
      if (removeBtn) removeBtn.hidden = false;
      setGuests(data.guests);
      showToast(birthday ? "Birthday saved" : "Birthday cleared");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      bdaySaveBtn.disabled = false;
    }
  });

  renameBtn?.addEventListener("click", async () => {
    const from = editingGuestName || "";
    const to = nameInput?.value?.trim() || "";
    if (!from) {
      showToast("Open a user first.", true);
      return;
    }
    if (!to) {
      showToast("Enter the new name.", true);
      return;
    }
    if (from === to) {
      showToast("Change the name field, then tap Rename.");
      return;
    }
    const ok = await confirmModal(
      `Rename ${from} to ${to}? Notes that mention the old name will be updated.`,
      "Rename"
    );
    if (!ok) return;
    renameBtn.disabled = true;
    try {
      const res = await hostFetch("/api/guests/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not rename user.");
      editingGuestName = data.guest?.name || to;
      if (nameInput) nameInput.value = editingGuestName;
      if (editTitle) editTitle.textContent = editingGuestName;
      setGuests(data.guests);
      showToast(`Renamed to ${editingGuestName}`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      renameBtn.disabled = false;
    }
  });

  removeBtn?.addEventListener("click", async () => {
    const name = nameInput?.value?.trim() || editingGuestName || "";
    if (!name) {
      showToast("Enter or select a name.", true);
      return;
    }
    const ok = await confirmModal(
      `Remove ${name}? Their notes and birthday will be deleted.`,
      "Remove user"
    );
    if (!ok) return;
    removeBtn.disabled = true;
    try {
      const res = await hostFetch(`/api/guests/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not remove user.");
      editingGuestName = null;
      setGuests(data.guests);
      showToast("Removed");
      navigate("settings-users", { replace: true });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      removeBtn.disabled = false;
    }
  });

  bdayForgetBtn?.addEventListener("click", async () => {
    const name = nameInput?.value?.trim() || "";
    if (!name) {
      showToast("Enter or select a name.", true);
      return;
    }
    const ok = await confirmModal(
      `Reset tonight's birthday shout for ${name}? Their next request can get a first-request birthday wish again.`,
      "Reset birthday shout"
    );
    if (!ok) return;
    bdayForgetBtn.disabled = true;
    try {
      const res = await hostFetch(
        `/api/guests/${encodeURIComponent(name)}/forget-birthday-shout`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Could not reset birthday shout.");
      }
      showToast(`Birthday shout reset for ${name}`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      bdayForgetBtn.disabled = false;
    }
  });

  return {
    loadGuests,
    openGuestEditor,
  };
}

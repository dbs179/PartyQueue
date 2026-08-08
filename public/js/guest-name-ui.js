/** Guest User + alias modal (name gate) and session badge helpers. */

import { attachModal } from "./modal.js";
import {
  sanitizeDisplayName,
  getDisplayName,
  getDisplayAlias,
  setDisplayName,
  setDisplayAlias,
  guestBadgeName as guestBadgeNameFrom,
  guestIdentityPayload as guestIdentityPayloadFrom,
} from "./guest.js";

/**
 * @param {{
 *   nameOverlay?: HTMLElement|null,
 *   nameTitle?: HTMLElement|null,
 *   nameInput?: HTMLInputElement|null,
 *   aliasInput?: HTMLInputElement|null,
 *   nameUserHint?: HTMLElement|null,
 *   nameError?: HTMLElement|null,
 *   nameSaveBtn?: HTMLElement|null,
 *   nameCancelBtn?: HTMLElement|null,
 *   guestNameBtn?: HTMLElement|null,
 * }} els
 */
export function createGuestNameUi(els) {
  const {
    nameOverlay,
    nameTitle,
    nameInput,
    aliasInput,
    nameUserHint,
    nameError,
    nameSaveBtn,
    nameCancelBtn,
    guestNameBtn,
  } = els || {};

  /** @type {string} */
  let sessionDisplayName = getDisplayName();
  /** @type {string} */
  let sessionDisplayAlias = getDisplayAlias();
  /** @type {Promise<string>|null} */
  let nameGatePromise = null;

  function guestBadgeName() {
    return guestBadgeNameFrom(sessionDisplayName, sessionDisplayAlias);
  }

  function guestIdentityPayload() {
    return guestIdentityPayloadFrom(sessionDisplayName, sessionDisplayAlias);
  }

  function syncGuestNameLabel() {
    if (!guestNameBtn) return;
    const label = guestBadgeName();
    if (sessionDisplayName) {
      guestNameBtn.textContent = `Adding as ${label}`;
      guestNameBtn.setAttribute(
        "aria-label",
        `Adding as ${label} — tap to change your name or alias`
      );
    } else {
      guestNameBtn.textContent = "Set your name";
      guestNameBtn.setAttribute(
        "aria-label",
        "Set your name to request songs"
      );
    }
  }

  /**
   * Show the User + alias modal when User is missing, or when `edit` is true.
   * Resolves with the stable User name (required for adds).
   * @param {{ edit?: boolean, required?: boolean }} [opts]
   */
  function ensureDisplayName({ edit = false, required = false } = {}) {
    if (!edit && !required && sessionDisplayName) {
      return Promise.resolve(sessionDisplayName);
    }
    if (!edit && required && sessionDisplayName) {
      return Promise.resolve(sessionDisplayName);
    }
    if (nameGatePromise) return nameGatePromise;
    if (!nameOverlay || !nameInput || !nameSaveBtn) {
      return Promise.resolve(sessionDisplayName || "");
    }

    nameGatePromise = new Promise((resolve) => {
      const editing = !!edit && !!sessionDisplayName;
      const mustName = !!required && !sessionDisplayName;
      if (nameError) nameError.hidden = true;
      nameInput.value = editing || sessionDisplayName ? sessionDisplayName : "";
      if (aliasInput) {
        aliasInput.value =
          editing || sessionDisplayAlias ? sessionDisplayAlias : "";
      }
      if (nameUserHint) nameUserHint.hidden = !editing;
      if (nameTitle) {
        nameTitle.textContent = editing
          ? "Change your name?"
          : "Who’s requesting?";
      }
      if (nameCancelBtn) nameCancelBtn.hidden = mustName;

      let session = null;
      const finish = (value) => {
        session?.close();
        session = null;
        cleanup();
        resolve(value);
      };
      const cleanup = () => {
        nameSaveBtn.removeEventListener("click", onSave);
        nameInput.removeEventListener("keydown", onKey);
        if (aliasInput) aliasInput.removeEventListener("keydown", onKey);
        if (nameCancelBtn) nameCancelBtn.removeEventListener("click", onCancel);
      };
      const onSave = () => {
        const cleaned = sanitizeDisplayName(nameInput.value);
        if (!cleaned) {
          if (nameError) {
            nameError.textContent = "Please enter your real name.";
            nameError.hidden = false;
          }
          nameInput.focus();
          return;
        }
        const alias = sanitizeDisplayName(aliasInput?.value || "");
        setDisplayName(cleaned);
        setDisplayAlias(alias);
        sessionDisplayName = cleaned;
        sessionDisplayAlias = alias;
        syncGuestNameLabel();
        finish(cleaned);
      };
      const onCancel = () => {
        if (mustName) return;
        finish(sessionDisplayName || "");
      };
      const onKey = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSave();
        }
      };
      nameSaveBtn.addEventListener("click", onSave);
      nameInput.addEventListener("keydown", onKey);
      if (aliasInput) aliasInput.addEventListener("keydown", onKey);
      if (nameCancelBtn) nameCancelBtn.addEventListener("click", onCancel);
      session = attachModal(nameOverlay, {
        initialFocus: nameInput,
        onEscape: mustName ? null : onCancel,
        allowBackdrop: !mustName,
        onBackdrop: onCancel,
      });
    }).finally(() => {
      nameGatePromise = null;
    });

    return nameGatePromise;
  }

  syncGuestNameLabel();
  guestNameBtn?.addEventListener("click", () =>
    ensureDisplayName({ edit: true }).then(syncGuestNameLabel)
  );

  return {
    ensureDisplayName,
    guestBadgeName,
    guestIdentityPayload,
    syncGuestNameLabel,
  };
}

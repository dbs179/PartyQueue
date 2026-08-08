/** Promise-based confirm dialog over the shared modal overlay. */

import { attachModal } from "./modal.js";

/**
 * @param {{
 *   overlay: HTMLElement|null,
 *   messageEl: HTMLElement|null,
 *   confirmBtn: HTMLElement|null,
 *   cancelBtn: HTMLElement|null,
 * }} els
 * @returns {(message: string, confirmLabel?: string, cancelLabel?: string) => Promise<boolean>}
 */
export function createConfirmModal(els) {
  const { overlay, messageEl, confirmBtn, cancelBtn } = els || {};
  return function confirmModal(
    message,
    confirmLabel = "Yes",
    cancelLabel = "Cancel"
  ) {
    return new Promise((resolve) => {
      if (!overlay || !messageEl || !confirmBtn || !cancelBtn) {
        resolve(false);
        return;
      }
      messageEl.textContent = message;
      confirmBtn.textContent = confirmLabel;
      cancelBtn.textContent = cancelLabel;

      let session = null;
      const cleanup = (result) => {
        confirmBtn.removeEventListener("click", onConfirm);
        cancelBtn.removeEventListener("click", onCancel);
        session?.close();
        session = null;
        resolve(result);
      };
      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);

      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onCancel);
      session = attachModal(overlay, {
        initialFocus: confirmBtn,
        onEscape: onCancel,
        allowBackdrop: true,
        onBackdrop: onCancel,
      });
    });
  };
}

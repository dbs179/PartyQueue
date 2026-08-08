/** Bottom toast notifications (message + optional action button). */

let toastTimer = null;
let toastEl = null;

function getToastEl() {
  if (toastEl) return toastEl;
  if (typeof document === "undefined") return null;
  toastEl = document.getElementById("toast");
  return toastEl;
}

/** Test helper — clear cached element / timer. */
export function resetToastForTests() {
  clearTimeout(toastTimer);
  toastTimer = null;
  toastEl = null;
}

/**
 * @param {string} message
 * @param {boolean} [isError]
 * @param {number} [durationMs]
 * @param {{ actionLabel?: string, onAction?: () => void }} [opts]
 */
export function showToast(message, isError = false, durationMs = 2600, opts = {}) {
  const el = getToastEl();
  if (!el) return;

  clearTimeout(toastTimer);
  el.replaceChildren();
  el.classList.toggle("error", isError);
  const actionLabel = opts?.actionLabel;
  const onAction = opts?.onAction;
  if (actionLabel && typeof onAction === "function" && !isError) {
    el.classList.add("has-action");
    const msg = document.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = message;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearTimeout(toastTimer);
      el.classList.remove("show", "has-action");
      onAction();
    });
    el.append(msg, btn);
  } else {
    el.classList.remove("has-action");
    el.textContent = message;
  }
  el.classList.add("show");
  const ms = Math.max(1000, Number(durationMs) || 2600);
  toastTimer = setTimeout(() => {
    el.classList.remove("show", "has-action");
  }, ms);
}

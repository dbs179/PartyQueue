const MODAL_FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

let modalOpenCount = 0;

export function isModalOpen() {
  return modalOpenCount > 0;
}

export function modalFocusables(root) {
  if (!root) return [];
  return [...root.querySelectorAll(MODAL_FOCUSABLE)].filter((el) => {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    if (el.hidden || el.closest("[hidden]")) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

/**
 * Shared modal session: focus trap, Escape, optional backdrop, body scroll lock,
 * and restore focus on close. NP overlay keeps its own history/scroll handling.
 * @param {HTMLElement} overlay
 * @param {{
 *   initialFocus?: HTMLElement|null,
 *   onEscape?: (() => void)|null,
 *   allowBackdrop?: boolean,
 *   onBackdrop?: (() => void)|null,
 *   scrollLock?: boolean,
 * }} [opts]
 */
export function attachModal(overlay, opts = {}) {
  if (!overlay) return { close() {} };
  const returnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const scrollLock = opts.scrollLock !== false;
  const onEscape = opts.onEscape || null;
  const allowBackdrop = !!opts.allowBackdrop;
  const onBackdrop = opts.onBackdrop || onEscape;

  if (scrollLock) {
    modalOpenCount += 1;
    document.body.classList.add("modal-open");
  }
  overlay.hidden = false;

  const focusInitial = () => {
    const dialog = overlay.querySelector(".modal") || overlay;
    const target = opts.initialFocus || modalFocusables(dialog)[0];
    if (target?.focus) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
      if (typeof target.select === "function") {
        try {
          target.select();
        } catch {
          /* non-text inputs */
        }
      }
    }
  };
  setTimeout(focusInitial, 0);

  const onKeydown = (e) => {
    if (overlay.hidden) return;
    if (e.key === "Escape") {
      if (typeof onEscape === "function") {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = modalFocusables(overlay.querySelector(".modal") || overlay);
    if (!nodes.length) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const onClick = (e) => {
    if (!allowBackdrop || e.target !== overlay) return;
    if (typeof onBackdrop === "function") onBackdrop();
  };

  document.addEventListener("keydown", onKeydown, true);
  overlay.addEventListener("click", onClick);

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.removeEventListener("click", onClick);
      overlay.hidden = true;
      if (scrollLock) {
        modalOpenCount = Math.max(0, modalOpenCount - 1);
        if (modalOpenCount === 0) document.body.classList.remove("modal-open");
      }
      if (returnFocus && document.contains(returnFocus)) {
        try {
          returnFocus.focus({ preventScroll: true });
        } catch {
          /* element may no longer accept focus */
        }
      }
    },
  };
}

export function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

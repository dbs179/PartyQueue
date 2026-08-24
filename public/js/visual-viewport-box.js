/**
 * Pin a position:fixed overlay to the visible viewport (above the Android
 * keyboard) instead of the layout viewport.
 */

/**
 * @param {{ offsetTop?: number, offsetLeft?: number, width?: number, height?: number }|null|undefined} vv
 * @returns {{ top: number, left: number, width: number|string, height: number|string }}
 */
export function visualViewportBox(vv) {
  if (!vv || !Number.isFinite(Number(vv.width)) || !Number.isFinite(Number(vv.height))) {
    return { top: 0, left: 0, width: "100%", height: "100%" };
  }
  return {
    top: Number(vv.offsetTop) || 0,
    left: Number(vv.offsetLeft) || 0,
    width: Number(vv.width),
    height: Number(vv.height),
  };
}

/** @param {HTMLElement|null|undefined} el */
export function applyVisualViewportBox(el, vv = globalThis.visualViewport) {
  if (!el?.style) return;
  const box = visualViewportBox(vv);
  el.style.position = "fixed";
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.top = `${box.top}px`;
  el.style.left = `${box.left}px`;
  el.style.width = typeof box.width === "number" ? `${box.width}px` : box.width;
  el.style.height = typeof box.height === "number" ? `${box.height}px` : box.height;
}

/** @param {HTMLElement|null|undefined} el */
export function clearVisualViewportBox(el) {
  if (!el?.style) return;
  el.style.position = "";
  el.style.top = "";
  el.style.left = "";
  el.style.right = "";
  el.style.bottom = "";
  el.style.width = "";
  el.style.height = "";
}

/**
 * Dismiss the Android/iOS keyboard by blurring a focused field.
 * Hidden views do not unfocus; the keyboard then squeezes Karaoke/Party Display.
 * @param {{ activeElement?: { tagName?: string, isContentEditable?: boolean, blur?: () => void }|null, body?: unknown }|null|undefined} [doc]
 * @returns {boolean} true if a field was blurred
 */
export function blurSoftKeyboard(doc = globalThis.document) {
  if (!doc) return false;
  const el = doc.activeElement;
  if (!el || el === doc.body || typeof el.blur !== "function") return false;
  const tag = String(el.tagName || "").toLowerCase();
  const isField =
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    !!el.isContentEditable;
  if (!isField) return false;
  el.blur();
  return true;
}

/**
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe
 */
export function watchVisualViewport(onChange) {
  if (typeof onChange !== "function") return () => {};
  const run = () => onChange();
  const vv = globalThis.visualViewport;
  vv?.addEventListener("resize", run);
  vv?.addEventListener("scroll", run);
  globalThis.addEventListener?.("resize", run);
  run();
  return () => {
    vv?.removeEventListener("resize", run);
    vv?.removeEventListener("scroll", run);
    globalThis.removeEventListener?.("resize", run);
  };
}

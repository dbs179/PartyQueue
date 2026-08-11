/**
 * Wide-layout host transport rail: parks Sonos transport beside NP / Up Next
 * when the host session is open and the viewport is wide enough.
 *
 * Moves the existing #controls-host-protected node (no duplicate buttons).
 */

export const HOST_DESKTOP_RAIL_MQ = "(min-width: 960px)";
export const HOST_DESKTOP_RAIL_BODY_CLASS = "host-desktop-rail";

/**
 * @param {object} opts
 * @param {HTMLElement|null} opts.rail
 * @param {HTMLElement|null} opts.home
 * @param {HTMLElement|null} [opts.protectedEl]
 * @param {() => HTMLElement|null} [opts.getProtectedEl]
 * @param {string} [opts.matchMediaQuery]
 * @param {(query: string) => MediaQueryList} [opts.matchMedia]
 * @param {ParentNode} [opts.root] document/body owner for class toggle
 * @returns {{
 *   setHostOpen: (open: boolean) => void,
 *   sync: () => void,
 *   isActive: () => boolean,
 *   dispose: () => void,
 * }}
 */
export function createHostDesktopRail({
  rail,
  home,
  protectedEl = null,
  getProtectedEl = null,
  matchMediaQuery = HOST_DESKTOP_RAIL_MQ,
  matchMedia = typeof window !== "undefined" ? window.matchMedia.bind(window) : null,
  root = typeof document !== "undefined" ? document.body : null,
} = {}) {
  let hostOpen = false;
  let active = false;

  const mql =
    typeof matchMedia === "function" ? matchMedia(matchMediaQuery) : null;

  function resolveProtected() {
    if (typeof getProtectedEl === "function") return getProtectedEl();
    return protectedEl;
  }

  function sync() {
    const node = resolveProtected();
    const wide = !!(mql && mql.matches);
    const canShow = !!(hostOpen && wide && rail && home && node && !node.hidden);
    active = canShow;

    if (root?.classList) {
      root.classList.toggle(HOST_DESKTOP_RAIL_BODY_CLASS, canShow);
    }

    if (!rail || !home || !node) {
      if (rail) rail.hidden = true;
      return;
    }

    if (canShow) {
      if (node.parentElement !== rail) rail.appendChild(node);
      rail.hidden = false;
    } else {
      if (node.parentElement !== home) home.appendChild(node);
      rail.hidden = true;
    }
  }

  function setHostOpen(open) {
    hostOpen = !!open;
    sync();
  }

  function onMqChange() {
    sync();
  }

  if (mql) {
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onMqChange);
    } else if (typeof mql.addListener === "function") {
      mql.addListener(onMqChange);
    }
  }

  // Park transport in its home slot and clear body class until the host opens.
  sync();

  function dispose() {
    if (!mql) return;
    if (typeof mql.removeEventListener === "function") {
      mql.removeEventListener("change", onMqChange);
    } else if (typeof mql.removeListener === "function") {
      mql.removeListener(onMqChange);
    }
  }

  return {
    setHostOpen,
    sync,
    isActive: () => active,
    dispose,
  };
}

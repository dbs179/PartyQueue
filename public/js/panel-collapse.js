/**
 * Collapse/expand a section with a header toggle. Remembers state in localStorage.
 *
 * @param {string} sectionId
 * @param {string} toggleId
 * @param {string} storageKey
 * @param {{
 *   onExpand?: (() => void)|null,
 *   defaultCollapsed?: boolean,
 *   ignoreClickSelector?: string|null,
 * }} [opts]
 */
export function wirePanelCollapse(
  sectionId,
  toggleId,
  storageKey,
  { onExpand = null, defaultCollapsed = true, ignoreClickSelector = null } = {}
) {
  const section = document.getElementById(sectionId);
  const toggle = document.getElementById(toggleId);
  if (!section || !toggle) return;

  function apply(collapsed) {
    if (collapsed) section.classList.add("collapsed");
    else section.classList.remove("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  const stored = localStorage.getItem(storageKey);
  apply(stored == null ? defaultCollapsed : stored === "1");

  toggle.addEventListener("click", (e) => {
    if (
      ignoreClickSelector &&
      e.target instanceof Element &&
      e.target.closest(ignoreClickSelector)
    ) {
      return;
    }
    const collapsed = !section.classList.contains("collapsed");
    localStorage.setItem(storageKey, collapsed ? "1" : "0");
    apply(collapsed);
    if (!collapsed && typeof onExpand === "function") onExpand();
  });

  toggle.addEventListener("keydown", (e) => {
    if (ignoreClickSelector && e.target !== toggle) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle.click();
    }
  });
}

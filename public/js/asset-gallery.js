/** Shared thumb gallery for hero banners and DJ icons. */

/**
 * @typedef {{
 *   name: string|null,
 *   url: string,
 *   active: boolean,
 *   canDelete: boolean,
 *   tag: string,
 * }} GalleryItem
 */

/**
 * @param {{
 *   active?: string|null,
 *   defaultUrl?: string,
 *   banners?: Array<{ name: string, url: string, starter?: boolean }>,
 * }} data
 * @returns {GalleryItem[]}
 */
export function buildBannerGalleryItems(data) {
  const active = data?.active ?? null;
  const defaultUrl = data?.defaultUrl || "hero.jpg";
  const tiles = [{ name: null, url: defaultUrl, starter: true }];
  for (const b of data?.banners || []) {
    tiles.push({ name: b.name, url: b.url, starter: !!b.starter });
  }
  return tiles.map((t) => toGalleryItem(t, active === t.name));
}

/**
 * @param {{
 *   active?: string|null,
 *   djIcon?: string|null,
 *   defaultUrl?: string,
 *   icons?: Array<{ name: string, url: string, starter?: boolean }>,
 * }} data
 * @param {{ defaultIconName?: string }} [opts]
 * @returns {{ active: string|null, items: GalleryItem[] }}
 */
export function buildDjIconGalleryItems(data, opts = {}) {
  const active = data?.active ?? data?.djIcon ?? null;
  const defaultUrl = data?.defaultUrl || "/dj-icons/flat.png";
  const defaultIconName = opts.defaultIconName || "dj-icon-flat.png";
  const tiles = [{ name: null, url: defaultUrl, starter: true }];
  for (const b of data?.icons || []) {
    // Default tile already represents the seeded flat starter.
    if (b.name === defaultIconName) continue;
    tiles.push({ name: b.name, url: b.url, starter: !!b.starter });
  }
  const items = tiles.map((t) => {
    const isActive =
      t.name === null
        ? !active || active === defaultIconName
        : active === t.name;
    return toGalleryItem(t, isActive);
  });
  return { active: active || null, items };
}

/**
 * @param {{ name: string|null, url: string, starter?: boolean }} tile
 * @param {boolean} isActive
 * @returns {GalleryItem}
 */
function toGalleryItem(tile, isActive) {
  return {
    name: tile.name,
    url: tile.url,
    active: isActive,
    canDelete: !!(tile.name && !tile.starter),
    tag: isActive ? "Active" : tile.name === null ? "Default" : "",
  };
}

/**
 * @param {HTMLElement|null|undefined} galleryEl
 * @param {GalleryItem[]} items
 * @param {{
 *   deleteAriaLabel: string,
 *   onSelect: (name: string|null) => void,
 *   onDelete: (name: string) => void,
 * }} handlers
 */
export function mountThumbGallery(galleryEl, items, handlers) {
  if (!galleryEl) return;
  const { deleteAriaLabel, onSelect, onDelete } = handlers;
  galleryEl.innerHTML = "";

  for (const item of items || []) {
    const tile = document.createElement("div");
    tile.className = "banner-thumb" + (item.active ? " active" : "");
    tile.innerHTML = `
      <img src="${item.url}" alt="" loading="lazy" />
      ${
        item.canDelete
          ? `<button class="banner-del" type="button" aria-label="${deleteAriaLabel}" title="Delete">\u00d7</button>`
          : ""
      }
      ${item.tag ? `<span class="banner-tag">${item.tag}</span>` : ""}
    `;
    tile.addEventListener("click", () => onSelect(item.name));
    const del = tile.querySelector(".banner-del");
    if (del) {
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        onDelete(item.name);
      });
    }
    galleryEl.appendChild(tile);
  }
}

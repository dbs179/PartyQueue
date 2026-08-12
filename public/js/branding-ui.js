/** Event name / subtitle / hero banner + DJ icon galleries. */

import {
  buildBannerGalleryItems,
  buildDjIconGalleryItems,
  mountThumbGallery,
} from "./asset-gallery.js";

export const BRANDING_STORAGE_KEY = "pq.branding";
export const MAX_DJ_ICON_BYTES = 2 * 1024 * 1024;
export const MAX_BANNER_BYTES = 8 * 1024 * 1024;
export const DESKTOP_BANNER_MQ = "(min-width: 960px)";

export const BRAND_FONT_PX = {
  header: { min: 16, max: 80, default: 36 },
  subtitle: { min: 10, max: 48, default: 18 },
  version: { min: 8, max: 32, default: 11 },
};

const BRAND_FONT_LEGACY_SCALE = {
  sm: 0.85,
  md: 1,
  lg: 1.2,
  xl: 1.4,
};

/**
 * @param {unknown} value
 * @param {"header"|"subtitle"|"version"} [role]
 */
export function normalizeBrandFontSize(value, role = "header") {
  const cfg = BRAND_FONT_PX[role] || BRAND_FONT_PX.header;
  const legacy =
    BRAND_FONT_LEGACY_SCALE[String(value ?? "").trim().toLowerCase()];
  if (legacy != null) {
    return Math.min(
      cfg.max,
      Math.max(cfg.min, Math.round(cfg.default * legacy))
    );
  }
  const raw =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/px$/i, "").trim());
  if (!Number.isFinite(raw)) return cfg.default;
  return Math.min(cfg.max, Math.max(cfg.min, Math.round(raw)));
}

/**
 * Fill a <select> with 1px steps labeled "24px", "25px", …
 * @param {HTMLSelectElement|null|undefined} select
 * @param {"header"|"subtitle"|"version"} role
 * @param {unknown} [selected]
 */
export function fillBrandFontSizeSelect(select, role, selected) {
  if (!select) return;
  const cfg = BRAND_FONT_PX[role] || BRAND_FONT_PX.header;
  const value = normalizeBrandFontSize(selected ?? cfg.default, role);
  const opts = [];
  for (let n = cfg.min; n <= cfg.max; n += 1) {
    opts.push(`<option value="${n}">${n}px</option>`);
  }
  select.innerHTML = opts.join("");
  select.value = String(value);
}

/**
 * Apply Look-page brand type sizes (px) to CSS variables on :root.
 * @param {{
 *   headerFontSize?: unknown,
 *   subtitleFontSize?: unknown,
 *   versionFontSize?: unknown,
 * }} sizes
 * @param {{ document?: Document }} [opts]
 */
export function applyBrandFontSizes(sizes = {}, opts = {}) {
  const doc = opts.document || (typeof document !== "undefined" ? document : null);
  const root = doc?.documentElement;
  if (!root?.style?.setProperty) return;
  const header = normalizeBrandFontSize(sizes.headerFontSize, "header");
  const subtitle = normalizeBrandFontSize(sizes.subtitleFontSize, "subtitle");
  const version = normalizeBrandFontSize(sizes.versionFontSize, "version");
  root.style.setProperty("--pq-header-font-size", `${header}px`);
  root.style.setProperty("--pq-subtitle-font-size", `${subtitle}px`);
  root.style.setProperty("--pq-version-font-size", `${version}px`);
}

/**
 * Apply Look-page ALL CAPS toggles via classes on :root.
 * @param {{ headerAllCaps?: unknown, subtitleAllCaps?: unknown }} caps
 * @param {{ document?: Document }} [opts]
 */
export function applyBrandCaps(caps = {}, opts = {}) {
  const doc = opts.document || (typeof document !== "undefined" ? document : null);
  const root = doc?.documentElement;
  if (!root?.classList?.toggle) return;
  if (caps.headerAllCaps != null) {
    root.classList.toggle("pq-header-all-caps", !!caps.headerAllCaps);
  }
  if (caps.subtitleAllCaps != null) {
    root.classList.toggle("pq-subtitle-all-caps", !!caps.subtitleAllCaps);
  }
}

/**
 * @param {object} [partial]
 * @param {{ storage?: Storage|null }} [opts]
 */
export function persistBrandingCache(partial = {}, opts = {}) {
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : typeof localStorage !== "undefined"
        ? localStorage
        : null;
  if (!storage) return;
  try {
    let prev = {};
    try {
      prev = JSON.parse(storage.getItem(BRANDING_STORAGE_KEY) || "{}") || {};
    } catch {
      prev = {};
    }
    const next = {
      eventName:
        partial.eventName != null ? partial.eventName : prev.eventName || "",
      subtitle:
        partial.subtitle != null ? partial.subtitle : prev.subtitle || "",
      heroBanner:
        partial.heroBanner !== undefined
          ? partial.heroBanner || null
          : prev.heroBanner || null,
      heroBannerMobile:
        partial.heroBannerMobile !== undefined
          ? partial.heroBannerMobile || null
          : prev.heroBannerMobile || null,
      version: partial.version != null ? partial.version : prev.version || "",
      showVersion:
        partial.showVersion != null
          ? !!partial.showVersion
          : !!prev.showVersion,
      showQueueGenre:
        partial.showQueueGenre != null
          ? !!partial.showQueueGenre
          : !!prev.showQueueGenre,
      headerFontSize: normalizeBrandFontSize(
        partial.headerFontSize != null
          ? partial.headerFontSize
          : prev.headerFontSize,
        "header"
      ),
      subtitleFontSize: normalizeBrandFontSize(
        partial.subtitleFontSize != null
          ? partial.subtitleFontSize
          : prev.subtitleFontSize,
        "subtitle"
      ),
      versionFontSize: normalizeBrandFontSize(
        partial.versionFontSize != null
          ? partial.versionFontSize
          : prev.versionFontSize,
        "version"
      ),
      headerAllCaps:
        partial.headerAllCaps != null
          ? !!partial.headerAllCaps
          : prev.headerAllCaps !== false,
      subtitleAllCaps:
        partial.subtitleAllCaps != null
          ? !!partial.subtitleAllCaps
          : prev.subtitleAllCaps !== false,
    };
    storage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @param {{
 *   heroImg?: HTMLImageElement|null,
 *   headerEventName?: HTMLElement|null,
 *   headerSubtitle?: HTMLElement|null,
 *   headerVersion?: HTMLElement|null,
 *   eventNameInput?: HTMLInputElement|null,
 *   subtitleInput?: HTMLInputElement|null,
 *   headerFontSizeInput?: HTMLSelectElement|null,
 *   subtitleFontSizeInput?: HTMLSelectElement|null,
 *   versionFontSizeInput?: HTMLSelectElement|null,
 *   headerAllCapsInput?: HTMLSelectElement|null,
 *   subtitleAllCapsInput?: HTMLSelectElement|null,
 *   showVersionInput?: HTMLInputElement|null,
 *   showQueueGenreInput?: HTMLInputElement|null,
 *   lookTextSaveBtn?: HTMLElement|null,
 *   bannerUploadBtn?: HTMLElement|null,
 *   bannerFileInput?: HTMLInputElement|null,
 *   bannerGallery?: HTMLElement|null,
 *   bannerMobileUploadBtn?: HTMLElement|null,
 *   bannerMobileFileInput?: HTMLInputElement|null,
 *   bannerMobileGallery?: HTMLElement|null,
 *   djIconUploadBtn?: HTMLElement|null,
 *   djIconFileInput?: HTMLInputElement|null,
 *   djIconGallery?: HTMLElement|null,
 * }} els
 * @param {{
 *   hostFetch: typeof fetch,
 *   fetch?: typeof fetch,
 *   showToast: (msg: string, isError?: boolean) => void,
 *   saveSettings: (patch: object, opts?: object) => void,
 *   getDefaultDjIconName?: () => string,
 *   onDjIconChange?: (name: string|null) => void,
 *   onShowQueueGenreChange?: (enabled: boolean) => void,
 * }} deps
 */
export function createBrandingUi(els, deps) {
  const {
    heroImg,
    headerEventName,
    headerSubtitle,
    headerVersion,
    eventNameInput,
    subtitleInput,
    headerFontSizeInput,
    subtitleFontSizeInput,
    versionFontSizeInput,
    headerAllCapsInput,
    subtitleAllCapsInput,
    showVersionInput,
    showQueueGenreInput,
    lookTextSaveBtn,
    bannerUploadBtn,
    bannerFileInput,
    bannerGallery,
    bannerMobileUploadBtn,
    bannerMobileFileInput,
    bannerMobileGallery,
    djIconUploadBtn,
    djIconFileInput,
    djIconGallery,
  } = els || {};
  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const saveSettings = deps.saveSettings;
  const getDefaultDjIconName =
    deps.getDefaultDjIconName || (() => "dj-icon-headphones.png");
  const onDjIconChange = deps.onDjIconChange || (() => {});
  const onShowQueueGenreChange = deps.onShowQueueGenreChange || (() => {});

  /** @type {string|null} */
  let desktopBanner = null;
  /** @type {string|null} */
  let mobileBanner = null;
  try {
    const cached = JSON.parse(
      (typeof localStorage !== "undefined" &&
        localStorage.getItem(BRANDING_STORAGE_KEY)) ||
        "{}"
    );
    if (cached?.heroBanner) desktopBanner = cached.heroBanner;
    if (cached?.heroBannerMobile) mobileBanner = cached.heroBannerMobile;
  } catch {
    /* ignore */
  }
  try {
    const boot = globalThis.window?.__PQ_BRAND__;
    if (boot && typeof boot === "object") {
      if (boot.heroBanner !== undefined) desktopBanner = boot.heroBanner || null;
      if (boot.heroBannerMobile !== undefined) {
        mobileBanner = boot.heroBannerMobile || null;
      }
    }
  } catch {
    /* ignore */
  }

  function isDesktopViewport() {
    try {
      return globalThis.matchMedia?.(DESKTOP_BANNER_MQ)?.matches ?? true;
    } catch {
      return true;
    }
  }

  function bannerUrlForViewport() {
    const desktop = isDesktopViewport();
    const name = desktop ? desktopBanner : mobileBanner || desktopBanner;
    const key = name || "default";
    const slot = desktop ? "desktop" : "mobile";
    return {
      key: `${slot}:${key}`,
      src: `/banner?slot=${encodeURIComponent(slot)}&b=${encodeURIComponent(key)}`,
    };
  }

  function syncHeroSrc({ force = false } = {}) {
    if (!heroImg) return;
    const { key, src } = bannerUrlForViewport();
    if (!force && heroImg.dataset.bannerKey === key) {
      heroImg.setAttribute("data-ready", "1");
      return;
    }
    heroImg.dataset.bannerKey = key;
    heroImg.src = src;
    heroImg.setAttribute("data-ready", "1");
  }

  function applyHero(name, { force = false } = {}) {
    desktopBanner = name || null;
    persistBrandingCache({ heroBanner: desktopBanner });
    syncHeroSrc({ force });
  }

  function applyHeroMobile(name, { force = false } = {}) {
    mobileBanner = name || null;
    persistBrandingCache({ heroBannerMobile: mobileBanner });
    syncHeroSrc({ force });
  }

  function applyBranding(eventName, subtitle) {
    if (eventName != null && headerEventName) {
      if (headerEventName.textContent !== eventName) {
        headerEventName.textContent = eventName;
      }
      const displayName = document.getElementById("display-event-name");
      if (displayName && displayName.textContent !== eventName) {
        displayName.textContent = eventName;
      }
      if (document.title !== eventName) document.title = eventName;
    }
    if (subtitle != null && headerSubtitle) {
      if (headerSubtitle.textContent !== subtitle) {
        headerSubtitle.textContent = subtitle;
      }
      headerSubtitle.hidden = subtitle.trim() === "";
      headerSubtitle.setAttribute("data-ready", "1");
    }
    document.getElementById("header-title")?.setAttribute("data-ready", "1");
    if (eventName != null || subtitle != null) {
      persistBrandingCache({
        eventName: eventName != null ? eventName : undefined,
        subtitle: subtitle != null ? subtitle : undefined,
      });
    }
  }

  function renderDjIcons(data) {
    if (!djIconGallery) return;
    const { active, items } = buildDjIconGalleryItems(data, {
      defaultIconName: getDefaultDjIconName(),
    });
    onDjIconChange(active);
    mountThumbGallery(djIconGallery, items, {
      deleteAriaLabel: "Delete DJ icon",
      onSelect: selectDjIcon,
      onDelete: deleteDjIcon,
    });
  }

  async function loadDjIcons() {
    try {
      const res = await fetchFn("/api/dj-icon");
      if (!res.ok) return;
      renderDjIcons(await res.json());
    } catch {
      /* leave gallery as-is on transient errors */
    }
  }

  async function selectDjIcon(name) {
    try {
      const res = await hostFetch("/api/dj-icon/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not switch DJ icon.");
      renderDjIcons(data);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function deleteDjIcon(name) {
    try {
      const res = await hostFetch(`/api/dj-icon/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete DJ icon.");
      renderDjIcons(data);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderBanners(data) {
    if (bannerGallery) {
      mountThumbGallery(
        bannerGallery,
        buildBannerGalleryItems(data, { slot: "desktop" }),
        {
          deleteAriaLabel: "Delete banner",
          onSelect: (name) => selectBanner(name, "desktop"),
          onDelete: deleteBanner,
        }
      );
    }
    if (bannerMobileGallery) {
      mountThumbGallery(
        bannerMobileGallery,
        buildBannerGalleryItems(
          {
            ...data,
            active: data.activeMobile ?? null,
          },
          { slot: "mobile" }
        ),
        {
          deleteAriaLabel: "Delete banner",
          onSelect: (name) => selectBanner(name, "mobile"),
          onDelete: deleteBanner,
        }
      );
    }
  }

  async function loadBanners() {
    try {
      const res = await fetchFn("/api/banners");
      if (!res.ok) return;
      const data = await res.json();
      if (data.active !== undefined) desktopBanner = data.active || null;
      if (data.activeMobile !== undefined) {
        mobileBanner = data.activeMobile || null;
      }
      persistBrandingCache({
        heroBanner: desktopBanner,
        heroBannerMobile: mobileBanner,
      });
      syncHeroSrc();
      renderBanners(data);
    } catch {
      /* leave gallery as-is on transient errors */
    }
  }

  async function selectBanner(name, slot = "desktop") {
    try {
      const res = await hostFetch("/api/banners/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not switch banner.");
      applyHero(data.active);
      applyHeroMobile(data.activeMobile);
      renderBanners(data);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function deleteBanner(name) {
    if (!name) return;
    try {
      const res = await hostFetch(`/api/banners/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete banner.");
      applyHero(data.active);
      applyHeroMobile(data.activeMobile);
      renderBanners(data);
      showToast("Banner deleted");
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function wireBannerUpload(btn, input, slot) {
    if (!btn || !input) return;
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > MAX_BANNER_BYTES) {
        showToast("Image is too large (8 MB max).", true);
        input.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        btn.disabled = true;
        try {
          const res = await hostFetch("/api/banners", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: reader.result, slot }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Upload failed.");
          applyHero(data.active);
          applyHeroMobile(data.activeMobile);
          renderBanners(data);
          showToast(slot === "mobile" ? "Phone banner updated" : "Desktop banner updated");
        } catch (err) {
          showToast(err.message, true);
        } finally {
          btn.disabled = false;
          input.value = "";
        }
      };
      reader.readAsDataURL(file);
    });
  }

  if (djIconUploadBtn && djIconFileInput) {
    djIconUploadBtn.addEventListener("click", () => djIconFileInput.click());
    djIconFileInput.addEventListener("change", () => {
      const file = djIconFileInput.files && djIconFileInput.files[0];
      if (!file) return;
      if (file.size > MAX_DJ_ICON_BYTES) {
        showToast("Image is too large (2 MB max).", true);
        djIconFileInput.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        djIconUploadBtn.disabled = true;
        try {
          const res = await hostFetch("/api/dj-icon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: reader.result }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Upload failed.");
          renderDjIcons(data);
          showToast("DJ Icon updated");
        } catch (err) {
          showToast(err.message, true);
        } finally {
          djIconUploadBtn.disabled = false;
          djIconFileInput.value = "";
        }
      };
      reader.readAsDataURL(file);
    });
  }

  wireBannerUpload(bannerUploadBtn, bannerFileInput, "desktop");
  wireBannerUpload(bannerMobileUploadBtn, bannerMobileFileInput, "mobile");

  try {
    const mq = globalThis.matchMedia?.(DESKTOP_BANNER_MQ);
    const onViewportChange = () => syncHeroSrc();
    if (mq?.addEventListener) mq.addEventListener("change", onViewportChange);
    else if (mq?.addListener) mq.addListener(onViewportChange);
  } catch {
    /* matchMedia unavailable */
  }

  fillBrandFontSizeSelect(headerFontSizeInput, "header");
  fillBrandFontSizeSelect(subtitleFontSizeInput, "subtitle");
  fillBrandFontSizeSelect(versionFontSizeInput, "version");

  function currentFontSizes() {
    return {
      headerFontSize: normalizeBrandFontSize(
        headerFontSizeInput?.value,
        "header"
      ),
      subtitleFontSize: normalizeBrandFontSize(
        subtitleFontSizeInput?.value,
        "subtitle"
      ),
      versionFontSize: normalizeBrandFontSize(
        versionFontSizeInput?.value,
        "version"
      ),
    };
  }

  function capsFromSelect(select, fallback = true) {
    if (!select) return fallback;
    return select.value !== "0";
  }

  function currentCaps() {
    return {
      headerAllCaps: capsFromSelect(headerAllCapsInput, true),
      subtitleAllCaps: capsFromSelect(subtitleAllCapsInput, true),
    };
  }

  function previewFontSizes() {
    const sizes = currentFontSizes();
    applyBrandFontSizes(sizes);
    persistBrandingCache(sizes);
  }

  function previewCaps() {
    const caps = currentCaps();
    applyBrandCaps(caps);
    persistBrandingCache(caps);
  }

  function saveLookText() {
    const sizes = currentFontSizes();
    const caps = currentCaps();
    applyBrandFontSizes(sizes);
    applyBrandCaps(caps);
    persistBrandingCache({ ...sizes, ...caps });
    saveSettings(
      {
        eventName: eventNameInput?.value,
        subtitle: subtitleInput?.value,
        ...sizes,
        ...caps,
      },
      { toastMessage: "Saved" }
    );
  }

  lookTextSaveBtn?.addEventListener("click", saveLookText);
  for (const input of [eventNameInput, subtitleInput]) {
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveLookText();
      }
    });
  }
  for (const input of [
    headerFontSizeInput,
    subtitleFontSizeInput,
    versionFontSizeInput,
  ]) {
    input?.addEventListener("change", previewFontSizes);
  }
  for (const input of [headerAllCapsInput, subtitleAllCapsInput]) {
    input?.addEventListener("change", previewCaps);
  }

  showVersionInput?.addEventListener("change", () => {
    const show = !!showVersionInput.checked;
    saveSettings({ showVersion: show });
    if (headerVersion) headerVersion.hidden = !show;
    const displayVersion = document.getElementById("display-version");
    if (displayVersion) displayVersion.hidden = !show;
    persistBrandingCache({ showVersion: show });
  });

  showQueueGenreInput?.addEventListener("change", () => {
    onShowQueueGenreChange(!!showQueueGenreInput.checked);
    saveSettings({ showQueueGenre: showQueueGenreInput.checked });
  });

  return {
    persistBrandingCache,
    applyHero,
    applyHeroMobile,
    applyBranding,
    applyBrandFontSizes,
    applyBrandCaps,
    syncHeroSrc,
    loadBanners,
    loadDjIcons,
    selectDjIcon,
  };
}

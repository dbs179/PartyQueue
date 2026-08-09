/** Event name / subtitle / hero banner + DJ icon galleries. */

import {
  buildBannerGalleryItems,
  buildDjIconGalleryItems,
  mountThumbGallery,
} from "./asset-gallery.js";

export const BRANDING_STORAGE_KEY = "pq.branding";
export const MAX_DJ_ICON_BYTES = 2 * 1024 * 1024;
export const MAX_BANNER_BYTES = 8 * 1024 * 1024;

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
      version: partial.version != null ? partial.version : prev.version || "",
      showVersion:
        partial.showVersion != null
          ? !!partial.showVersion
          : !!prev.showVersion,
      showQueueGenre:
        partial.showQueueGenre != null
          ? !!partial.showQueueGenre
          : !!prev.showQueueGenre,
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
 *   showVersionInput?: HTMLInputElement|null,
 *   showQueueGenreInput?: HTMLInputElement|null,
 *   lookTextSaveBtn?: HTMLElement|null,
 *   bannerUploadBtn?: HTMLElement|null,
 *   bannerFileInput?: HTMLInputElement|null,
 *   bannerGallery?: HTMLElement|null,
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
    showVersionInput,
    showQueueGenreInput,
    lookTextSaveBtn,
    bannerUploadBtn,
    bannerFileInput,
    bannerGallery,
    djIconUploadBtn,
    djIconFileInput,
    djIconGallery,
  } = els || {};
  const hostFetch = deps.hostFetch;
  const fetchFn = deps.fetch || fetch;
  const showToast = deps.showToast;
  const saveSettings = deps.saveSettings;
  const getDefaultDjIconName =
    deps.getDefaultDjIconName || (() => "dj-icon-flat.png");
  const onDjIconChange = deps.onDjIconChange || (() => {});
  const onShowQueueGenreChange = deps.onShowQueueGenreChange || (() => {});

  function applyHero(name, { force = false } = {}) {
    if (!heroImg) return;
    const key = name || "default";
    persistBrandingCache({ heroBanner: name || null });
    if (!force && heroImg.dataset.bannerKey === key) {
      heroImg.setAttribute("data-ready", "1");
      return;
    }
    heroImg.dataset.bannerKey = key;
    heroImg.src = `/banner?b=${encodeURIComponent(key)}`;
    heroImg.setAttribute("data-ready", "1");
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
    if (!bannerGallery) return;
    mountThumbGallery(bannerGallery, buildBannerGalleryItems(data), {
      deleteAriaLabel: "Delete banner",
      onSelect: selectBanner,
      onDelete: deleteBanner,
    });
  }

  async function loadBanners() {
    try {
      const res = await fetchFn("/api/banners");
      if (!res.ok) return;
      renderBanners(await res.json());
    } catch {
      /* leave gallery as-is on transient errors */
    }
  }

  async function selectBanner(name) {
    try {
      const res = await hostFetch("/api/banners/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not switch banner.");
      applyHero(data.active);
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
      renderBanners(data);
      showToast("Banner deleted");
    } catch (err) {
      showToast(err.message, true);
    }
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

  if (bannerUploadBtn && bannerFileInput) {
    bannerUploadBtn.addEventListener("click", () => bannerFileInput.click());
    bannerFileInput.addEventListener("change", () => {
      const file = bannerFileInput.files && bannerFileInput.files[0];
      if (!file) return;
      if (file.size > MAX_BANNER_BYTES) {
        showToast("Image is too large (8 MB max).", true);
        bannerFileInput.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        bannerUploadBtn.disabled = true;
        try {
          const res = await hostFetch("/api/banners", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: reader.result }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Upload failed.");
          applyHero(data.active);
          renderBanners(data);
          showToast("Banner updated");
        } catch (err) {
          showToast(err.message, true);
        } finally {
          bannerUploadBtn.disabled = false;
          bannerFileInput.value = "";
        }
      };
      reader.readAsDataURL(file);
    });
  }

  function saveLookText() {
    saveSettings(
      {
        eventName: eventNameInput?.value,
        subtitle: subtitleInput?.value,
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
    applyBranding,
    loadBanners,
    loadDjIcons,
    selectDjIcon,
  };
}

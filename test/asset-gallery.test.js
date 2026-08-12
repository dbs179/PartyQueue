import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBannerGalleryItems,
  buildDjIconGalleryItems,
  mountThumbGallery,
} from "../public/js/asset-gallery.js";

test("buildBannerGalleryItems includes default + banners", () => {
  const items = buildBannerGalleryItems({
    active: "party.png",
    defaultUrl: "hero.jpg",
    banners: [
      { name: "party.png", url: "/banners/party.png", starter: false },
      { name: "seed.jpg", url: "/banners/seed.jpg", starter: true },
    ],
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    name: null,
    url: "hero.jpg",
    active: false,
    canDelete: false,
    tag: "Default",
  });
  assert.equal(items[1].active, true);
  assert.equal(items[1].tag, "Active");
  assert.equal(items[1].canDelete, true);
  assert.equal(items[2].canDelete, true, "stored banners are deletable");
});

test("buildBannerGalleryItems filters by desktop/mobile slot pools", () => {
  const data = {
    active: "wide.png",
    defaultUrl: "hero.jpg",
    bannersDesktop: [
      { name: "wide.png", url: "/banners/wide.png", starter: true },
    ],
    bannersMobile: [
      { name: "phone.jpg", url: "/banners/phone.jpg", starter: true },
    ],
    banners: [
      { name: "wide.png", url: "/banners/wide.png", starter: true },
      { name: "phone.jpg", url: "/banners/phone.jpg", starter: true },
    ],
  };
  const desktop = buildBannerGalleryItems(data, { slot: "desktop" });
  const mobile = buildBannerGalleryItems(
    { ...data, active: "phone.jpg" },
    { slot: "mobile" }
  );
  assert.deepEqual(
    desktop.map((i) => i.name),
    [null, "wide.png"]
  );
  assert.deepEqual(
    mobile.map((i) => i.name),
    [null, "phone.jpg"]
  );
});

test("buildDjIconGalleryItems skips seeded default name and marks default active", () => {
  const { active, items } = buildDjIconGalleryItems(
    {
      active: "dj-icon-flat.png",
      defaultUrl: "/dj-icons/flat.png",
      icons: [
        { name: "dj-icon-flat.png", url: "/dj-icons/flat.png", starter: true },
        { name: "custom.png", url: "/dj-icons/custom.png", starter: false },
      ],
    },
    { defaultIconName: "dj-icon-flat.png" }
  );
  assert.equal(active, "dj-icon-flat.png");
  assert.equal(items.length, 2);
  assert.equal(items[0].name, null);
  assert.equal(items[0].active, true);
  assert.equal(items[0].tag, "Active");
  assert.equal(items[1].name, "custom.png");
  assert.equal(items[1].canDelete, true);
});

test("mountThumbGallery wires select and delete handlers", () => {
  const children = [];
  const gallery = {
    innerHTML: "x",
    appendChild(node) {
      children.push(node);
    },
  };
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const classes = new Set();
      const listeners = {};
      const el = {
        tagName: tag,
        className: "",
        innerHTML: "",
        classList: {
          add: (c) => classes.add(c),
        },
        addEventListener(type, fn) {
          listeners[type] = fn;
        },
        querySelector(sel) {
          if (sel === ".banner-del" && this.innerHTML.includes("banner-del")) {
            return {
              addEventListener(type, fn) {
                listeners[`del:${type}`] = fn;
              },
              _listeners: listeners,
            };
          }
          return null;
        },
        _listeners: listeners,
        _classes: classes,
      };
      created.push(el);
      return el;
    },
  };

  const selected = [];
  const deleted = [];
  mountThumbGallery(
    gallery,
    [
      {
        name: null,
        url: "a.jpg",
        active: true,
        canDelete: false,
        tag: "Active",
      },
      {
        name: "b.png",
        url: "b.png",
        active: false,
        canDelete: true,
        tag: "",
      },
    ],
    {
      deleteAriaLabel: "Delete banner",
      onSelect: (name) => selected.push(name),
      onDelete: (name) => deleted.push(name),
    }
  );

  assert.equal(gallery.innerHTML, "");
  assert.equal(children.length, 2);
  assert.match(created[0].className, /active/);
  created[0]._listeners.click();
  assert.deepEqual(selected, [null]);
  created[1]._listeners.click();
  assert.deepEqual(selected, [null, "b.png"]);
  created[1]._listeners["del:click"]({ stopPropagation() {} });
  assert.deepEqual(deleted, ["b.png"]);

  delete globalThis.document;
});

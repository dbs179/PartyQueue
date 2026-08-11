import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { wirePanelCollapse } from "../public/js/panel-collapse.js";

const memory = new Map();

function el(id, { tag = "div", parent = null } = {}) {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  const node = {
    id,
    tagName: tag.toUpperCase(),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => {
        if (arguments.length > 1) {
          if (on) classes.add(c);
          else classes.delete(c);
          return on;
        }
        if (classes.has(c)) {
          classes.delete(c);
          return false;
        }
        classes.add(c);
        return true;
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    click() {
      for (const fn of listeners.click || []) fn({ target: this });
    },
    closest(sel) {
      if (sel.startsWith("#") && this.id === sel.slice(1)) return this;
      return parent?.closest?.(sel) || null;
    },
    _listeners: listeners,
  };
  return node;
}

beforeEach(() => {
  memory.clear();
  globalThis.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  };
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.localStorage;
});

test("wirePanelCollapse applies defaultCollapsed and toggles storage", () => {
  const section = el("sec");
  const toggle = el("tog", { tag: "button" });
  globalThis.document = {
    getElementById: (id) =>
      id === "sec" ? section : id === "tog" ? toggle : null,
  };

  wirePanelCollapse("sec", "tog", "pq.testCollapse", {
    defaultCollapsed: true,
  });
  assert.equal(section.classList.contains("collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.click();
  assert.equal(section.classList.contains("collapsed"), false);
  assert.equal(memory.get("pq.testCollapse"), "0");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("wirePanelCollapse honors stored expanded state", () => {
  memory.set("pq.testCollapse", "0");
  const section = el("sec");
  const toggle = el("tog", { tag: "button" });
  globalThis.document = {
    getElementById: (id) =>
      id === "sec" ? section : id === "tog" ? toggle : null,
  };
  wirePanelCollapse("sec", "tog", "pq.testCollapse", {
    defaultCollapsed: true,
  });
  assert.equal(section.classList.contains("collapsed"), false);
});

test("wirePanelCollapse setCollapsed expands and can fire onExpand", () => {
  const section = el("sec");
  const toggle = el("tog", { tag: "button" });
  globalThis.document = {
    getElementById: (id) =>
      id === "sec" ? section : id === "tog" ? toggle : null,
  };
  let expands = 0;
  const api = wirePanelCollapse("sec", "tog", "pq.testCollapse", {
    defaultCollapsed: true,
    onExpand: () => {
      expands += 1;
    },
  });
  assert.ok(api);
  assert.equal(api.isCollapsed(), true);
  api.setCollapsed(false, { persist: true, fireOnExpand: true });
  assert.equal(api.isCollapsed(), false);
  assert.equal(memory.get("pq.testCollapse"), "0");
  assert.equal(expands, 1);
  api.setCollapsed(true);
  assert.equal(api.isCollapsed(), true);
  assert.equal(memory.get("pq.testCollapse"), "1");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visualViewportBox,
  applyVisualViewportBox,
  blurSoftKeyboard,
  clearVisualViewportBox,
} from "../public/js/visual-viewport-box.js";

test("visualViewportBox fills the layout viewport without a Visual Viewport", () => {
  assert.deepEqual(visualViewportBox(null), {
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
  });
});

test("visualViewportBox follows a shrunk Android keyboard viewport", () => {
  assert.deepEqual(
    visualViewportBox({
      offsetTop: 0,
      offsetLeft: 0,
      width: 390,
      height: 420,
    }),
    { top: 0, left: 0, width: 390, height: 420 }
  );
  assert.deepEqual(
    visualViewportBox({
      offsetTop: 80,
      offsetLeft: 0,
      width: 390,
      height: 500,
    }),
    { top: 80, left: 0, width: 390, height: 500 }
  );
});

test("applyVisualViewportBox docks a fixed overlay to the visible box", () => {
  const el = { style: {} };
  applyVisualViewportBox(el, {
    offsetTop: 12,
    offsetLeft: 0,
    width: 360,
    height: 400,
  });
  assert.equal(el.style.position, "fixed");
  assert.equal(el.style.top, "12px");
  assert.equal(el.style.left, "0px");
  assert.equal(el.style.width, "360px");
  assert.equal(el.style.height, "400px");
  assert.equal(el.style.bottom, "auto");
  clearVisualViewportBox(el);
  assert.equal(el.style.top, "");
  assert.equal(el.style.height, "");
});

test("blurSoftKeyboard dismisses a focused suggestion textarea", () => {
  const textarea = {
    tagName: "TEXTAREA",
    blurCalls: 0,
    blur() {
      this.blurCalls += 1;
    },
  };
  const doc = { activeElement: textarea, body: {} };
  assert.equal(blurSoftKeyboard(doc), true);
  assert.equal(textarea.blurCalls, 1);
  assert.equal(blurSoftKeyboard({ activeElement: doc.body, body: doc.body }), false);
  assert.equal(blurSoftKeyboard({ activeElement: { tagName: "BUTTON", blur() {} } }), false);
  assert.equal(blurSoftKeyboard(null), false);
});

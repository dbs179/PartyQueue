import { test } from "node:test";
import assert from "node:assert/strict";
import {
  settingsGateOk,
  validateNewPin,
  validateBootstrapCode,
  hostPinStatusView,
  pinRateLimitMessage,
} from "../public/js/host-pin-ui.js";

test("settingsGateOk allows when PIN not required", () => {
  assert.equal(settingsGateOk(false, false), true);
  assert.equal(settingsGateOk(false, true), true);
});

test("settingsGateOk requires unlock when PIN required", () => {
  assert.equal(settingsGateOk(true, false), false);
  assert.equal(settingsGateOk(true, true), true);
});

test("validateNewPin enforces length and match", () => {
  assert.equal(validateNewPin("", ""), "PIN must be at least 4 characters.");
  assert.equal(validateNewPin("123", "123"), "PIN must be at least 4 characters.");
  assert.equal(validateNewPin("1234", "1235"), "PIN confirmation does not match.");
  assert.equal(validateNewPin("1234", "1234"), null);
  assert.equal(validateNewPin("  abcd  ", "abcd"), null);
});

test("validateBootstrapCode accepts six digits only", () => {
  assert.equal(validateBootstrapCode("123456"), true);
  assert.equal(validateBootstrapCode("12345"), false);
  assert.equal(validateBootstrapCode("1234567"), false);
  assert.equal(validateBootstrapCode("12a456"), false);
  assert.equal(validateBootstrapCode(" 123456 "), true);
});

test("hostPinStatusView for unset PIN", () => {
  const view = hostPinStatusView({ required: false, bootstrapRequired: true });
  assert.match(view.text, /No host PIN set/);
  assert.equal(view.showCurrentRow, false);
  assert.equal(view.showBootstrapRow, true);
  assert.equal(view.showClear, false);
});

test("hostPinStatusView for file PIN", () => {
  const view = hostPinStatusView({
    required: true,
    source: "file",
    removable: true,
  });
  assert.match(view.text, /saved on this server/);
  assert.equal(view.showCurrentRow, true);
  assert.equal(view.showBootstrapRow, false);
  assert.equal(view.showClear, true);
});

test("hostPinStatusView for env PIN", () => {
  const view = hostPinStatusView({
    required: true,
    source: "env",
    removable: false,
  });
  assert.match(view.text, /SETTINGS_PIN/);
  assert.equal(view.showClear, false);
});

test("pinRateLimitMessage formats seconds", () => {
  assert.equal(pinRateLimitMessage(30000), "Too many attempts. Try again in 30s.");
  assert.equal(pinRateLimitMessage(1500), "Too many attempts. Try again in 2s.");
  assert.equal(pinRateLimitMessage(null), "Too many attempts. Try again in 30s.");
});

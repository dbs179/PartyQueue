import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUEST_BANNER_PAUSED,
  GUEST_BANNER_PARTY_OVER,
  guestLockBannerView,
  paintGuestLockBanner,
} from "../public/js/guest-lock-banner.js";

test("guestLockBannerView hides when neither lock is on", () => {
  assert.deepEqual(guestLockBannerView({}), {
    hidden: true,
    text: GUEST_BANNER_PAUSED,
    partyOver: false,
  });
});

test("guestLockBannerView prefers party-over copy when both set", () => {
  assert.deepEqual(
    guestLockBannerView({ partyOver: true, requestsPaused: true }),
    {
      hidden: false,
      text: GUEST_BANNER_PARTY_OVER,
      partyOver: true,
    }
  );
  assert.deepEqual(guestLockBannerView({ requestsPaused: true }), {
    hidden: false,
    text: GUEST_BANNER_PAUSED,
    partyOver: false,
  });
});

test("paintGuestLockBanner updates element", () => {
  const classes = new Set();
  const el = {
    hidden: true,
    textContent: "",
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
  };
  paintGuestLockBanner(
    el,
    guestLockBannerView({ partyOver: true, requestsPaused: true })
  );
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, GUEST_BANNER_PARTY_OVER);
  assert.equal(el.classList.contains("party-over"), true);

  paintGuestLockBanner(el, guestLockBannerView({ requestsPaused: true }));
  assert.equal(el.textContent, GUEST_BANNER_PAUSED);
  assert.equal(el.classList.contains("party-over"), false);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeWifiQrField, wifiQrPayload } from "../src/guest-wifi.js";

describe("wifi QR payload", () => {
  it("builds a WPA WIFI: string", () => {
    assert.equal(
      wifiQrPayload({ ssid: "PartyNet", password: "secret" }),
      "WIFI:T:WPA;S:PartyNet;P:secret;;"
    );
  });

  it("uses nopass when there is no password", () => {
    assert.equal(
      wifiQrPayload({ ssid: "OpenNet", password: "" }),
      "WIFI:T:nopass;S:OpenNet;;"
    );
  });

  it("escapes special characters in SSID and password", () => {
    assert.equal(escapeWifiQrField(`a;b,c:d"e\\f`), `a\\;b\\,c\\:d\\"e\\\\f`);
    assert.equal(
      wifiQrPayload({ ssid: "Cafe;WiFi", password: "p:ass;word" }),
      "WIFI:T:WPA;S:Cafe\\;WiFi;P:p\\:ass\\;word;;"
    );
  });

  it("returns empty without an SSID", () => {
    assert.equal(wifiQrPayload({ ssid: "  ", password: "x" }), "");
  });
});

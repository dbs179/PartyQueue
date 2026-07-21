import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanSonosHost,
  cleanSonosRoom,
  cleanSonosRegion,
} from "../src/sonos-config.js";

describe("sonos-config cleaners", () => {
  it("accepts IPv4 hosts and simple hostnames", () => {
    assert.equal(cleanSonosHost("192.0.2.196"), "192.0.2.196");
    assert.equal(cleanSonosHost(" 192.168.1.50 "), "192.168.1.50");
    assert.equal(cleanSonosHost("sonos-kitchen.local"), "sonos-kitchen.local");
    assert.equal(cleanSonosHost(""), null);
    assert.equal(cleanSonosHost("not a host"), null);
    assert.equal(cleanSonosHost("999.1.1.1"), null);
  });

  it("trims room names", () => {
    assert.equal(cleanSonosRoom(" Kitchen "), "Kitchen");
    assert.equal(cleanSonosRoom(""), null);
  });

  it("normalizes region", () => {
    assert.equal(cleanSonosRegion("eu"), "EU");
    assert.equal(cleanSonosRegion("NorthAmerica"), "NorthAmerica");
    assert.equal(cleanSonosRegion("na"), "NorthAmerica");
    assert.equal(cleanSonosRegion("nope"), null);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSonosUnreachableError } from "../src/sonos-reachability.js";

test("isSonosUnreachableError matches TCP and timeout failures", () => {
  const host = new Error("connect EHOSTUNREACH 10.10.20.196:1400");
  host.code = "EHOSTUNREACH";
  assert.equal(isSonosUnreachableError(host), true);
  assert.equal(isSonosUnreachableError(new Error("Sonos topology timed out")), true);
  assert.equal(isSonosUnreachableError(new Error("UPnP 701")), false);
});

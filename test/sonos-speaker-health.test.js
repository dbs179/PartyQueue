import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  hasReadySonosManager,
  listManagedSonosDevices,
} from "../src/sonos-core.js";
import {
  noteSpeakerFailure,
  reachabilityInfoForTests,
  resetSpeakerReachabilityForTests,
} from "../src/sonos-reachability.js";
import {
  listSpeakerHealth,
  noteSpeakerHealthFailure,
  noteSpeakerHealthSuccess,
  resetSpeakerHealthForTests,
  runSonosSpeakerHealthProbe,
  setSpeakerHealthLoggerForTests,
  SPEAKER_HEALTH_PROBE_MS,
  SPEAKER_HEALTH_RECENT_SIGNAL_MS,
  speakerHealthMonitorArmed,
  startSonosSpeakerHealthMonitor,
  stopSonosSpeakerHealthMonitor,
  UNRESPONSIVE_AFTER_FAILURES,
} from "../src/sonos-speaker-health.js";

const office = { Name: "Office", Host: "10.10.20.50", Uuid: "RINCON_OFFICE" };
const living = { Name: "Living Room", Host: "10.10.20.51", Uuid: "RINCON_LIVING" };
const timeout = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });

afterEach(() => {
  resetSpeakerHealthForTests();
  resetSpeakerReachabilityForTests();
});

function logs() {
  const lines = [];
  setSpeakerHealthLoggerForTests((line) => lines.push(line));
  return lines;
}

function stateOf(name) {
  return listSpeakerHealth().find((row) => row.name === name);
}

test("an unknown speaker becomes HEALTHY after the first success", () => {
  const lines = logs();
  const row = noteSpeakerHealthSuccess(office, { now: 1_000, latencyMs: 40 });
  assert.equal(row.state, "HEALTHY");
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.lastSuccessAt, 1_000);
  assert.equal(row.lastLatencyMs, 40);
  assert.deepEqual(lines, ["[Sonos Health] Office UNKNOWN -> HEALTHY"]);
});

test("one communication failure keeps HEALTHY and records the miss", () => {
  const lines = logs();
  noteSpeakerHealthSuccess(office, { now: 1_000 });
  lines.length = 0;
  const row = noteSpeakerHealthFailure(office, timeout, {
    now: 2_000,
    latencyMs: 2_000,
  });
  assert.equal(row.state, "HEALTHY");
  assert.equal(row.consecutiveFailures, 1);
  assert.equal(row.consecutiveSuccesses, 0);
  assert.equal(row.lastFailureAt, 2_000);
  assert.equal(row.lastFailureReason, "timeout");
  assert.equal(row.lastLatencyMs, 2_000);
  assert.deepEqual(lines, []);
});

test("a second consecutive failure becomes DEGRADED", () => {
  const lines = logs();
  noteSpeakerHealthSuccess(office, { now: 1_000 });
  noteSpeakerHealthFailure(office, timeout, { now: 2_000 });
  lines.length = 0;
  const row = noteSpeakerHealthFailure(office, timeout, { now: 3_000 });
  assert.equal(row.state, "DEGRADED");
  assert.equal(row.consecutiveFailures, 2);
  assert.equal(row.lastFailureAt, 3_000);
  assert.deepEqual(lines, ["[Sonos Health] Office HEALTHY -> DEGRADED: timeout"]);
});

test("DEGRADED becomes UNRESPONSIVE after the configured consecutive failures", () => {
  const lines = logs();
  noteSpeakerHealthSuccess(office, { now: 1_000 });
  lines.length = 0;
  const first = noteSpeakerHealthFailure(office, timeout, { now: 1_001 });
  assert.equal(first.state, "HEALTHY");
  assert.equal(first.consecutiveFailures, 1);
  const second = noteSpeakerHealthFailure(office, timeout, { now: 1_002 });
  assert.equal(second.state, "DEGRADED");
  assert.equal(second.consecutiveFailures, 2);
  const third = noteSpeakerHealthFailure(office, timeout, { now: 1_003 });
  assert.equal(UNRESPONSIVE_AFTER_FAILURES, 3);
  assert.equal(third.state, "UNRESPONSIVE");
  assert.equal(third.consecutiveFailures, 3);
  assert.deepEqual(lines, [
    "[Sonos Health] Office HEALTHY -> DEGRADED: timeout",
    "[Sonos Health] Office DEGRADED -> UNRESPONSIVE: 3 consecutive failures",
  ]);
});

test("a success after one failure clears the streak and stays HEALTHY", () => {
  const lines = logs();
  noteSpeakerHealthSuccess(office, { now: 1_000 });
  noteSpeakerHealthFailure(office, timeout, { now: 2_000 });
  lines.length = 0;
  const row = noteSpeakerHealthSuccess(office, { now: 3_000 });
  assert.equal(row.state, "HEALTHY");
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.lastSuccessAt, 3_000);
  assert.deepEqual(lines, []);
  const again = noteSpeakerHealthFailure(office, timeout, { now: 4_000 });
  assert.equal(again.state, "HEALTHY");
  assert.equal(again.consecutiveFailures, 1);
  assert.deepEqual(lines, []);
});

test("UNKNOWN stays UNKNOWN on the first failure, then DEGRADED, then UNRESPONSIVE", () => {
  const lines = logs();
  const first = noteSpeakerHealthFailure(office, timeout, { now: 1_000, latencyMs: 50 });
  assert.equal(first.state, "UNKNOWN");
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.lastFailureReason, "timeout");
  assert.equal(first.lastLatencyMs, 50);
  const second = noteSpeakerHealthFailure(office, timeout, { now: 2_000 });
  assert.equal(second.state, "DEGRADED");
  assert.equal(second.consecutiveFailures, 2);
  const third = noteSpeakerHealthFailure(office, timeout, { now: 3_000 });
  assert.equal(third.state, "UNRESPONSIVE");
  assert.equal(third.consecutiveFailures, 3);
  assert.deepEqual(lines, [
    "[Sonos Health] Office UNKNOWN -> DEGRADED: timeout",
    "[Sonos Health] Office DEGRADED -> UNRESPONSIVE: 3 consecutive failures",
  ]);
});

test("classifying a failure does not skip the speaker", () => {
  noteSpeakerHealthFailure(office, timeout, { now: 1_000 });
  noteSpeakerHealthFailure(office, timeout, { now: 2_000 });
  assert.deepEqual(reachabilityInfoForTests().skipped, []);
});

test("a success resets consecutive failures", () => {
  noteSpeakerHealthFailure(office, timeout, { now: 1_000 });
  noteSpeakerHealthFailure(office, timeout, { now: 2_000 });
  assert.equal(stateOf("Office").state, "DEGRADED");
  const row = noteSpeakerHealthSuccess(office, { now: 3_000 });
  assert.equal(row.state, "HEALTHY");
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.lastSuccessAt, 3_000);
});

test("UNRESPONSIVE recovers to HEALTHY after two confirmed successes", () => {
  const lines = logs();
  for (let i = 1; i <= 3; i++) {
    noteSpeakerHealthFailure(office, timeout, { now: i });
  }
  lines.length = 0;
  const first = noteSpeakerHealthSuccess(office, { now: 10 });
  assert.equal(first.state, "UNRESPONSIVE");
  assert.equal(first.consecutiveFailures, 0);
  assert.equal(first.consecutiveSuccesses, 1);
  const second = noteSpeakerHealthSuccess(office, { now: 11 });
  assert.equal(second.state, "HEALTHY");
  assert.equal(second.consecutiveSuccesses, 2);
  assert.deepEqual(lines, ["[Sonos Health] Office UNRESPONSIVE -> HEALTHY"]);
});

test("a failure while UNRESPONSIVE does not log again", () => {
  const lines = logs();
  for (let i = 1; i <= 3; i++) noteSpeakerHealthFailure(office, timeout, { now: i });
  lines.length = 0;
  const row = noteSpeakerHealthFailure(office, timeout, { now: 9 });
  assert.equal(row.state, "UNRESPONSIVE");
  assert.equal(row.consecutiveFailures, 4);
  assert.deepEqual(lines, []);
});

test("application and validation errors do not mark a speaker unhealthy", () => {
  const lines = logs();
  const upnp = Object.assign(new Error("UPnP 701 Transition not available"), {
    statusCode: 701,
  });
  assert.equal(noteSpeakerFailure(office, upnp), false);
  assert.equal(listSpeakerHealth().length, 0);
  assert.deepEqual(reachabilityInfoForTests().skipped, []);

  noteSpeakerHealthSuccess(living, { now: 1_000 });
  lines.length = 0;
  assert.equal(noteSpeakerFailure(living, new Error("queue validation failed")), false);
  assert.equal(stateOf("Living Room").state, "HEALTHY");
  assert.equal(stateOf("Living Room").consecutiveFailures, 0);
  assert.deepEqual(lines, []);
  assert.deepEqual(reachabilityInfoForTests().skipped, []);
});

test("health is tracked independently per speaker", () => {
  noteSpeakerHealthSuccess(living, { now: 5_000 });
  for (let i = 1; i <= 3; i++) {
    noteSpeakerHealthFailure(office, timeout, { now: i });
  }
  assert.equal(stateOf("Office").state, "UNRESPONSIVE");
  assert.equal(stateOf("Living Room").state, "HEALTHY");
  assert.equal(stateOf("Living Room").consecutiveFailures, 0);
});

test("health logging happens only on state transitions", () => {
  const lines = logs();
  noteSpeakerHealthSuccess(office, { now: 1 });
  noteSpeakerHealthSuccess(office, { now: 2 });
  noteSpeakerHealthFailure(office, timeout, { now: 3 });
  noteSpeakerHealthFailure(office, timeout, { now: 4 });
  assert.deepEqual(lines, [
    "[Sonos Health] Office UNKNOWN -> HEALTHY",
    "[Sonos Health] Office HEALTHY -> DEGRADED: timeout",
  ]);
});

test("starting the monitor twice does not create a second timer", () => {
  const handles = [];
  const setInterval = (fn, ms) => {
    const handle = { fn, ms };
    handles.push(handle);
    return handle;
  };
  const deps = {
    listDevices: () => [],
    readDevice: async () => {},
    setInterval,
    intervalMs: SPEAKER_HEALTH_PROBE_MS,
  };
  assert.equal(startSonosSpeakerHealthMonitor(deps), true);
  assert.equal(startSonosSpeakerHealthMonitor(deps), false);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].ms, 60_000);
  assert.equal(speakerHealthMonitorArmed(), true);
});

test("a health probe cannot overlap itself", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const device = {
    ...office,
    AVTransportService: {
      GetTransportInfo() {
        reads += 1;
        return gate;
      },
    },
  };
  const deps = {
    listDevices: () => [device],
    readDevice: (speaker) => speaker.AVTransportService.GetTransportInfo(),
    isCommunicationFailure: () => false,
  };
  const first = runSonosSpeakerHealthProbe(deps);
  const second = await runSonosSpeakerHealthProbe(deps);
  assert.deepEqual(second, { skipped: "overlap" });
  assert.equal(reads, 1);
  release();
  const done = await first;
  assert.equal(done.skipped, false);
  assert.equal(done.probed, 1);
});

test("a recent Sonos signal skips the probe, and a non-communication error is ignored", async () => {
  noteSpeakerHealthSuccess(office, { now: 10_000 });
  let reads = 0;
  const device = {
    ...office,
    AVTransportService: {
      GetTransportInfo() {
        reads += 1;
        return Promise.reject(Object.assign(new Error("UPnP 800"), { statusCode: 800 }));
      },
    },
  };
  const skipped = await runSonosSpeakerHealthProbe({
    now: () => 10_000 + SPEAKER_HEALTH_RECENT_SIGNAL_MS - 1,
    listDevices: () => [device],
    readDevice: (speaker) => speaker.AVTransportService.GetTransportInfo(),
    isCommunicationFailure: (err) => err?.code === "ETIMEDOUT",
  });
  assert.equal(reads, 0);
  assert.equal(skipped.recent, 1);
  assert.equal(stateOf("Office").state, "HEALTHY");

  const probed = await runSonosSpeakerHealthProbe({
    now: () => 10_000 + SPEAKER_HEALTH_RECENT_SIGNAL_MS,
    listDevices: () => [device],
    readDevice: (speaker) => speaker.AVTransportService.GetTransportInfo(),
    isCommunicationFailure: (err) => err?.code === "ETIMEDOUT",
  });
  assert.equal(reads, 1);
  assert.equal(probed.probed, 1);
  assert.equal(stateOf("Office").state, "HEALTHY");
  assert.equal(stateOf("Office").consecutiveFailures, 0);
});

test("shutdown clears the health-monitor timer", () => {
  let cleared = null;
  const handle = {};
  startSonosSpeakerHealthMonitor({
    listDevices: () => [],
    readDevice: async () => {},
    setInterval: () => handle,
  });
  assert.equal(speakerHealthMonitorArmed(), true);
  stopSonosSpeakerHealthMonitor((id) => {
    cleared = id;
  });
  assert.equal(cleared, handle);
  assert.equal(speakerHealthMonitorArmed(), false);
});

test("listing managed speakers does not start Sonos discovery", () => {
  const before = hasReadySonosManager();
  const devices = listManagedSonosDevices();
  assert.equal(hasReadySonosManager(), before);
  assert.ok(Array.isArray(devices));
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeviceEnvironmentRequest,
  fetchDeviceEnvironment,
  mergeTemporalEnvironment,
} from "../src/continuity/device-environment.js";

const baseField = {
  windowStart: "2026-08-17T23:00:00+10:00",
  windowEnd: "2026-08-18T20:00:00+10:00",
  now: "2026-08-18T09:08:00+10:00",
  autonomyWindows: [{ id: "overnight", start: "2026-08-17T23:10:00+10:00", end: "2026-08-18T07:05:00+10:00", mode: "unattended" }],
};

const position = {
  coords: {
    latitude: -33.91,
    longitude: 151.22,
    accuracy: 14.7,
  },
};

test("device request carries coordinates transiently but temporal output does not inherit them", () => {
  const request = buildDeviceEnvironmentRequest(position, baseField, new Date("2026-08-18T00:00:00Z"));
  assert.equal(request.location.latitude, -33.91);
  assert.equal(request.location.longitude, 151.22);
  assert.equal(request.location.accuracyMeters, 15);
  assert.equal(request.window.start, baseField.windowStart);

  const merged = mergeTemporalEnvironment(baseField, {
    windowStart: baseField.windowStart,
    windowEnd: baseField.windowEnd,
    now: "2026-08-18T00:00:00Z",
    sunrise: "2026-08-17T20:30:00Z",
    sunset: "2026-08-18T07:30:00Z",
    weather: { summary: "Clear", cloudCover: 2 },
  });
  assert.equal("location" in merged, false);
  assert.deepEqual(merged.autonomyWindows, baseField.autonomyWindows);
});

test("environment lookup happens only after explicit function invocation and discards coordinates from result", async () => {
  let geolocationCalls = 0;
  let postedBody = null;
  const geolocation = {
    getCurrentPosition(resolve) {
      geolocationCalls += 1;
      resolve(position);
    },
  };
  const fetchImpl = async (_url, options) => {
    postedBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          temporalField: {
            windowStart: baseField.windowStart,
            windowEnd: baseField.windowEnd,
            now: "2026-08-18T00:01:00Z",
            sunrise: "2026-08-17T20:28:00Z",
            sunset: "2026-08-18T07:27:00Z",
            timezone: "Australia/Sydney",
            locationLabel: "Device location",
            weather: { summary: "Partly cloudy", cloudCover: 34 },
            source: { kind: "device_runtime", provider: "test" },
          },
        };
      },
    };
  };

  assert.equal(geolocationCalls, 0);
  const result = await fetchDeviceEnvironment({
    endpoint: "https://environment.example.test/lookup",
    baseField,
    geolocation,
    fetchImpl,
    now: new Date("2026-08-18T00:01:00Z"),
  });
  assert.equal(geolocationCalls, 1);
  assert.equal(postedBody.location.latitude, -33.91);
  assert.equal(result.field.location, undefined);
  assert.equal(result.field.weather.summary, "Partly cloudy");
  assert.deepEqual(result.field.autonomyWindows, baseField.autonomyWindows);
});

test("invalid provider response fails instead of replacing a valid field with plausible-looking junk", async () => {
  await assert.rejects(
    fetchDeviceEnvironment({
      endpoint: "https://environment.example.test/lookup",
      baseField,
      geolocation: { getCurrentPosition: (resolve) => resolve(position) },
      fetchImpl: async () => ({ ok: true, json: async () => ({ weather: { summary: "Clear" } }) }),
    }),
    /invalid temporal field/,
  );
});

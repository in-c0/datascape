const DEFAULT_POSITION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 12_000,
  maximumAge: 5 * 60_000,
};

export const DEVICE_ENVIRONMENT_CACHE_KEY = "datascape:continuity:device-environment:v1";

export function buildDeviceEnvironmentRequest(position, baseField, now = new Date()) {
  const coords = position?.coords;
  if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
    throw new Error("Device geolocation did not return valid coordinates");
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  return {
    location: {
      latitude: coords.latitude,
      longitude: coords.longitude,
      ...(Number.isFinite(coords.accuracy) ? { accuracyMeters: Math.round(coords.accuracy) } : {}),
    },
    timezone,
    now: now.toISOString(),
    window: {
      start: baseField?.windowStart || null,
      end: baseField?.windowEnd || null,
    },
  };
}

export function mergeTemporalEnvironment(baseField, runtimeField) {
  if (!runtimeField) return baseField || null;
  const base = baseField || {};
  return {
    ...base,
    ...runtimeField,
    weather: {
      ...(base.weather || {}),
      ...(runtimeField.weather || {}),
    },
    // Scheduler/run metadata remains authoritative locally. A weather provider
    // may return autonomy windows only if it explicitly owns them.
    autonomyWindows: runtimeField.autonomyWindows || base.autonomyWindows || [],
    source: {
      ...(base.source || {}),
      ...(runtimeField.source || {}),
      kind: runtimeField.source?.kind || "device_runtime",
    },
  };
}

export function requestDevicePosition(geolocation = globalThis.navigator?.geolocation) {
  if (!geolocation?.getCurrentPosition) {
    return Promise.reject(new Error("Device geolocation is unavailable in this browser"));
  }
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(resolve, (error) => {
      const message = error?.message || "Location permission was denied or the device could not determine its location";
      reject(new Error(message));
    }, DEFAULT_POSITION_OPTIONS);
  });
}

export async function fetchDeviceEnvironment({
  endpoint,
  baseField,
  geolocation = globalThis.navigator?.geolocation,
  fetchImpl = globalThis.fetch,
  now = new Date(),
}) {
  if (!endpoint) throw new Error("No Continuity environment provider is configured");
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this browser");

  // Geolocation is requested only when this function is explicitly invoked by
  // an operator action. Datascape never requests device position at boot.
  const position = await requestDevicePosition(geolocation);
  const request = buildDeviceEnvironmentRequest(position, baseField, now);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    cache: "no-store",
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Environment provider returned ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
  const body = await response.json();
  const runtimeField = body?.temporalField || body;
  if (!runtimeField?.now || !runtimeField?.windowStart || !runtimeField?.windowEnd) {
    throw new Error("Environment provider returned an invalid temporal field");
  }

  return {
    field: mergeTemporalEnvironment(baseField, runtimeField),
    // Coordinates are intentionally not returned to callers, cached, or added
    // to the runtime field. The provider sees them transiently for lookup only.
    accuracyMeters: request.location.accuracyMeters ?? null,
  };
}

export function readCachedDeviceEnvironment(storage = globalThis.sessionStorage) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(DEVICE_ENVIRONMENT_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached?.field || !cached?.cachedAt) return null;
    // Session cache is convenience only. Never carry yesterday's environment
    // into a new session as if it were live state.
    if (Date.now() - Date.parse(cached.cachedAt) > 30 * 60_000) return null;
    return cached.field;
  } catch {
    return null;
  }
}

export function cacheDeviceEnvironment(field, storage = globalThis.sessionStorage) {
  if (!field || !storage?.setItem) return;
  try {
    storage.setItem(DEVICE_ENVIRONMENT_CACHE_KEY, JSON.stringify({
      cachedAt: new Date().toISOString(),
      field,
    }));
  } catch {
    // A privacy-restricted browser may block storage; live rendering still works.
  }
}

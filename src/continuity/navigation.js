const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function asUrl(href) {
  return new URL(href, "http://datascape.local/");
}

export function readContinuityLocation(data, href) {
  const snapshots = data?.snapshots || [];
  const url = asUrl(href);
  const requestedTime = url.searchParams.get("t");
  const requestedConcept = url.searchParams.get("concept");
  const requestedResolution = Number(url.searchParams.get("r"));

  let timeIndex = requestedTime
    ? snapshots.findIndex((snapshot) => snapshot.id === requestedTime)
    : -1;
  if (timeIndex < 0) timeIndex = Math.max(0, snapshots.length - 1);

  const snapshot = snapshots[timeIndex];
  const selected = requestedConcept || snapshot?.dominant || "";
  const resolution = Number.isFinite(requestedResolution)
    ? clamp(requestedResolution, 0, 1)
    : 0.5;

  return { timeIndex, selected, resolution };
}

export function buildContinuityUrl(data, state, href) {
  const snapshots = data?.snapshots || [];
  const url = asUrl(href);
  const timeIndex = clamp(
    Number(state.timeIndex) || 0,
    0,
    Math.max(0, snapshots.length - 1),
  );
  const resolution = clamp(Number(state.resolution) || 0, 0, 1);

  url.searchParams.set("view", "continuity");
  if (state.selected) url.searchParams.set("concept", state.selected);
  else url.searchParams.delete("concept");

  const snapshotId = snapshots[timeIndex]?.id;
  if (snapshotId) url.searchParams.set("t", snapshotId);
  else url.searchParams.delete("t");

  url.searchParams.set("r", String(Math.round(resolution * 100) / 100));
  return url;
}

export function writeContinuityLocation(data, state, mode = "replace") {
  if (typeof window === "undefined") return;
  const url = buildContinuityUrl(data, state, window.location.href);
  const method = mode === "push" ? "pushState" : "replaceState";
  window.history[method](null, "", `${url.pathname}${url.search}${url.hash}`);
}

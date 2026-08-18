const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function temporalRange(field) {
  const start = Date.parse(field?.windowStart || "");
  const end = Date.parse(field?.windowEnd || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, span: end - start };
}

export function temporalPercent(value, field) {
  const range = temporalRange(field);
  const time = Date.parse(value || "");
  if (!range || !Number.isFinite(time)) return null;
  return clamp(((time - range.start) / range.span) * 100, 0, 100);
}

export function temporalX(value, field, minX, maxX) {
  const percent = temporalPercent(value, field);
  if (percent == null) return null;
  return minX + (maxX - minX) * (percent / 100);
}

export function temporalWindowStyle(window, field) {
  const start = temporalPercent(window?.start, field);
  const end = temporalPercent(window?.end, field);
  if (start == null || end == null) return null;
  return {
    left: `${Math.min(start, end)}%`,
    width: `${Math.max(0.75, Math.abs(end - start))}%`,
  };
}

export function temporalGradient(field) {
  const sunrise = temporalPercent(field?.sunrise, field);
  const sunset = temporalPercent(field?.sunset, field);
  if (sunrise == null && sunset == null) return null;

  const stops = [];
  const add = (position, color) => {
    if (position == null) return;
    stops.push([clamp(position, 0, 100), color]);
  };

  add(0, "#050914");
  if (sunrise != null) {
    add(sunrise - 9, "#091325");
    add(sunrise - 3, "#28344b");
    add(sunrise + 1, "#765c54");
    add(sunrise + 7, "#223a58");
    add(sunrise + 18, "#102a43");
  }
  if (sunset != null) {
    add(sunset - 15, "#17314b");
    add(sunset - 4, "#65454e");
    add(sunset + 2, "#2d2238");
    add(sunset + 9, "#090f20");
  }
  add(100, "#050914");

  stops.sort((a, b) => a[0] - b[0]);
  return `linear-gradient(90deg, ${stops.map(([position, color]) => `${color} ${position.toFixed(2)}%`).join(", ")})`;
}

export function formatLocalClock(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timeZone || undefined,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
}

export function executionLabel(concept) {
  const state = concept?.executionState;
  if (state === "running") return "Running now";
  if (state === "completed") return "Already run";
  if (state === "planned") return "Planned";
  return null;
}

export function supervisionLabel(concept) {
  if (concept?.supervision === "unattended") return concept?.scheduled ? "Scheduled · unattended" : "Unattended";
  if (concept?.supervision === "attended") return "Human-present";
  return null;
}

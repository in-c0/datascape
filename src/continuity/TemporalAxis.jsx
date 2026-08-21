import { useMemo } from "react";
import { envelopeGeometry, temporalPhase, timeScale } from "./briefing.js";

// The temporal axis — spec v2.1, P0.
//
// v2 encoded time as metadata on ordinary nodes, and the review was blunt about
// the result: rounded rectangles around lane labels read as "cards for
// autonomous sessions", which the spec had explicitly rejected, and the
// environment field was so subtle it was absent.
//
// Here time is SPATIAL. An autonomy envelope's width IS its elapsed duration on
// a shared scale, NOW is a position rather than a word, and the phase of day is
// a continuous field behind everything. That is what makes execution state
// readable in a still frame:
//
//   completed run  →  terminates to the LEFT of NOW
//   live run       →  intersects NOW, and has no ended_at
//
// so no LIVE/COMPLETED badge is needed, and no semantic colour is spent on it.

const PHASE_COLOUR = {
  night: "rgba(18, 20, 48, 0.92)",
  "pre-dawn": "rgba(40, 36, 78, 0.85)",
  sunrise: "rgba(104, 62, 74, 0.72)",
  daytime: "rgba(56, 84, 122, 0.55)",
  afternoon: "rgba(64, 88, 124, 0.5)",
  evening: "rgba(74, 52, 96, 0.7)",
};

/**
 * A continuous low-frequency field: one colour stop per sampled hour, so night
 * → pre-dawn → sunrise → morning reads as a gradient rather than as hard bands.
 * "Subtle cannot mean absent" — these are deliberately more separated in
 * luminance than the v2 field, which was invisible at screenshot size.
 */
function phaseGradient(scale, samples = 28) {
  const stops = [];
  for (let i = 0; i <= samples; i++) {
    const t = scale.from + ((scale.to - scale.from) * i) / samples;
    const phase = temporalPhase(new Date(t));
    stops.push(`${PHASE_COLOUR[phase] || PHASE_COLOUR.night} ${((i / samples) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

const hhmm = (t) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(t));

export default function TemporalAxis({ timeline, width = 1000, height = 96, onSelectRun }) {
  const scale = useMemo(
    () => timeScale({ from: timeline.from, to: timeline.to, width }),
    [timeline.from, timeline.to, width],
  );

  const gradient = useMemo(() => phaseGradient(scale), [scale]);
  const nowX = scale.x(new Date(timeline.now));

  // A handful of hour marks, never a ruler.
  const ticks = useMemo(() => {
    const out = [];
    const start = new Date(scale.from);
    start.setMinutes(0, 0, 0);
    const stepMs = Math.max(3600 * 1000, Math.round(scale.spanMs / 6 / 3600000) * 3600000);
    for (let t = start.getTime(); t <= scale.to; t += stepMs) {
      if (t < scale.from) continue;
      out.push({ t, x: scale.x(new Date(t)) });
    }
    return out;
  }, [scale]);

  const lanes = useMemo(() => {
    // Stack overlapping envelopes so two concurrent runs stay legible without
    // fanning out into one row per session.
    const rows = [];
    const placed = [];
    for (const run of timeline.runs || []) {
      const geo = envelopeGeometry(run, scale, timeline.now);
      if (!geo) continue;
      let row = 0;
      while (placed.some((p) => p.row === row && !(geo.x2 < p.x1 - 6 || geo.x1 > p.x2 + 6))) row += 1;
      placed.push({ row, x1: geo.x1, x2: geo.x2 });
      rows.push({ run, geo, row });
    }
    return rows;
  }, [timeline.runs, scale, timeline.now]);

  const rowCount = Math.max(1, ...lanes.map((l) => l.row + 1));
  const rowHeight = 20;
  const bandHeight = Math.max(height, 44 + rowCount * rowHeight);

  return (
    <div className="bf-axis" style={{ height: bandHeight }} aria-label="Temporal field">
      <div className="bf-axis__field" style={{ background: gradient }} />

      {ticks.map(({ t, x }) => (
        <div key={t} className="bf-axis__tick" style={{ left: x }}>
          <span>{hhmm(t)}</span>
        </div>
      ))}

      {lanes.map(({ run, geo, row }) => (
        <button
          key={run.id}
          type="button"
          className={`bf-envelope${geo.live ? " bf-envelope--live" : ""}`}
          style={{ left: geo.x1, width: geo.width, top: 26 + row * rowHeight }}
          onClick={() => onSelectRun?.(run)}
          title={`${run.laneLabel} · unattended · ${hhmm(Date.parse(run.startedAt))}–${geo.live ? "now" : hhmm(Date.parse(run.endedAt))}`}
        >
          <span className="bf-envelope__label">
            {hhmm(Date.parse(run.startedAt))}–{geo.live ? "now" : hhmm(Date.parse(run.endedAt))}
          </span>
        </button>
      ))}

      {/* NOW is a position. Stronger than the field, weaker than a selection. */}
      <div className="bf-axis__now" style={{ left: nowX }}>
        <span>now</span>
      </div>
    </div>
  );
}

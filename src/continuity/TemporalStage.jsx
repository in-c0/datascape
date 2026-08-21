import { useMemo } from "react";
import { envelopeGeometry, temporalPhase, timeScale } from "./briefing.js";

// The stage IS the temporal field — spec v2.2.
//
// v2.1 put time in a strip above the graph, and the review named the result
// exactly: "not a graph plus a timeline; not a timeline plus a graph; one
// semantic space whose horizontal dimension happens to be lived time." The
// strip was a mini-Gantt, which the spec had rejected twice.
//
// So there is no panel here. This component paints the whole stage:
//
//   x = when          (from the shared temporal scale)
//   y = semantic topology  (owned by the layout, not by time)
//
// Autonomy envelopes are faint regions BEHIND the nodes generated during that
// run — no card chrome, no border, not semantic nodes. NOW is a cursor that
// crosses the entire stage, so a live branch literally intersects it.
//
// A record whose provenance is untrustworthy gets NO temporal position: it sits
// in an explicitly non-temporal margin rather than being assigned a fake time.

const PHASE_COLOUR = {
  night: "rgba(14, 16, 42, 1)",
  "pre-dawn": "rgba(38, 34, 74, 1)",
  sunrise: "rgba(96, 58, 70, 1)",
  daytime: "rgba(48, 74, 110, 1)",
  afternoon: "rgba(54, 76, 112, 1)",
  evening: "rgba(64, 46, 86, 1)",
};

/** Continuous low-frequency field. Ambient, unbordered, no container. */
function phaseGradient(scale, samples = 32) {
  const stops = [];
  for (let i = 0; i <= samples; i++) {
    const t = scale.from + ((scale.to - scale.from) * i) / samples;
    stops.push(`${PHASE_COLOUR[temporalPhase(new Date(t))] || PHASE_COLOUR.night} ${((i / samples) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

const hhmm = (t) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(t));

export const MARGIN_X = 200;  // where the temporal stage begins
export const STAGE_RIGHT = 1310;

export default function TemporalStage({ timeline, children, rows = [], width = 1536 }) {
  const scale = useMemo(
    () => timeScale({ from: timeline.from, to: timeline.to, width: STAGE_RIGHT - MARGIN_X }),
    [timeline.from, timeline.to],
  );
  const gradient = useMemo(() => phaseGradient(scale), [scale]);
  const atX = (value) => {
    const x = scale.x(value);
    return x == null ? null : MARGIN_X + x;
  };
  // NOW is only drawn when it is genuinely inside this window. A zoomed lane
  // whose run ended hours ago would otherwise clamp the cursor to the right
  // edge and assert a present moment that is not on this scale.
  const nowMs = new Date(timeline.now).getTime();
  const nowInWindow = nowMs >= scale.from && nowMs <= scale.to;
  const nowX = nowInWindow ? atX(new Date(timeline.now)) : null;

  // Sparse, extremely low emphasis, at the upper edge only.
  const ticks = useMemo(() => {
    const out = [];
    const start = new Date(scale.from);
    start.setMinutes(0, 0, 0);
    // At most five anchors: more than that and the field becomes an axis again.
    const step = Math.max(3600 * 1000, Math.ceil(scale.spanMs / 5 / 3600000) * 3600000);
    for (let t = start.getTime(); t <= scale.to; t += step) {
      if (t < scale.from) continue;
      out.push({ t, x: atX(new Date(t)) });
    }
    return out;
  }, [scale]);

  const envelopes = useMemo(() => {
    const out = [];
    for (const run of timeline.runs || []) {
      const geo = envelopeGeometry(run, scale, timeline.now);
      if (!geo) continue;
      // Vertically, an envelope covers the band occupied by the nodes it
      // produced — so a node's centre genuinely lies inside its own run.
      // v2.3 P0: an envelope may not exist without a visible semantic referent.
      // A run whose material outcome is hidden at this abstraction stays hidden
      // WITH it — an empty 02:50-04:36 region beside three unrelated nodes is
      // exactly what pushes the surface back toward a Gantt reading.
      //
      // Association is by run id, not by lane: a lane with four runs and one
      // visible outcome gets ONE envelope, around that outcome.
      const owned = rows.filter((r) => r.temporal && r.runId && r.runId === run.id);
      if (!owned.length) continue;
      const top = Math.min(...owned.map((r) => r.y)) - 30;
      const bottom = Math.max(...owned.map((r) => r.y)) + 30;
      out.push({ run, geo, top, height: Math.max(60, bottom - top) });
    }
    return out;
  }, [timeline.runs, scale, timeline.now, rows]);

  return (
    <div className="bf-field">
      {/* The wash is its own layer so nodes can sit above it and so the mobile
          breakpoint can replace a compressed 9-hour horizontal gradient with a
          vertical one. Painting it on the container put it over the labels. */}
      <div className="bf-field__wash" style={{ background: gradient }} />
      {ticks.map(({ t, x }) => (
        <span key={t} className="bf-field__hour" style={{ left: x }}>{hhmm(t)}</span>
      ))}

      {envelopes.map(({ run, geo, top, height }) => (
        <div
          key={run.id}
          className={`bf-env${geo.live ? " bf-env--live" : ""}`}
          style={{ left: MARGIN_X + geo.x1, width: geo.width, top, height }}
        >
          {/* The wash carries the mask; the label must sit outside it, or the
              feathering clips the label along with the region and the envelope
              loses its only text. */}
          <span className="bf-env__wash" />
          {/* Subordinate: the interval only. Supervision is already on the
              node, and repeating "unattended" once per run turned four faint
              regions into four labels competing with the outcomes. A run too
              narrow to hold its own interval carries none. */}
          {geo.width >= 44 && (
            <span className="bf-env__label">
              {hhmm(Date.parse(run.startedAt))}–{geo.live ? "now" : hhmm(Date.parse(run.endedAt))}
            </span>
          )}
        </div>
      ))}

      {/* Mobile only: the vertical field has no direction of its own, so the
          operator cannot tell which way time runs. Two or three anchors on the
          right edge, top = older, bottom = now. Deliberately not a miniature
          timeline — no ticks, no bars, no scale. */}
      <div className="bf-field__orient" aria-hidden="true">
        <span>{hhmm(scale.from)}</span>
        <i />
        <span>{hhmm(scale.from + scale.spanMs / 2)}</span>
        <i />
        {/* In a rewound scene the mobile cue must never say "now": the manifest
            said historical while the field said otherwise, and the UI
            contradicting its own state is worse than having no cue. */}
        <span className="bf-field__orient-now">
          {timeline.label === "as of" ? `as of ${hhmm(scale.to)}` : (nowInWindow ? "now" : hhmm(scale.to))}
        </span>
      </div>

      {/* NOW crosses the whole stage; a live branch intersects it. */}
      {/* One strong structural cursor, never two. While rewound this reads AS
          OF rather than NOW, and the reconstructed world simply ends here. */}
      {nowX != null && (
        <div className={`bf-now${timeline.label === "as of" ? " bf-now--asof" : ""}`} style={{ left: nowX }}>
          <span>{timeline.label || "now"}</span>
        </div>
      )}

      {children}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ATTENTION_BUDGET,
  childrenOf,
  conceptRoots,
  decompose,
  hiddenWeight,
  inspectProvenance,
  isAuthoredSource,
  isProjection,
  projectionAnchor,
  projectionExecution,
} from "./altitude.js";
import { timeScale } from "./briefing.js";
import TemporalStage, { MARGIN_X, STAGE_RIGHT } from "./TemporalStage.jsx";
import { FIXTURE_CLOCK, buildProjectionGraph, buildRuns } from "./fixtures/v3-projection.js";

// The semantic-zoom vertical slice — spec v3.1 §8-§12, §15.
//
// Two operations that must never collapse into one:
//
//   click / Enter  = select + recenter, at the SAME altitude
//   + / -          = change the semantic resolution of the selected concept
//
// And one thing v3 explicitly froze: the v2.3 temporal grammar SURVIVES
// semantic zoom. Changing altitude changes resolution; it does not switch the
// temporal system off. So every concept with a trustworthy material transition
// sits at that time on the same shared scale the field, NOW and the autonomy
// envelopes already use — x = when, y = semantic topology, at every altitude.

const TRANSITION_MS = 260;   // inside the spec's 220-300ms window
const ROW = 92;
const TOP = 108;

function sceneFor(graph, lens) {
  if (!lens.length) return conceptRoots(graph).slice(0, ATTENTION_BUDGET);
  return decompose(graph, lens[lens.length - 1]) || [];
}

/**
 * Deep breadcrumbs compress rather than truncate (§P1).
 *
 * Six aggressively-clipped labels across one line record a NAVIGATION; they do
 * not remind the operator what question they are answering. The root and the
 * last two ancestors stay readable and the middle collapses into one clickable
 * span.
 */
function compressLens(lens, byId, expanded) {
  if (expanded || lens.length <= 3) return lens.map((id) => ({ kind: "crumb", id }));
  return [
    { kind: "crumb", id: lens[0] },
    { kind: "collapsed", count: lens.length - 3 },
    { kind: "crumb", id: lens[lens.length - 2] },
    { kind: "crumb", id: lens[lens.length - 1] },
  ];
}

export default function SemanticStage({ initialLens = [], initialCentre = null, onStateChange }) {
  const graph = useMemo(() => buildProjectionGraph(), []);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const runs = useMemo(() => buildRuns(), []);
  const now = useMemo(() => Date.parse(FIXTURE_CLOCK.now), []);

  const [lens, setLens] = useState(initialLens);
  const [centre, setCentre] = useState(initialCentre);
  // A transition is first-class state: the mid-flight frame is the evidence,
  // and it has to show children coming OUT of the parent's own position.
  const [motion, setMotion] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [lensOpen, setLensOpen] = useState(false);
  const timer = useRef(null);
  const positions = useRef(new Map());

  const visible = useMemo(() => sceneFor(graph, lens), [graph, lens]);
  const centreId = centre && visible.some((n) => n.id === centre) ? centre : visible[0]?.id || null;
  const centreNode = centreId ? byId.get(centreId) : null;
  const parentNode = lens.length ? byId.get(lens[lens.length - 1]) : null;

  const timeline = useMemo(() => ({
    from: FIXTURE_CLOCK.since,
    to: FIXTURE_CLOCK.now,
    now,
    runs: runs.filter((r) => r.supervision === "unattended"),
  }), [now, runs]);

  const scale = useMemo(
    () => timeScale({ from: timeline.from, to: timeline.to, width: STAGE_RIGHT - MARGIN_X }),
    [timeline.from, timeline.to],
  );

  // x = when, y = semantic topology. A concept whose provenance gives no
  // trustworthy moment stays in the non-temporal margin rather than being
  // assigned a fake one.
  const rows = useMemo(() => visible.map((node, index) => {
    const at = isAuthoredSource(node) ? node.at : projectionAnchor(graph, node.id, now);
    const x = at ? scale.x(at) : null;
    const sessions = node.sessionIds || (node.session ? [node.session] : []);
    return {
      key: node.id,
      node,
      laneKey: node.id,
      // An envelope only where ONE unattended run contributes: a concept
      // standing on four sessions has no single interval to draw.
      runId: sessions.length === 1 ? `run_${sessions[0]}` : null,
      x: x == null ? 28 : MARGIN_X + x,
      y: TOP + index * ROW,
      temporal: x != null,
      // Within ~380px of the right edge there is no room for a label, and a
      // live concept always lands there because it sits on NOW.
      flip: x != null && MARGIN_X + x > STAGE_RIGHT - 160,
      live: isProjection(node) && projectionExecution(graph, node.id) === "live",
    };
  }), [visible, graph, now, scale]);

  useEffect(() => {
    for (const row of rows) positions.current.set(row.key, { x: row.x, y: row.y });
  }, [rows]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = useCallback((next) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMotion(null), TRANSITION_MS);
    setMotion(next);
  }, []);

  const zoomIn = useCallback(() => {
    if (!centreNode) return false;
    const kids = decompose(graph, centreNode.id);
    // At a semantic atom there is nothing below. Stopping is correct;
    // silently doing nothing is not.
    if (!kids || !kids.length) return false;
    settle({
      kind: "decompose",
      from: centreNode.id,
      to: kids.map((k) => k.id),
      // The parent's OWN settled position is the origin. Children must appear
      // to come out of where the parent actually was, not from a layout edge.
      origin: positions.current.get(centreNode.id) || null,
    });
    setLens((l) => [...l, centreNode.id]);
    setCentre(kids[0].id);
    setInspecting(false);
    return true;
  }, [centreNode, graph, settle]);

  const zoomOut = useCallback(() => {
    if (!lens.length) return false;
    const parent = lens[lens.length - 1];
    settle({ kind: "recompose", from: visible.map((n) => n.id), to: [parent], origin: null });
    setLens((l) => l.slice(0, -1));
    setCentre(parent);
    setInspecting(false);
    return true;
  }, [lens, visible, settle]);

  const select = useCallback((id) => { setCentre(id); setInspecting(false); }, []);

  const state = useMemo(() => ({
    semanticAltitude: lens.length,
    semanticCentre: centreId,
    lensPath: [...lens],
    visibleConceptIds: visible.map((n) => n.id),
    visibleConceptCount: visible.length,
    transition: motion ? motion.kind : "settled",
    atSource: Boolean(centreNode && isAuthoredSource(centreNode)),
  }), [lens, centreId, visible, motion, centreNode]);

  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);

  useEffect(() => {
    // A harness hook, not product chrome: it drives the same functions the
    // keyboard and buttons do, so a captured sequence exercises real code.
    window.__continuity = {
      state: () => state,
      geometry: () => rows.map((r) => ({ id: r.key, x: r.x, y: r.y, temporal: r.temporal })),
      motion: () => motion,
      select,
      plus: zoomIn,
      minus: zoomOut,
      inspect: (on = true) => setInspecting(on),
      transitionMs: TRANSITION_MS,
    };
    return () => { delete window.__continuity; };
  }, [state, rows, motion, select, zoomIn, zoomOut]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomIn(); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomOut(); }
      else if (event.key === "Escape") zoomOut();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut]);

  const emerging = motion?.kind === "decompose";
  const origin = emerging ? motion.origin : null;
  const stageHeight = Math.max(360, TOP + visible.length * ROW + 40);
  const crumbs = compressLens(lens, byId, lensOpen);

  return (
    <div
      className={`sem${motion ? ` sem--${motion.kind}` : ""}`}
      style={{ "--sem-ms": `${TRANSITION_MS}ms` }}
    >
      <nav className="sem__lens" aria-label="Semantic lens">
        <button type="button" className="sem__crumb" onClick={() => { setLens([]); setCentre(null); }}>
          Catch-up
        </button>
        {crumbs.map((crumb, index) => (
          <span key={crumb.kind === "collapsed" ? `collapsed-${index}` : crumb.id}>
            <i>›</i>
            {crumb.kind === "collapsed" ? (
              <button
                type="button"
                className="sem__crumb sem__crumb--collapsed"
                onClick={() => setLensOpen(true)}
              >
                … {crumb.count} levels …
              </button>
            ) : (
              <button
                type="button"
                className="sem__crumb"
                onClick={() => {
                  const at = lens.indexOf(crumb.id);
                  setLens(lens.slice(0, at));
                  setCentre(crumb.id);
                }}
              >
                {byId.get(crumb.id)?.label}
              </button>
            )}
          </span>
        ))}
      </nav>

      {/* The frozen v2.3 field, beneath the projection aperture. Altitude
          changes resolution; it does not turn time off. */}
      <section className="sem__stage" style={{ minHeight: stageHeight }}>
        <TemporalStage timeline={timeline} rows={rows} />

        {/* Connectors exist only during motion: at 50% each child is joined to
            the parent region it came out of, which is what makes the frame say
            "these were inside that" rather than "a new page arrived". */}
        {emerging && origin && (
          <svg className="sem__rays" aria-hidden="true">
            {rows.map((row) => (
              <line
                key={row.key}
                x1={origin.x} y1={origin.y}
                x2={row.x} y2={row.y}
                className="sem__ray"
              />
            ))}
          </svg>
        )}

        {/* The parent holds its own settled position through the transition
            instead of jumping to the breadcrumb early. */}
        {emerging && origin && parentNode && (
          <div
            className={`sem__origin${origin.x > STAGE_RIGHT - 160 ? " sem__origin--flip" : ""}`}
            style={{ left: origin.x, top: origin.y }}
          >
            <span className="sem__origin-ring" aria-hidden="true" />
            <span className="sem__origin-label">{parentNode.label}</span>
          </div>
        )}

        <ul className="sem__concepts">
          {rows.map((row, index) => {
            const node = row.node;
            const source = isAuthoredSource(node);
            const from = emerging && origin ? origin : null;
            return (
              <li
                key={row.key}
                className={
                  "sem__concept"
                  + (row.key === centreId ? " sem__concept--centre" : "")
                  + (row.live ? " sem__concept--live" : "")
                  + (source ? " sem__concept--source" : "")
                  + (row.temporal ? "" : " sem__concept--atemporal")
                  + (row.flip ? " sem__concept--flip" : "")
                  + (emerging ? " sem__concept--emerging" : "")
                }
                style={{
                  left: row.x,
                  top: row.y,
                  "--i": index,
                  // Each child animates FROM the parent's position to its own.
                  "--dx": from ? `${from.x - row.x}px` : "0px",
                  "--dy": from ? `${from.y - row.y}px` : "0px",
                }}
              >
                <button type="button" className="sem__hit" onClick={() => select(row.key)}>
                  <span className="sem__ring" aria-hidden="true"><i /></span>
                  <span className="sem__text">
                    <span className="sem__label">{node.label}</span>
                    {source && <span className="sem__kicker">Exact source</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {inspecting && centreNode && (
        <aside className="sem__inspect">
          {isAuthoredSource(centreNode) ? (
            <>
              <h2>Exact source</h2>
              <p className="sem__verbatim">{centreNode.text}</p>
              <dl><dt>Session</dt><dd>{centreNode.session}</dd><dt>Lane</dt><dd>{centreNode.lane}</dd></dl>
            </>
          ) : (
            (() => {
              const p = inspectProvenance(graph, centreNode.id);
              const weight = hiddenWeight(graph, centreNode.id);
              return (
                <>
                  <h2>Synthesised projection</h2>
                  <p className="sem__verbatim">{centreNode.label}</p>
                  <dl>
                    <dt>Direct constituents</dt><dd>{p.directConcepts}</dd>
                    <dt>Underlying source observations</dt><dd>{weight.records}</dd>
                    <dt>Revision</dt><dd>{p.revision}</dd>
                    <dt>Last material revision</dt><dd>{p.lastMaterialRevisionAt}</dd>
                    <dt>Relationships</dt>
                    <dd>{p.relationships.length ? p.relationships.map((r) => r.kind).join(", ") : "contains"}</dd>
                  </dl>
                </>
              );
            })()
          )}
        </aside>
      )}

      <footer className="sem__controls">
        <button type="button" onClick={zoomOut} disabled={!lens.length} aria-label="Recompose">−</button>
        <span>less</span>
        <span className="sem__dots" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => <i key={i} className={i <= lens.length ? "on" : ""} />)}
        </span>
        <span>more detail</span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={!centreNode || !childrenOf(graph, centreNode.id).length}
          aria-label="Decompose"
        >
          +
        </button>
        <button type="button" className="sem__inspect-btn" onClick={() => setInspecting((v) => !v)}>
          {inspecting ? "Hide provenance" : "Why am I seeing this?"}
        </button>
      </footer>
    </div>
  );
}

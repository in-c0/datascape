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
import { buildHistoryWorld, buildV4Graph, revisionTimeline } from "./fixtures/v4-graph.js";
import { affordances, semanticDiff, semanticScene } from "./history/asof.js";
import { workingOverlay } from "./history/revision.js";

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

export default function SemanticStage({ initialLens = [], initialCentre = null, initialAsOf = null, onStateChange }) {
  // History is a THIRD axis (V4 §1): selection is what, altitude is how
  // abstract, and this is when. It is deliberately not another altitude, so
  // zooming out never means "older".
  const world = useMemo(() => buildHistoryWorld(), []);
  const [asOf, setAsOf] = useState(initialAsOf);
  const [diffOpen, setDiffOpen] = useState(false);

  const graph = useMemo(() => buildV4Graph(world, asOf), [world, asOf]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const runs = useMemo(() => buildRuns(), []);
  const now = useMemo(() => Date.parse(FIXTURE_CLOCK.now), []);
  const historical = asOf != null;
  const scene = useMemo(() => semanticScene(world, asOf), [world, asOf]);
  const can = useMemo(() => affordances(scene), [scene]);

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

  // While rewound the field IS the reconstructed temporal world, not a
  // translucent layer over the present: the cursor becomes AS OF and nothing
  // to the right of it carries semantic future state (§12).
  const cursorAt = historical ? Date.parse(asOf) : now;
  const timeline = useMemo(() => ({
    from: FIXTURE_CLOCK.since,
    to: new Date(cursorAt).toISOString(),
    now: cursorAt,
    label: historical ? "as of" : "now",
    runs: runs.filter((r) => r.supervision === "unattended"
      && Date.parse(r.startedAt) <= cursorAt),
  }), [cursorAt, historical, runs]);

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

  // Revision context for whichever concept is focal. `↶ history` appears only
  // when meaningful prior material revisions exist.
  // History belongs to whichever ancestor OWNS revisions, not to whatever is
  // focal. Keying off the centre meant that once the operator zoomed into a
  // descendant, `next revision` silently did nothing — the manifest caught it:
  // two frames named rev1-to-rev2 both stayed at rev 1's as-of position.
  const owningId = useMemo(() => {
    for (const id of [centreId, ...[...lens].reverse()]) {
      if (id && revisionTimeline(world, id).length > 1) return id;
    }
    return null;
  }, [centreId, lens, world]);

  const revisions = useMemo(
    () => (owningId ? revisionTimeline(world, owningId) : []),
    [world, owningId],
  );
  const currentRevision = useMemo(() => {
    if (!revisions.length) return null;
    const cut = historical ? Date.parse(asOf) : Infinity;
    let found = null;
    for (const r of revisions) if (Date.parse(r.effective_at) <= cut) found = r;
    return found;
  }, [revisions, historical, asOf]);
  const revIndex = currentRevision ? revisions.findIndex((r) => r.revision === currentRevision.revision) : -1;
  const hasHistory = revisions.length > 1;

  // The working overlay is evidence newer than the settled revision. It exists
  // ONLY in the live view: historical rev 3 means what rev 3 meant when it
  // settled, which is a different state from rev 3 as it stands now (§6).
  const overlay = useMemo(() => {
    if (historical || !owningId || !hasHistory) return null;
    const o = workingOverlay(world.revisions, owningId, world.sources, { now });
    return o.working_evidence_count > 0 ? o : null;
  }, [historical, owningId, hasHistory, world, now]);

  const diff = useMemo(() => {
    if (!diffOpen || !currentRevision || revIndex < 1) return null;
    return semanticDiff(world.revisions, owningId, revisions[revIndex - 1].revision, currentRevision.revision,
      { labels: Object.fromEntries(graph.nodes.map((n) => [n.id, n.label])) });
  }, [diffOpen, currentRevision, revIndex, revisions, world, owningId, graph]);

  /**
   * Reconcile the semantic referent into a reconstructed scene.
   *
   * The concept the operator is inspecting may not exist at the new revision.
   * Rather than silently doing nothing, follow the lens upward to the nearest
   * concept that does exist there — the referent degrades gracefully instead
   * of the navigation failing.
   */
  const reconcile = useCallback((nextAsOf) => {
    const next = buildV4Graph(world, nextAsOf);
    const present = new Set(next.nodes.map((n) => n.id));
    const nextLens = [];
    for (const id of lens) {
      if (!present.has(id)) break;
      nextLens.push(id);
    }
    setLens(nextLens);
    setCentre(present.has(centreId) && nextLens.length === lens.length ? centreId : null);
  }, [world, lens, centreId]);

  const goRevision = useCallback((delta) => {
    if (revIndex < 0) return false;
    const next = revisions[revIndex + delta];
    if (!next) return false;
    // Moving to the newest revision returns to the live world rather than
    // pinning an as-of at its effective time, so "current" is never a
    // historical scene that happens to be up to date.
    const nextAsOf = next.revision === revisions[revisions.length - 1].revision && delta > 0
      ? null : next.effective_at;
    setAsOf(nextAsOf);
    reconcile(nextAsOf);
    settle({ kind: "revision", from: owningId, to: [owningId], origin: positions.current.get(centreId) || null });
    setDiffOpen(false);
    return true;
  }, [revIndex, revisions, reconcile, settle, owningId, centreId]);

  const enterHistory = useCallback(() => {
    if (!hasHistory || revIndex < 1) return false;
    const nextAsOf = revisions[revIndex - 1].effective_at;
    setAsOf(nextAsOf);
    reconcile(nextAsOf);
    settle({ kind: "revision", from: owningId, to: [owningId], origin: positions.current.get(centreId) || null });
    setDiffOpen(false);
    return true;
  }, [hasHistory, revIndex, revisions, reconcile, settle, owningId, centreId]);

  const returnToNow = useCallback(() => {
    // Preserve the semantic referent. The centre and lens are untouched, so
    // the operator lands on the current state of the same idea rather than
    // being dumped at A0 (§13).
    setAsOf(null);
    setDiffOpen(false);
  }, []);

  const state = useMemo(() => ({
    semanticAltitude: lens.length,
    semanticCentre: centreId,
    lensPath: [...lens],
    visibleConceptIds: visible.map((n) => n.id),
    visibleConceptCount: visible.length,
    transition: motion ? motion.kind : "settled",
    atSource: Boolean(centreNode && isAuthoredSource(centreNode)),
    historicalPosition: asOf,
    projectionRevision: currentRevision?.revision ?? null,
    workingOverlayPresent: Boolean(overlay),
    readOnly: can.ownerActions === false,
  }), [lens, centreId, visible, motion, centreNode, asOf, currentRevision, overlay, can]);

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
      history: enterHistory,
      previousRevision: () => goRevision(-1),
      nextRevision: () => goRevision(1),
      returnToNow,
      whatChanged: (on = true) => { setDiffOpen(on); return Boolean(revIndex >= 1); },
      transitionMs: TRANSITION_MS,
    };
    return () => { delete window.__continuity; };
  }, [state, rows, motion, select, zoomIn, zoomOut, enterHistory, goRevision, returnToNow, revIndex]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomIn(); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomOut(); }
      else if (event.key === "Escape") zoomOut();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut]);

  const focalRow = rows.find((r) => r.key === centreId) || null;
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
        {/* One compact marker, near the breadcrumb, not a banner or a mode
            bar. History should read as a temporary lens state. */}
        {historical && (
          <span className="sem__asof">Historical · {new Intl.DateTimeFormat("en-GB", {
            timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
          }).format(new Date(asOf))}</span>
        )}
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

        {/* Change annotations inhabit the semantic space and fan locally from
            the concept they describe. A full-width bottom sheet was a report
            ABOUT the graph, which is the interaction Continuity is escaping. */}
        {diff?.available && focalRow && (
          <div
            className={`sem__diffaperture${focalRow.flip ? " sem__diffaperture--flip" : ""}`}
            style={focalRow.flip
              ? { right: `calc(100% - ${focalRow.x}px)`, top: focalRow.y }
              : { left: focalRow.x, top: focalRow.y }}
          >
            <span className="sem__diff-cap">rev {diff.from_revision} → rev {diff.to_revision}</span>
            {diff.changes.slice(0, 3).map((c, i) => (
              <span
                key={i}
                className="sem__change"
                style={{ "--i": i, "--n": Math.min(3, diff.changes.length) }}
              >
                {c.kind === "interpretation_revised" ? c.after : (c.concept || c.kind.replace(/_/g, " "))}
              </span>
            ))}
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
                  // A flipped node anchors its RIGHT edge to its moment, so the
                  // label extends leftward into open space. Anchoring `left`
                  // let the container's right edge decide the width, which
                  // wrapped a one-line label into five at NOW.
                  ...(row.flip
                    ? { right: `calc(100% - ${row.x}px)`, left: "auto" }
                    : { left: row.x }),
                  top: row.y,
                  "--i": index,
                  // Each child animates FROM the parent's position to its own.
                  "--dx": from ? `${from.x - row.x}px` : "0px",
                  "--dy": from ? `${from.y - row.y}px` : "0px",
                }}
              >
                <button type="button" className="sem__hit" onClick={() => select(row.key)}>
                  <span className="sem__ring" aria-hidden="true">
                    <i />
                    {/* Cognition is ongoing; the meaning has not changed. A
                        faint incomplete halo says that without a badge. */}
                    {overlay && row.key === centreId && <em className="sem__working" />}
                  </span>
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
                    {currentRevision && <><dt>Settled revision</dt><dd>{currentRevision.revision}</dd></>}
                    {overlay && <>
                      <dt>Working evidence since revision</dt><dd>{overlay.working_evidence_count}</dd>
                      <dt>Material semantic change</dt><dd>{overlay.material_semantic_change}</dd>
                    </>}
                    {historical && <><dt>State</dt><dd>Historical decision state</dd></>}
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
        {!historical && hasHistory && revIndex >= 1 && (
          <button type="button" className="sem__hist-btn" onClick={enterHistory}>↶ history</button>
        )}
        {historical && (
          <span className="sem__histnav">
            <button type="button" onClick={() => goRevision(-1)} disabled={revIndex < 1} aria-label="Previous revision">←</button>
            <button type="button" onClick={() => goRevision(1)} disabled={revIndex < 0 || revIndex >= revisions.length - 1} aria-label="Next revision">→</button>
            <button type="button" className="sem__nowbtn" onClick={returnToNow}>Return to now</button>
          </span>
        )}
        {revIndex >= 1 && (
          <button type="button" className="sem__diff-btn" onClick={() => setDiffOpen((v) => !v)}>
            {diffOpen ? "Hide changes" : "What changed?"}
          </button>
        )}
      </footer>
    </div>
  );
}

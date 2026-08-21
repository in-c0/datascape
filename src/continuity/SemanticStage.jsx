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
  projectionExecution,
} from "./altitude.js";
import { buildProjectionGraph } from "./fixtures/v3-projection.js";

// The semantic-zoom vertical slice — spec v3.1 §8-§12, §15.
//
// Two operations that must never collapse into one:
//
//   click / Enter  = select + recenter, at the SAME altitude
//   + / -          = change the semantic resolution of the selected concept
//
// A concept is decomposed, not navigated to. On +, the parent leaves the graph
// and survives as breadcrumb context, so a concept with five children still
// renders five nodes — the ceiling holds by construction rather than by
// truncation.

const TRANSITION_MS = 260;   // inside the spec's 220-300ms window

/** The visible concepts at the current lens depth. */
function sceneFor(graph, lens) {
  if (!lens.length) return conceptRoots(graph).slice(0, ATTENTION_BUDGET);
  return decompose(graph, lens[lens.length - 1]) || [];
}

export default function SemanticStage({ initialLens = [], initialCentre = null, onStateChange }) {
  const graph = useMemo(() => buildProjectionGraph(), []);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  const [lens, setLens] = useState(initialLens);
  const [centre, setCentre] = useState(initialCentre);
  // A transition is a first-class state, because the mid-flight frame is the
  // evidence: it must show a parent RESOLVING into its children rather than one
  // screen being replaced by another.
  const [motion, setMotion] = useState(null);   // {kind, from, to[], startedAt}
  const [inspecting, setInspecting] = useState(false);
  const timer = useRef(null);

  const visible = useMemo(() => sceneFor(graph, lens), [graph, lens]);
  const centreId = centre && visible.some((n) => n.id === centre) ? centre : visible[0]?.id || null;
  const centreNode = centreId ? byId.get(centreId) : null;
  const parentNode = lens.length ? byId.get(lens[lens.length - 1]) : null;

  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = useCallback((next) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMotion(null), TRANSITION_MS);
    setMotion(next);
  }, []);

  const zoomIn = useCallback(() => {
    if (!centreNode) return false;
    const kids = decompose(graph, centreNode.id);
    // At a semantic atom there is nothing below. Stopping is the correct
    // behaviour; silently doing nothing is not.
    if (!kids || !kids.length) return false;
    settle({ kind: "decompose", from: centreNode.id, to: kids.map((k) => k.id) });
    setLens((l) => [...l, centreNode.id]);
    setCentre(kids[0].id);
    setInspecting(false);
    return true;
  }, [centreNode, graph, settle]);

  const zoomOut = useCallback(() => {
    if (!lens.length) return false;
    const parent = lens[lens.length - 1];
    settle({ kind: "recompose", from: visible.map((n) => n.id), to: [parent] });
    setLens((l) => l.slice(0, -1));
    setCentre(parent);
    setInspecting(false);
    return true;
  }, [lens, visible, settle]);

  const select = useCallback((id) => {
    setCentre(id);
    setInspecting(false);
  }, []);

  // Everything the capture harness and the URL need to reconstruct this exact
  // scene. Exposed rather than scraped, so a frame's manifest is the view's own
  // account of itself rather than a guess made from pixels.
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
      select,
      plus: zoomIn,
      minus: zoomOut,
      inspect: (on = true) => setInspecting(on),
      transitionMs: TRANSITION_MS,
    };
    return () => { delete window.__continuity; };
  }, [state, select, zoomIn, zoomOut]);

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
  const converging = motion?.kind === "recompose";

  return (
    <div className={`sem${motion ? ` sem--${motion.kind}` : ""}`} style={{ "--sem-ms": `${TRANSITION_MS}ms` }}>
      {/* Ancestry lives in the breadcrumb, never as extra nodes on the stage.
          That is what keeps five children rendering as five concepts. */}
      <nav className="sem__lens" aria-label="Semantic lens">
        <button type="button" className="sem__crumb" onClick={() => { setLens([]); setCentre(null); }}>
          Catch-up
        </button>
        {lens.map((id, index) => (
          <span key={id}>
            <i>›</i>
            <button
              type="button"
              className="sem__crumb"
              onClick={() => { setLens(lens.slice(0, index)); setCentre(id); }}
            >
              {byId.get(id)?.label}
            </button>
          </span>
        ))}
      </nav>

      <section className="sem__stage">
        {/* The parent stays visible THROUGH the transition, fading into
            breadcrumb context, so the eye can see where the children came
            from. Removing it on the first frame is what made earlier attempts
            read as a page replacement. */}
        {parentNode && (
          <div className={`sem__origin${emerging ? " sem__origin--resolving" : ""}`}>
            <span className="sem__origin-label">{parentNode.label}</span>
          </div>
        )}

        <ul className="sem__concepts">
          {visible.map((node, index) => {
            const live = isProjection(node) && projectionExecution(graph, node.id) === "live";
            const source = isAuthoredSource(node);
            return (
              <li
                key={node.id}
                className={
                  "sem__concept"
                  + (node.id === centreId ? " sem__concept--centre" : "")
                  + (live ? " sem__concept--live" : "")
                  + (source ? " sem__concept--source" : "")
                  + (emerging ? " sem__concept--emerging" : "")
                  + (converging ? " sem__concept--converging" : "")
                }
                style={{ "--i": index, "--n": visible.length }}
              >
                <button type="button" className="sem__hit" onClick={() => select(node.id)}>
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

      {/* Provenance is available on demand and absent from the default screen:
          the operator should be able to tell derived from authored without
          paying that metadata cost at every glance. */}
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

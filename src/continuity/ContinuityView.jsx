import { useMemo, useState } from "react";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";
import {
  buildContinuityViewport,
  resolutionStep,
} from "./model.js";
import "./continuity.css";

const STATUS = {
  live: "Live",
  committed: "Committed",
  merged: "Merged",
  superseded: "Superseded",
  deferred: "Deferred",
  reverted: "Reverted",
  blocked: "Blocked",
  needs_human: "Needs human",
  absent: "Not represented",
};

function positions(count) {
  if (count === 1) return [350];
  if (count === 2) return [255, 445];
  if (count === 3) return [205, 350, 495];
  return [160, 285, 415, 540];
}

function Edge({ x1, y1, x2, y2, live = false, faint = false }) {
  const mid = (x1 + x2) / 2;
  return (
    <path
      className={`ct-edge${live ? " ct-edge--live" : ""}${faint ? " ct-edge--faint" : ""}`}
      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
    />
  );
}

function Node({ label, status, x, y, center = false, faint = false, dynamic = false, onClick }) {
  return (
    <g
      className={`ct-node ct-node--${status || "merged"}${center ? " ct-node--center" : ""}${faint ? " ct-node--faint" : ""}${onClick ? " ct-node--clickable" : ""}`}
      transform={`translate(${x},${y})`}
      onClick={onClick}
    >
      {center && status !== "absent" && <circle className="ct-pulse" r="31" />}
      <circle className="ct-node__circle" r={center ? 24 : 16} />
      <text className="ct-node__label" x="30" y="-2">{label}</text>
      <text className="ct-node__sub" x="30" y="15">
        {dynamic ? "dynamic abstraction" : STATUS[status] || "Context"}
      </text>
    </g>
  );
}

function EmptyContinuity() {
  return (
    <main className="ct-empty">
      <strong>{config.siteName} / Continuity</strong>
      <p>No continuity.json was found at the configured data source.</p>
      <a href="?view=landscape">Return to landscape</a>
    </main>
  );
}

function ContinuitySurface({ data }) {
  const [timeIndex, setTimeIndex] = useState(data.snapshots.length - 1);
  const [selected, setSelected] = useState(data.snapshots.at(-1).dominant);
  const [resolution, setResolution] = useState(0.5);
  const [inspectOpen, setInspectOpen] = useState(false);

  const viewport = useMemo(
    () => buildContinuityViewport(data, { timeIndex, selectedId: selected, resolution }),
    [data, timeIndex, selected, resolution],
  );

  const snapshot = viewport.snapshot;
  const ys = positions(viewport.neighbors.length);

  const historyNote = useMemo(() => {
    const missing = viewport.history.filter((point) => !point.exists).length;
    if (!missing) return null;
    return `${viewport.selectedId} is absent from ${missing} historical semantic snapshot${missing > 1 ? "s" : ""}; the original ontology is preserved.`;
  }, [viewport.history, viewport.selectedId]);

  function selectConcept(label) {
    setSelected(label);
    setInspectOpen(false);
  }

  function reabstract(direction) {
    if (!viewport.concept) return;
    const step = resolutionStep(viewport.concept);
    setResolution((value) => Math.max(0, Math.min(1, value + direction * step)));
  }

  function moveTime(index) {
    // Keep the selected concept even if it did not exist in this snapshot.
    // The viewport will render its historical absence rather than substitute a
    // modern concept or silently jump to the dominant project state.
    setTimeIndex(index);
    setInspectOpen(false);
  }

  return (
    <main
      className="ct-root"
      onWheel={(event) => {
        event.preventDefault();
        reabstract(event.deltaY < 0 ? 1 : -1);
      }}
    >
      <header className="ct-top">
        <div className="ct-brand">{config.siteName} <span>/ Continuity</span></div>
        <div className="ct-context"><b>Large context:</b> {snapshot.largeContext}</div>
        <div className="ct-top__actions">
          <button
            onClick={() => viewport.parent && selectConcept(viewport.parent.label)}
            disabled={!viewport.parent}
          >← Up</button>
          <button onClick={() => setInspectOpen((value) => !value)}>Inspect</button>
          <a href="?view=landscape">Landscape ↗</a>
        </div>
      </header>

      <svg className="ct-graph" viewBox="0 0 1200 700" aria-label="Continuity semantic graph">
        {viewport.parent && (
          <>
            <Edge x1={170} y1={350} x2={600} y2={350} faint />
            <Node
              label={viewport.parent.label}
              status={viewport.parent.status}
              x={170}
              y={350}
              faint
              onClick={() => selectConcept(viewport.parent.label)}
            />
          </>
        )}

        <Node
          label={viewport.selectedId}
          status={viewport.absent ? "absent" : viewport.concept.status}
          x={600}
          y={350}
          center
        />

        {viewport.neighbors.map((neighbor, index) => (
          <g key={`${viewport.selectedId}-${viewport.level}-${neighbor.label}`}>
            <Edge
              x1={600}
              y1={350}
              x2={910}
              y2={ys[index]}
              live={neighbor.status === "live"}
              faint={viewport.absent}
            />
            <Node
              label={neighbor.label}
              status={neighbor.status}
              x={910}
              y={ys[index]}
              dynamic={neighbor.dynamic}
              onClick={neighbor.clickable ? () => selectConcept(neighbor.label) : undefined}
            />
          </g>
        ))}
      </svg>

      {inspectOpen && (
        <aside className="ct-inspect">
          <div className="ct-inspect__eyebrow">Evidence inspection</div>
          <h2>{viewport.selectedId}</h2>
          <p>{viewport.summary}</p>
          {(viewport.concept?.evidence || []).map((item) => (
            <div className="ct-evidence" key={item}>• {item}</div>
          ))}
          {historyNote && <div className="ct-history-note">{historyNote}</div>}
        </aside>
      )}

      <footer className="ct-bottom">
        <div className="ct-summary">
          <strong>{viewport.selectedId}</strong><br />
          {viewport.summary}
          {snapshot.hiddenCount != null && (
            <small>{snapshot.hiddenCount.toLocaleString()} lower-order items abstracted away</small>
          )}
        </div>

        <div className="ct-controls">
          <div className="ct-resolution">
            <button onClick={() => reabstract(-1)} disabled={viewport.absent}>−</button>
            <span>
              {viewport.absent
                ? "semantic resolution unavailable"
                : `semantic resolution ${viewport.level + 1}/${viewport.concept.resolutions.length}`}
            </span>
            <button onClick={() => reabstract(1)} disabled={viewport.absent}>+</button>
          </div>
          <div className="ct-time">
            <span>past</span>
            <input
              type="range"
              min="0"
              max={data.snapshots.length - 1}
              value={timeIndex}
              onChange={(event) => moveTime(Number(event.target.value))}
            />
            <span>{snapshot.label}</span>
          </div>
        </div>
      </footer>
    </main>
  );
}

export default function ContinuityView() {
  const data = store.continuity;
  if (!data?.snapshots?.length) return <EmptyContinuity />;
  return <ContinuitySurface data={data} />;
}

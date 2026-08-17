import { useMemo, useState } from "react";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";
import "./continuity.css";

const STATUS = {
  live: "Live",
  committed: "Committed",
  merged: "Merged",
  superseded: "Superseded",
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
      {center && <circle className="ct-pulse" r="31" />}
      <circle className="ct-node__circle" r={center ? 24 : 16} />
      <text className="ct-node__label" x="30" y="-2">{label}</text>
      <text className="ct-node__sub" x="30" y="15">
        {dynamic ? "dynamic abstraction" : STATUS[status] || "Context"}
      </text>
    </g>
  );
}

export default function ContinuityView() {
  const data = store.continuity;

  if (!data?.snapshots?.length) {
    return (
      <main className="ct-empty">
        <strong>{config.siteName} / Continuity</strong>
        <p>No continuity.json was found at the configured data source.</p>
        <a href="?view=landscape">Return to landscape</a>
      </main>
    );
  }

  const [timeIndex, setTimeIndex] = useState(data.snapshots.length - 1);
  const [selected, setSelected] = useState(data.snapshots.at(-1).dominant);
  const [resolution, setResolution] = useState(1);
  const [inspectOpen, setInspectOpen] = useState(false);

  const snapshot = data.snapshots[timeIndex];
  const selectedId = snapshot.concepts[selected] ? selected : snapshot.dominant;
  const concept = snapshot.concepts[selectedId];
  const level = Math.max(0, Math.min(concept.resolutions.length - 1, resolution));
  const neighborLabels = concept.resolutions[level].slice(0, data.attentionBudget?.maxNeighbors || 4);
  const ys = positions(neighborLabels.length);
  const parent = concept.parent && snapshot.concepts[concept.parent]
    ? snapshot.concepts[concept.parent]
    : null;

  const historyNote = useMemo(() => {
    const points = data.snapshots.map((s) => ({ label: s.label, exists: Boolean(s.concepts[selectedId]) }));
    const missing = points.filter((p) => !p.exists).length;
    return missing ? `${selectedId} is absent from ${missing} earlier semantic snapshot${missing > 1 ? "s" : ""}.` : null;
  }, [data.snapshots, selectedId]);

  function reabstract(delta) {
    setResolution((r) => Math.max(0, Math.min(concept.resolutions.length - 1, r + delta)));
  }

  function moveTime(index) {
    const next = data.snapshots[index];
    setTimeIndex(index);
    if (!next.concepts[selectedId]) setSelected(next.dominant);
    setInspectOpen(false);
  }

  return (
    <main
      className="ct-root"
      onWheel={(e) => {
        e.preventDefault();
        reabstract(e.deltaY < 0 ? 1 : -1);
      }}
    >
      <header className="ct-top">
        <div className="ct-brand">{config.siteName} <span>/ Continuity</span></div>
        <div className="ct-context"><b>Large context:</b> {snapshot.largeContext}</div>
        <div className="ct-top__actions">
          <button onClick={() => parent && setSelected(concept.parent)} disabled={!parent}>← Up</button>
          <button onClick={() => setInspectOpen((v) => !v)}>Inspect</button>
          <a href="?view=landscape">Landscape ↗</a>
        </div>
      </header>

      <svg className="ct-graph" viewBox="0 0 1200 700" aria-label="Continuity semantic graph">
        {parent && (
          <>
            <Edge x1={170} y1={350} x2={600} y2={350} faint />
            <Node label={concept.parent} status={parent.status} x={170} y={350} faint onClick={() => setSelected(concept.parent)} />
          </>
        )}

        <Node label={selectedId} status={concept.status} x={600} y={350} center />

        {neighborLabels.map((label, i) => {
          const literal = snapshot.concepts[label];
          const status = literal?.status || (concept.status === "live" ? "live" : "merged");
          return (
            <g key={`${selectedId}-${level}-${label}`}>
              <Edge x1={600} y1={350} x2={910} y2={ys[i]} live={status === "live"} />
              <Node
                label={label}
                status={status}
                x={910}
                y={ys[i]}
                dynamic={!literal}
                onClick={literal ? () => { setSelected(label); setInspectOpen(false); } : undefined}
              />
            </g>
          );
        })}
      </svg>

      {inspectOpen && (
        <aside className="ct-inspect">
          <div className="ct-inspect__eyebrow">Evidence inspection</div>
          <h2>{selectedId}</h2>
          <p>{concept.summary}</p>
          {(concept.evidence || []).map((item) => <div className="ct-evidence" key={item}>• {item}</div>)}
          {historyNote && <div className="ct-history-note">{historyNote}</div>}
        </aside>
      )}

      <footer className="ct-bottom">
        <div className="ct-summary">
          <strong>{selectedId}</strong><br />
          {concept.summary}
          {snapshot.hiddenCount != null && <small>{snapshot.hiddenCount.toLocaleString()} lower-order items abstracted away</small>}
        </div>

        <div className="ct-controls">
          <div className="ct-resolution">
            <button onClick={() => reabstract(-1)}>−</button>
            <span>semantic resolution {level + 1}/{concept.resolutions.length}</span>
            <button onClick={() => reabstract(1)}>+</button>
          </div>
          <div className="ct-time">
            <span>past</span>
            <input
              type="range"
              min="0"
              max={data.snapshots.length - 1}
              value={timeIndex}
              onChange={(e) => moveTime(Number(e.target.value))}
            />
            <span>{snapshot.label}</span>
          </div>
        </div>
      </footer>
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";
import {
  buildContinuityViewport,
  resolutionStep,
} from "./model.js";
import {
  readContinuityLocation,
  writeContinuityLocation,
} from "./navigation.js";
import TemporalField from "./TemporalField.jsx";
import {
  executionLabel,
  supervisionLabel,
  temporalX,
} from "./temporal.js";

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

function positions(count, compact = false) {
  if (compact) {
    if (count === 1) return [325];
    if (count === 2) return [240, 410];
    if (count === 3) return [180, 325, 470];
    return [135, 260, 390, 515];
  }
  if (count === 1) return [350];
  if (count === 2) return [255, 445];
  if (count === 3) return [205, 350, 495];
  return [160, 285, 415, 540];
}

function useCompactLayout() {
  const query = "(max-width: 760px)";
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return compact;
}

function sourceSummary(source) {
  if (!source) return null;
  if (source.kind === "llm_projection") {
    const parts = ["LLM semantic projection"];
    if (source.normalizedObservations != null) parts.push(`${source.normalizedObservations} supplied observations`);
    if (source.graphNodes != null) parts.push(`${source.graphNodes} graph records`);
    else if (source.suppliedThoughts != null) parts.push(`${source.suppliedThoughts} supplied thoughts`);
    return parts.join(" · ");
  }
  if (source.kind === "decision_graph") return "Projection derived from the temporal decision graph";
  if (source.kind === "synthetic") return "Synthetic demonstration snapshot";
  if (source.kind === "manual") return "Manually authored semantic snapshot";
  if (source.kind === "imported") return "Imported semantic snapshot";
  return `Snapshot source: ${source.kind}`;
}

function evidenceSummary(item) {
  if (typeof item === "string") return item;
  return item?.summary || "";
}

function conceptSourceSummary(concept) {
  if (!concept) return null;
  const observations = new Set(concept.sourceObservationIds || []).size;
  const graphNodes = new Set(concept.sourceGraphNodeIds || []).size;
  if (!observations && !graphNodes) return null;
  const parts = [];
  if (observations) parts.push(`${observations} source observation${observations === 1 ? "" : "s"}`);
  if (graphNodes) parts.push(`${graphNodes} graph record${graphNodes === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function Edge({ x1, y1, x2, y2, live = false, faint = false, planned = false }) {
  const mid = (x1 + x2) / 2;
  return (
    <path
      className={`ct-edge${live ? " ct-edge--live" : ""}${faint ? " ct-edge--faint" : ""}${planned ? " ct-edge--planned" : ""}`}
      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
    />
  );
}

function Node({
  label,
  status,
  x,
  y,
  center = false,
  faint = false,
  dynamic = false,
  onClick,
  executionState,
  supervision,
  scheduled = false,
}) {
  const interactive = Boolean(onClick);
  const execution = executionLabel({ executionState });
  const supervisionText = supervisionLabel({ supervision, scheduled });
  const sub = dynamic
    ? "dynamic abstraction"
    : [execution, supervisionText].filter(Boolean).join(" · ") || STATUS[status] || "Context";

  function activateFromKeyboard(event) {
    if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onClick();
  }

  return (
    <g
      className={`ct-node ct-node--${status || "merged"}${center ? " ct-node--center" : ""}${faint ? " ct-node--faint" : ""}${interactive ? " ct-node--clickable" : ""}${executionState ? ` ct-node--execution-${executionState}` : ""}${supervision ? ` ct-node--supervision-${supervision}` : ""}`}
      transform={`translate(${x},${y})`}
      onClick={onClick}
      onKeyDown={activateFromKeyboard}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Recenter on ${label}` : undefined}
    >
      {center && status !== "absent" && executionState !== "planned" && <circle className="ct-pulse" r="31" />}
      <circle className="ct-node__circle" r={center ? 24 : 16} />
      <text className="ct-node__label" x="30" y="-2">{label}</text>
      <text className="ct-node__sub" x="30" y="15">{sub}</text>
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
  const initialLocation = useMemo(
    () => readContinuityLocation(data, window.location.href),
    [data],
  );
  const [timeIndex, setTimeIndex] = useState(initialLocation.timeIndex);
  const [selected, setSelected] = useState(initialLocation.selected);
  const [resolution, setResolution] = useState(initialLocation.resolution);
  const [inspectOpen, setInspectOpen] = useState(false);
  const compact = useCompactLayout();

  useEffect(() => {
    const restoreLocation = () => {
      const next = readContinuityLocation(data, window.location.href);
      setTimeIndex(next.timeIndex);
      setSelected(next.selected);
      setResolution(next.resolution);
      setInspectOpen(false);
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [data]);

  const viewport = useMemo(
    () => buildContinuityViewport(data, { timeIndex, selectedId: selected, resolution }),
    [data, timeIndex, selected, resolution],
  );

  const snapshot = viewport.snapshot;
  const temporalField = data.temporalField || null;
  const layout = compact
    ? {
        viewBox: "0 0 450 650",
        center: { x: 75, y: 325 },
        parent: { x: 75, y: 150 },
        neighborX: 220,
        timelineMinX: 42,
        timelineMaxX: 408,
      }
    : {
        viewBox: "0 0 1200 700",
        center: { x: 600, y: 350 },
        parent: { x: 170, y: 350 },
        neighborX: 910,
        timelineMinX: 90,
        timelineMaxX: 1110,
      };
  const ys = positions(viewport.neighbors.length, compact);
  const snapshotSource = sourceSummary(snapshot.source);
  const conceptSource = conceptSourceSummary(viewport.concept);

  const nodeX = (node, fallback) => {
    if (!temporalField || !node) return fallback;
    const time = node.occurredAt || (node.executionState === "running" ? temporalField.now : null);
    return temporalX(time, temporalField, layout.timelineMinX, layout.timelineMaxX) ?? fallback;
  };

  const centerNode = viewport.concept
    ? {
        ...viewport.concept,
        occurredAt: viewport.concept.occurredAt || null,
        executionState: viewport.concept.executionState || null,
        supervision: viewport.concept.supervision || null,
        scheduled: Boolean(viewport.concept.scheduled),
      }
    : null;
  const centerX = nodeX(centerNode, layout.center.x);
  const parentX = nodeX(viewport.parent, layout.parent.x);

  const historyNote = useMemo(() => {
    const missing = viewport.history.filter((point) => !point.exists).length;
    if (!missing) return null;
    return `${viewport.selectedId} is absent from ${missing} historical semantic snapshot${missing > 1 ? "s" : ""}; the original ontology is preserved.`;
  }, [viewport.history, viewport.selectedId]);

  function selectConcept(label) {
    writeContinuityLocation(
      data,
      { timeIndex, selected: label, resolution },
      "push",
    );
    setSelected(label);
    setInspectOpen(false);
  }

  function reabstract(direction) {
    if (!viewport.concept) return;
    const step = resolutionStep(viewport.concept);
    const nextResolution = Math.max(0, Math.min(1, resolution + direction * step));
    writeContinuityLocation(
      data,
      { timeIndex, selected, resolution: nextResolution },
      "replace",
    );
    setResolution(nextResolution);
  }

  function moveTime(index) {
    writeContinuityLocation(
      data,
      { timeIndex: index, selected, resolution },
      "replace",
    );
    setTimeIndex(index);
    setInspectOpen(false);
  }

  return (
    <main
      className={`ct-root${temporalField ? " ct-root--temporal" : ""}`}
      onWheel={(event) => {
        event.preventDefault();
        reabstract(event.deltaY < 0 ? 1 : -1);
      }}
    >
      <TemporalField field={temporalField} />

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

      <svg className="ct-graph" viewBox={layout.viewBox} aria-label="Continuity semantic graph">
        {viewport.parent && (
          <>
            <Edge
              x1={parentX}
              y1={layout.parent.y}
              x2={centerX}
              y2={layout.center.y}
              faint
              planned={viewport.parent.executionState === "planned"}
            />
            <Node
              label={viewport.parent.label}
              status={viewport.parent.status}
              x={parentX}
              y={layout.parent.y}
              faint
              executionState={viewport.parent.executionState}
              supervision={viewport.parent.supervision}
              scheduled={viewport.parent.scheduled}
              onClick={() => selectConcept(viewport.parent.label)}
            />
          </>
        )}

        <Node
          label={viewport.selectedId}
          status={viewport.absent ? "absent" : viewport.concept.status}
          x={centerX}
          y={layout.center.y}
          center
          executionState={centerNode?.executionState}
          supervision={centerNode?.supervision}
          scheduled={centerNode?.scheduled}
        />

        {viewport.neighbors.map((neighbor, index) => {
          const neighborX = nodeX(neighbor, layout.neighborX);
          return (
            <g key={`${viewport.selectedId}-${viewport.level}-${neighbor.label}`}>
              <Edge
                x1={centerX}
                y1={layout.center.y}
                x2={neighborX}
                y2={ys[index]}
                live={neighbor.status === "live" || neighbor.executionState === "running"}
                faint={viewport.absent}
                planned={neighbor.executionState === "planned"}
              />
              <Node
                label={neighbor.label}
                status={neighbor.status}
                x={neighborX}
                y={ys[index]}
                dynamic={neighbor.dynamic}
                executionState={neighbor.executionState}
                supervision={neighbor.supervision}
                scheduled={neighbor.scheduled}
                onClick={neighbor.clickable ? () => selectConcept(neighbor.label) : undefined}
              />
            </g>
          );
        })}
      </svg>

      {inspectOpen && (
        <aside className="ct-inspect">
          <div className="ct-inspect__eyebrow">Evidence inspection</div>
          <h2>{viewport.selectedId}</h2>
          <p>{viewport.summary}</p>
          {(viewport.concept?.evidence || []).map((item, index) => (
            <div className="ct-evidence" key={`${evidenceSummary(item)}-${index}`}>• {evidenceSummary(item)}</div>
          ))}
          {conceptSource && <div className="ct-history-note">{conceptSource}</div>}
          {historyNote && <div className="ct-history-note">{historyNote}</div>}
          {snapshotSource && <div className="ct-history-note">{snapshotSource}</div>}
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
            <span>history</span>
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
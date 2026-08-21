import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";
import {
  agoLabel,
  buildBriefingViewport,
  effortLabel,
  readBriefingLocation,
  writeBriefingLocation,
} from "./briefing.js";

// The catch-up surface, in Continuity's own visual language.
//
// The design source is the mockup pair from the DataScape design conversation
// (2026-08-17): a near-black indigo canvas; a glowing origin orb per cluster;
// luminous curved threads fanning right to ring-nodes; labels sitting beside
// their rings with a status sub-label; dashed rings for anything speculative
// or waiting; a floating glass card under the expanded node; and a
// "brief me in: 30 sec / 3 min / full" control instead of a pagination widget.
// Same contract as before — one line collapsed, authored detail expanded,
// expansion addressable in the URL — different skin entirely.
//
// Threads are drawn in an absolutely-positioned SVG that measures the HTML
// rows after layout (ResizeObserver), so expanding a card pushes the rows and
// the threads stay attached, exactly like the mockup's fan.

const STATUS_META = {
  needs_human: { label: "Needs you", glyph: "◇" },
  live: { label: "Finding", glyph: "✦" },
  merged: { label: "Progress", glyph: "✓" },
  committed: { label: "State", glyph: "○" },
};

const TYPE_LABEL = {
  owner_action: "needs you",
  finding: "finding",
  progress: "progress",
  state: "state",
};

const STEP_META = {
  run: { label: "run", glyph: "▸" },
  open: { label: "open", glyph: "↗" },
  decide: { label: "decide", glyph: "◈" },
  physical: { label: "do", glyph: "⬡" },
};

const SEVERITY_LABEL = { high: "High", medium: "Med", low: "Low" };

// The brief presets. "30 sec" is one record per lane and only the high-severity
// asks; "3 min" is the owner default (the latest two); "full" opens the depth.
const BRIEFS = [
  { key: "30s", label: "30 sec", latest: 1 },
  { key: "3m", label: "3 min", latest: 2 },
  { key: "full", label: "Full", latest: 5 },
];

function useMeasuredThreads(deps) {
  // Measures each row's ring anchor relative to the cluster, so the SVG fan
  // can connect the origin orb to rings whose y-positions change as cards
  // open. Returns [containerRef, ringRefCallback, geometry].
  const containerRef = useRef(null);
  const ringRefs = useRef(new Map());
  const [geometry, setGeometry] = useState({ width: 0, height: 0, points: [] });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const points = [];
    for (const [key, el] of ringRefs.current) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      points.push({ key, x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 });
    }
    points.sort((a, b) => a.y - b.y);
    setGeometry((prev) => {
      const next = { width: box.width, height: box.height, points };
      // Avoid a render loop: only update when something actually moved.
      const same = prev.width === next.width && prev.height === next.height &&
        prev.points.length === next.points.length &&
        prev.points.every((p, i) => Math.abs(p.x - next.points[i].x) < 0.5 && Math.abs(p.y - next.points[i].y) < 0.5 && p.key === next.points[i].key);
      return same ? prev : next;
    });
  }, []);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const ringRef = useCallback((key) => (el) => {
    if (el) ringRefs.current.set(key, el);
    else ringRefs.current.delete(key);
  }, []);

  return [containerRef, ringRef, geometry, measure];
}

function ThreadFan({ geometry, origin, dashedKeys }) {
  if (!geometry.points.length) return null;
  const { x: ox, y: oy } = origin;
  return (
    <svg className="bf-threads" width={geometry.width} height={geometry.height} aria-hidden="true">
      {geometry.points.map(({ key, x, y }) => {
        const mid = ox + (x - ox) * 0.55;
        return (
          <path
            key={key}
            className={`bf-thread${dashedKeys?.has(key) ? " bf-thread--dashed" : ""}`}
            d={`M ${ox} ${oy} C ${mid} ${oy}, ${mid} ${y}, ${x - 11} ${y}`}
          />
        );
      })}
    </svg>
  );
}

function Ring({ status, open, dashed, refCallback }) {
  return (
    <span
      ref={refCallback}
      className={`bf-ring bf-ring--${status}${open ? " bf-ring--open" : ""}${dashed ? " bf-ring--dashed" : ""}`}
      aria-hidden="true"
    >
      <span className="bf-ring__core" />
    </span>
  );
}

// One node row: ring + label + status sub-label, expanding into a glass card.
function NodeRow({ id, status, dashed, label, sub, badge, open, onToggle, refCallback, children }) {
  const activate = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };
  return (
    <div className={`bf-row${open ? " bf-row--open" : ""}`}>
      <div
        className="bf-row__line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={`${id}-card`}
        onClick={onToggle}
        onKeyDown={activate}
      >
        <Ring status={status} open={open} dashed={dashed} refCallback={refCallback} />
        <span className="bf-row__label">{label}</span>
        {badge && <span className="bf-row__badge">{badge}</span>}
        <span className="bf-row__sub">{sub}</span>
      </div>
      {open && (
        <div className="bf-card" id={`${id}-card`}>
          {children}
        </div>
      )}
    </div>
  );
}

function Step({ step }) {
  const [copied, setCopied] = useState(false);
  const meta = STEP_META[step.kind] || STEP_META.decide;
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(step.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [step.command]);

  return (
    <li className={`bf-step bf-step--${step.kind}`}>
      <span className="bf-step__glyph">{meta.glyph}</span>
      <span className="bf-step__kind">{meta.label}</span>
      <div className="bf-step__main">
        <div className="bf-step__text">{step.text}</div>
        {step.command && (
          <div className="bf-step__cmd">
            <code>{step.command}</code>
            <button type="button" onClick={copy} aria-label="Copy command">
              {copied ? "copied" : "copy"}
            </button>
          </div>
        )}
        {step.href && (
          <a className="bf-step__link" href={step.href} target="_blank" rel="noreferrer noopener">
            {step.href.replace(/^https?:\/\//, "").slice(0, 68)} ↗
          </a>
        )}
      </div>
    </li>
  );
}

// The "Needs you" cluster: an amber origin orb fanning to one dashed ring per
// open owner action. In the 30-sec brief only the high-severity asks fan out;
// the rest wait behind a ghost node.
function NeedsYou({ actions, viewport, toggle, showAll, onShowAll }) {
  const visible = showAll ? actions : actions.filter((a) => a.severity === "high");
  const hidden = actions.length - visible.length;
  const [containerRef, ringRef, geometry] = useMeasuredThreads([visible.length, viewport, showAll]);
  const origin = { x: 74, y: Math.max(84, geometry.height / 2) };

  return (
    <section className="bf-cluster bf-cluster--needs" ref={containerRef}>
      <ThreadFan geometry={geometry} origin={origin} dashedKeys={new Set(geometry.points.map((p) => p.key))} />
      <div className="bf-orb bf-orb--amber" style={{ top: origin.y }}>
        <span className="bf-orb__glow" />
        <div className="bf-orb__label">
          <strong>Needs you</strong>
          <small>{actions.length} open{actions.filter((a) => a.severity === "high").length ? ` · ${actions.filter((a) => a.severity === "high").length} high` : ""}</small>
        </div>
      </div>
      <div className="bf-rows">
        {visible.map((action) => (
          <NodeRow
            key={action.nodeId}
            id={action.nodeId}
            status="needs_human"
            dashed
            label={action.title}
            badge={SEVERITY_LABEL[action.severity]}
            sub={`${effortLabel(action.estimatedSeconds)} · ${agoLabel(action.updated)}`}
            open={viewport.isExpanded(action.nodeId)}
            onToggle={() => toggle(action.nodeId)}
            refCallback={ringRef(action.nodeId)}
          >
            {action.steps.length > 0 ? (
              <ol className="bf-steps">
                {action.steps.map((step) => (
                  <Step key={`${action.id}-${step.n}`} step={step} />
                ))}
              </ol>
            ) : (
              <p className="bf-note">No atomic steps recorded yet — this ask is still prose.</p>
            )}
            {action.needsBreakdown && !action.authoredSteps && (
              <p className="bf-note bf-note--warn">
                Steps derived from prose — the filing lane has not broken this down. A hint, not a checklist.
              </p>
            )}
            {action.latestAmendment && (
              <details className="bf-more">
                <summary>Latest amendment{action.amendmentCount > 1 ? ` (${action.amendmentCount})` : ""}</summary>
                <p>{action.latestAmendment}</p>
              </details>
            )}
            <div className="bf-provenance">
              {action.loop && <span>{action.loop}</span>}
              <span>{action.id}</span>
            </div>
          </NodeRow>
        ))}
        {hidden > 0 && (
          <div className="bf-row">
            <button type="button" className="bf-row__line bf-row__line--ghost" onClick={onShowAll}>
              <span className="bf-ring bf-ring--ghost" ref={ringRef("__ghost_actions")} aria-hidden="true"><span className="bf-ring__core" /></span>
              <span className="bf-row__label">{hidden} more, medium and low</span>
              <span className="bf-row__sub">expand</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// One lane cluster: origin orb (lane name + its two conversations) fanning to
// the latest records' items, newest first.
function Lane({ lane, viewport, toggle }) {
  const rows = [];
  for (const record of lane.records) {
    for (const item of record.items) {
      rows.push({ record, item });
    }
  }
  const [containerRef, ringRef, geometry] = useMeasuredThreads([rows.length, viewport]);
  const origin = { x: 74, y: Math.max(84, geometry.height / 2) };
  const dashedKeys = new Set(rows.filter(({ item }) => item.status === "needs_human" || item.status === "live").map(({ item }) => item.nodeId));

  return (
    <section className="bf-cluster" >
      <div ref={containerRef} className="bf-cluster__inner">
        <ThreadFan geometry={geometry} origin={origin} dashedKeys={dashedKeys} />
        <div className="bf-orb" style={{ top: origin.y }}>
          <span className="bf-orb__glow" />
          <div className="bf-orb__label">
            <strong>{lane.label}</strong>
            <small>{agoLabel(lane.lastSeen)} · {lane.total} total</small>
            <span className="bf-orb__links">
              {lane.autoRunUrl && <a href={lane.autoRunUrl} target="_blank" rel="noreferrer noopener">Auto Run ↗</a>}
              {lane.seedUrl && <a href={lane.seedUrl} target="_blank" rel="noreferrer noopener" title="The frozen original this lane was branched from">Seed ↗</a>}
            </span>
          </div>
        </div>
        <div className="bf-rows">
          {rows.map(({ record, item }) => (
            <NodeRow
              key={item.nodeId}
              id={item.nodeId}
              status={item.status}
              dashed={item.status === "needs_human"}
              label={item.headline}
              sub={`${TYPE_LABEL[item.type] || "state"} · ${agoLabel(record.emittedAt)}${record.provenance === "backfilled-from-log" ? " · reconstructed" : ""}`}
              open={viewport.isExpanded(item.nodeId)}
              onToggle={() => toggle(item.nodeId)}
              refCallback={ringRef(item.nodeId)}
            >
              <p className="bf-detail">{item.detail || item.raw}</p>
              {(item.links?.length > 0 || item.refs?.exceptions?.length > 0 || item.refs?.prs?.length > 0) && (
                <div className="bf-refs">
                  {item.links?.map((link) => (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener">{link.text} ↗</a>
                  ))}
                  {item.refs?.exceptions?.map((id) => <span key={id} className="bf-ref bf-ref--exception">{id}</span>)}
                  {item.refs?.prs?.map((pr) => <span key={pr} className="bf-ref">{pr}</span>)}
                </div>
              )}
              {record.provenance === "backfilled-from-log" && (
                <div className="bf-provenance"><span>reconstructed from {record.sourceRef || "an ops log"}</span></div>
              )}
            </NodeRow>
          ))}
          {lane.hiddenCount > 0 && (
            <div className="bf-row">
              <div className="bf-row__line bf-row__line--ghost bf-row__line--static">
                <span className="bf-ring bf-ring--ghost" ref={ringRef(`__ghost_${lane.lane}`)} aria-hidden="true"><span className="bf-ring__core" /></span>
                <span className="bf-row__label">{lane.hiddenCount.toLocaleString()} earlier, abstracted away</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Stars() {
  // A deterministic scatter of faint particles — the Plakhova texture, at 2%
  // opacity rather than as the subject. Seeded so every reload is identical.
  const stars = useMemo(() => {
    const out = [];
    let seed = 20260817;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 90; i++) {
      out.push({
        left: `${(rand() * 100).toFixed(2)}%`,
        top: `${(rand() * 100).toFixed(2)}%`,
        size: rand() > 0.85 ? 2 : 1,
        opacity: 0.12 + rand() * 0.3,
      });
    }
    return out;
  }, []);
  return (
    <div className="bf-stars" aria-hidden="true">
      {stars.map((s, i) => (
        <span key={i} style={{ left: s.left, top: s.top, width: s.size, height: s.size, opacity: s.opacity }} />
      ))}
    </div>
  );
}

function awayLabel(lanes) {
  const newest = lanes.map((l) => Date.parse(l.lastSeen || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (!newest) return null;
  const minutes = Math.max(0, Math.round((Date.now() - newest) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 48) return `${h}h ${m}m`;
  return `${Math.round(h / 24)} days`;
}

function EmptyBriefing() {
  return (
    <main className="bf-empty">
      <strong>{config.siteName} / Continuity</strong>
      <p>No continuity-briefing.json was found at the configured data source.</p>
      <a href="?view=continuity">Continuity</a>
    </main>
  );
}

function BriefingSurface({ data }) {
  const initial = useMemo(() => readBriefingLocation(window.location.href), []);
  const [expanded, setExpanded] = useState(initial.expanded);
  const [latest, setLatest] = useState(initial.latest);
  const [laneFilter, setLaneFilter] = useState(initial.laneFilter);
  const [showAllActions, setShowAllActions] = useState(initial.latest != null && initial.latest >= 5);

  useEffect(() => {
    const restore = () => {
      const next = readBriefingLocation(window.location.href);
      setExpanded(next.expanded);
      setLatest(next.latest);
      setLaneFilter(next.laneFilter);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const viewport = useMemo(
    () => buildBriefingViewport(data, { latest, expanded, laneFilter }),
    [data, latest, expanded, laneFilter],
  );

  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeBriefingLocation({ expanded: next, latest, laneFilter }, "push");
      return next;
    });
  }, [latest, laneFilter]);

  const setBrief = useCallback((preset) => {
    setLatest(preset.latest);
    setShowAllActions(preset.key === "full");
    writeBriefingLocation({ expanded, latest: preset.latest, laneFilter }, "replace");
  }, [expanded, laneFilter]);

  const activeBrief = BRIEFS.find((b) => b.latest === viewport.perLane)?.key
    ?? (viewport.perLane >= 5 ? "full" : "3m");
  const away = awayLabel(viewport.lanes);
  const high = viewport.ownerActions.filter((a) => a.severity === "high").length;

  return (
    <main className="bf-root">
      <Stars />

      <header className="bf-top">
        <div className="bf-brand"><span className="bf-brand__dot" />{config.siteName} <span>/ Continuity</span></div>
        <div className="bf-away">
          {away ? <>You were away for <b>{away}</b></> : "Catch-up"}
          {viewport.generatedAtLocal && (
            <small> · as at {viewport.generatedAtLocal.slice(0, 16).replace("T", " ")} Sydney</small>
          )}
        </div>
        <div className="bf-top__actions">
          <div className="bf-briefsel" role="group" aria-label="Brief me in">
            <span>Brief me in:</span>
            {BRIEFS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={activeBrief === preset.key ? "bf-briefsel--active" : ""}
                onClick={() => setBrief(preset)}
              >{preset.label}</button>
            ))}
          </div>
          <a href="?view=continuity">Continuity ↗</a>
        </div>
      </header>

      <div className="bf-tiles">
        <div className="bf-tile bf-tile--amber">
          <b>{viewport.ownerActions.length}</b>
          <span>decisions need you{high ? <em>{high} high</em> : null}</span>
        </div>
        <div className="bf-tile">
          <b>{viewport.lanes.length}</b>
          <span>lanes reporting</span>
        </div>
        <div className="bf-tile">
          <b>{(viewport.totals.mustReads ?? 0).toLocaleString()}</b>
          <span>must-reads recorded</span>
        </div>
      </div>

      {viewport.ownerActions.length > 0 ? (
        <NeedsYou
          actions={viewport.ownerActions}
          viewport={viewport}
          toggle={toggle}
          showAll={showAllActions}
          onShowAll={() => setShowAllActions(true)}
        />
      ) : (
        <p className="bf-note bf-note--center">Nothing is blocked on you.</p>
      )}

      {laneFilter && (
        <button type="button" className="bf-clear" onClick={() => {
          setLaneFilter(null);
          writeBriefingLocation({ expanded, latest, laneFilter: null }, "push");
        }}>
          showing one lane — show all
        </button>
      )}

      {viewport.lanes.map((lane) => (
        <Lane key={lane.lane} lane={lane} viewport={viewport} toggle={toggle} />
      ))}

      <footer className="bf-bottom">
        <div className="bf-legend">
          {Object.entries(STATUS_META).map(([status, meta]) => (
            <span key={status} className="bf-legend__item">
              <span className={`bf-ring bf-ring--mini bf-ring--${status}${status === "needs_human" ? " bf-ring--dashed" : ""}`}><span className="bf-ring__core" /></span>
              {meta.label}
            </span>
          ))}
        </div>
        <div className="bf-detaildial" role="group" aria-label="Detail per lane">
          <button type="button" onClick={() => setBrief(BRIEFS[Math.max(0, BRIEFS.findIndex((b) => b.latest === viewport.perLane) - 1)] || BRIEFS[0])} aria-label="Less detail">−</button>
          <span>less</span>
          <span className="bf-detaildial__dots">
            {BRIEFS.map((preset) => (
              <i key={preset.key} className={preset.latest <= viewport.perLane ? "on" : ""} />
            ))}
          </span>
          <span>more detail</span>
          <button type="button" onClick={() => setBrief(BRIEFS[Math.min(BRIEFS.length - 1, BRIEFS.findIndex((b) => b.latest === viewport.perLane) + 1)] || BRIEFS[BRIEFS.length - 1])} aria-label="More detail">+</button>
        </div>
      </footer>
    </main>
  );
}

export default function BriefingView() {
  const data = store.briefing;
  if (!data?.lanes && !data?.ownerActions) return <EmptyBriefing />;
  return <BriefingSurface data={data} />;
}

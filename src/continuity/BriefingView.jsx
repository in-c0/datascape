import { useCallback, useEffect, useMemo, useState } from "react";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";
import {
  agoLabel,
  buildBriefingViewport,
  effortLabel,
  readBriefingLocation,
  writeBriefingLocation,
} from "./briefing.js";

// The catch-up surface.
//
// Every node here obeys the same contract: ONE line collapsed, full authored
// detail expanded, and the expansion is addressable in the URL so a reload or a
// shared link reopens exactly what was open. That mirrors the semantic
// viewport's navigation contract rather than inventing a second one.

const SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Low" };

const STEP_LABEL = {
  run: "Run",
  open: "Open",
  decide: "Decide",
  physical: "Do",
};

function Chevron({ open }) {
  return (
    <svg className={`bf-chev${open ? " bf-chev--open" : ""}`} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A briefing node. Collapsed it is a dot, a label and a sub-line; expanded it
 * reveals whatever the caller renders as children.
 *
 * Keyboard-operable for the same reason the semantic nodes are: this is a
 * primary navigation surface, not decoration.
 */
function Node({ id, status, label, sub, badge, open, onToggle, children, tone = "lane" }) {
  const activate = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };

  return (
    <div className={`bf-node bf-node--${tone} bf-node--${status || "committed"}${open ? " bf-node--open" : ""}`}>
      <div
        className="bf-node__head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
        onKeyDown={activate}
      >
        <Chevron open={open} />
        <span className="bf-node__dot" aria-hidden="true" />
        <span className="bf-node__label">{label}</span>
        {badge && <span className="bf-node__badge">{badge}</span>}
        {sub && <span className="bf-node__sub">{sub}</span>}
      </div>
      {open && (
        <div className="bf-node__body" id={`${id}-body`}>
          {children}
        </div>
      )}
    </div>
  );
}

// Atomic step. The whole point of the breakdown is that she never has to
// translate a sentence into an action, so a command is shown as a command she
// can copy in one gesture and a link is shown as a link she can click.
function Step({ step }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(step.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the command is still selectable on screen.
      setCopied(false);
    }
  }, [step.command]);

  return (
    <li className={`bf-step bf-step--${step.kind}`}>
      <span className="bf-step__kind">{STEP_LABEL[step.kind] || "Do"}</span>
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
            {step.href.replace(/^https?:\/\//, "").slice(0, 72)} ↗
          </a>
        )}
      </div>
    </li>
  );
}

function OwnerAction({ action, open, onToggle }) {
  return (
    <Node
      id={action.nodeId}
      tone="action"
      status="needs_human"
      label={action.title}
      badge={SEVERITY_LABEL[action.severity] || action.severity}
      sub={`${effortLabel(action.estimatedSeconds)}${action.stepCount ? ` · ${action.stepCount} step${action.stepCount === 1 ? "" : "s"}` : ""} · ${agoLabel(action.updated)}`}
      open={open}
      onToggle={onToggle}
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

      {action.needsBreakdown && (
        // Said plainly rather than hidden. A derived step is a guess at what she
        // has to do; presenting a guess as an authored checklist is how a
        // catch-up surface starts costing more time than it saves.
        <p className="bf-note bf-note--warn">
          {action.authoredSteps
            ? "Authored steps."
            : "Steps derived from prose — the filing lane has not broken this down. Treat as a hint, not a checklist."}
        </p>
      )}

      {action.latestAmendment && (
        <details className="bf-more">
          <summary>Latest amendment{action.amendmentCount > 1 ? ` (${action.amendmentCount} total)` : ""}</summary>
          <p>{action.latestAmendment}</p>
        </details>
      )}

      <div className="bf-provenance">
        {action.loop && <span>{action.loop}</span>}
        <span>{action.id}</span>
        <span>{action.sourceRef}</span>
      </div>
    </Node>
  );
}

function MustReadItem({ item, open, onToggle }) {
  return (
    <Node
      id={item.nodeId}
      tone="item"
      status={item.status}
      label={item.headline}
      open={open}
      onToggle={onToggle}
    >
      <p className="bf-detail">{item.detail || item.raw}</p>

      {(item.links?.length > 0 || item.refs?.exceptions?.length > 0 || item.refs?.prs?.length > 0) && (
        <div className="bf-refs">
          {item.links?.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener">
              {link.text} ↗
            </a>
          ))}
          {item.refs?.exceptions?.map((id) => (
            <span key={id} className="bf-ref bf-ref--exception">{id}</span>
          ))}
          {item.refs?.prs?.map((pr) => (
            <span key={pr} className="bf-ref">{pr}</span>
          ))}
        </div>
      )}
    </Node>
  );
}

function Lane({ lane, viewport, toggle }) {
  return (
    <section className="bf-lane">
      <header className="bf-lane__head">
        <h3>{lane.label}</h3>
        <div className="bf-lane__meta">
          <span>{agoLabel(lane.lastSeen)}</span>
          <span>{lane.total} total</span>
        </div>
        <div className="bf-lane__links">
          {/* The lane's two conversations: the loop that is running, and the
              frozen original it was branched from. */}
          {lane.autoRunUrl && (
            <a href={lane.autoRunUrl} target="_blank" rel="noreferrer noopener">Auto Run ↗</a>
          )}
          {lane.seedUrl && (
            <a href={lane.seedUrl} target="_blank" rel="noreferrer noopener" title="The frozen original this lane was branched from">Seed ↗</a>
          )}
        </div>
      </header>

      {lane.records.length === 0 && <p className="bf-note">No must-reads recorded for this lane.</p>}

      {lane.records.map((record) => (
        <article className="bf-record" key={record.id}>
          <div className="bf-record__stamp">
            {agoLabel(record.emittedAt)}
            {record.provenance === "backfilled-from-log" && (
              <span className="bf-record__prov" title={record.sourceRef || "reconstructed from an ops log"}>
                reconstructed
              </span>
            )}
          </div>
          {record.items.map((item) => (
            <MustReadItem
              key={item.nodeId}
              item={item}
              open={viewport.isExpanded(item.nodeId)}
              onToggle={() => toggle(item.nodeId)}
            />
          ))}
        </article>
      ))}

      {lane.hiddenCount > 0 && (
        <p className="bf-lane__hidden">
          {lane.hiddenCount.toLocaleString()} earlier must-read{lane.hiddenCount === 1 ? "" : "s"} not shown
        </p>
      )}
    </section>
  );
}

function EmptyBriefing() {
  return (
    <main className="bf-empty">
      <strong>{config.siteName} / Catch-up</strong>
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

  const toggle = useCallback(
    (id) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        // Expansion is a navigation act, so it goes in history — Back closes
        // what Enter opened, which is what a reader expects from a disclosure.
        writeBriefingLocation({ expanded: next, latest, laneFilter }, "push");
        return next;
      });
    },
    [latest, laneFilter],
  );

  const setPerLane = useCallback(
    (value) => {
      setLatest(value);
      writeBriefingLocation({ expanded, latest: value, laneFilter }, "replace");
    },
    [expanded, laneFilter],
  );

  const { totals } = viewport;

  return (
    <main className="bf-root">
      <header className="bf-top">
        <div className="bf-brand">{config.siteName} <span>/ Catch-up</span></div>
        <div className="bf-top__stamp">
          {viewport.generatedAtLocal
            ? `as at ${viewport.generatedAtLocal.slice(0, 16).replace("T", " ")} Sydney`
            : ""}
        </div>
        <div className="bf-top__actions">
          <label className="bf-perlane">
            latest
            <select value={viewport.perLane} onChange={(event) => setPerLane(Number(event.target.value))}>
              {[1, 2, 3, 5].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            per lane
          </label>
          <a href="?view=continuity">Continuity ↗</a>
        </div>
      </header>

      <section className="bf-section bf-section--actions">
        <h2>
          Needs you
          <span className="bf-count">
            {totals.ownerActions}
            {totals.high ? ` · ${totals.high} high` : ""}
          </span>
        </h2>
        {viewport.ownerActions.length === 0 && <p className="bf-note">Nothing is blocked on you.</p>}
        {viewport.ownerActions.map((action) => (
          <OwnerAction
            key={action.nodeId}
            action={action}
            open={viewport.isExpanded(action.nodeId)}
            onToggle={() => toggle(action.nodeId)}
          />
        ))}
      </section>

      <section className="bf-section bf-section--lanes">
        <h2>
          Lanes
          <span className="bf-count">{viewport.lanes.length}</span>
        </h2>
        {laneFilter && (
          <button type="button" className="bf-clear" onClick={() => {
            setLaneFilter(null);
            writeBriefingLocation({ expanded, latest, laneFilter: null }, "push");
          }}>
            showing one lane — show all
          </button>
        )}
        <div className="bf-lanes">
          {viewport.lanes.map((lane) => (
            <Lane key={lane.lane} lane={lane} viewport={viewport} toggle={toggle} />
          ))}
        </div>
      </section>
    </main>
  );
}

export default function BriefingView() {
  const data = store.briefing;
  if (!data?.lanes && !data?.ownerActions) return <EmptyBriefing />;
  return <BriefingSurface data={data} />;
}

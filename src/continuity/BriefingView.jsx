import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";
import { actionsAvailable, recordAction } from "./actions.js";
import {
  agoLabel,
  awayLabel,
  buildScene,
  buildUrl,
  effortLabel,
  parentPath,
  readLocation,
  resolveDeferPreset,
  writeLocation,
} from "./briefing.js";

// The catch-up surface — spec v1 (governing lane, 2026-08-21).
//
// Selection RECENTERS. It does not expand. The whole scene is recomposed around
// the selected node, and at most 5 nodes are ever on screen. The previous
// version opened a card inside a still-dense list, which the spec names as the
// defining defect: "click node → node becomes the semantic center → old
// siblings disappear/merge → one compact neighborhood replaces them."
//
// Visual language is unchanged and deliberately so — the spec's verdict was
// "the styling is good; the defect is semantic density".

const BRIEFS = [
  { key: "30s", label: "30 sec" },
  { key: "3m", label: "3 min" },
  { key: "full", label: "Full" },
];

const DEFER_PRESETS = ["1 hour", "Tonight", "Tomorrow"];
const REPLY_CHIPS = ["Done", "No", "Need context"];

const SEVERITY_LABEL = { high: "High", medium: "Med", low: "Low" };

function useMeasuredThreads(deps) {
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

  return [containerRef, ringRef, geometry];
}

function ThreadFan({ geometry, origin, enabled }) {
  // No fan at entry: with no origin node the curves degrade into a vertical
  // chain that implies a sequence the roots do not have.
  if (!enabled || geometry.points.length < 2) return null;
  const { x: ox, y: oy } = origin;
  return (
    <svg className="bf-threads" width={geometry.width} height={geometry.height} aria-hidden="true">
      {geometry.points.map(({ key, x, y }) => {
        const mid = ox + (x - ox) * 0.55;
        return <path key={key} className="bf-thread" d={`M ${ox} ${oy} C ${mid} ${oy}, ${mid} ${y}, ${x - 13} ${y}`} />;
      })}
    </svg>
  );
}

function Node({ node, onSelect, refCallback, focal }) {
  const interactive = Boolean(onSelect);
  const activate = (event) => {
    if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelect();
  };
  return (
    <div
      className={`bf-node bf-node--${node.kind}${node.dim ? " bf-node--dim" : ""}${focal ? " bf-node--focal" : ""}`}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={activate}
      aria-label={interactive ? `Select ${node.label}` : undefined}
    >
      <span
        ref={refCallback}
        className={`bf-ring bf-ring--${node.status}${node.dashed ? " bf-ring--dashed" : ""}${focal ? " bf-ring--focal" : ""}`}
        aria-hidden="true"
      >
        <span className="bf-ring__core" />
      </span>
      <span className="bf-node__text">
        <span className="bf-node__label">{node.label}</span>
        {(node.sub || node.at || node.severity) && (
          <span className="bf-node__sub">
            {node.severity && <em className={`bf-sev bf-sev--${node.severity}`}>{SEVERITY_LABEL[node.severity]}</em>}
            {node.sub}
            {node.at ? `${node.sub ? " · " : ""}${agoLabel(node.at)}` : ""}
          </span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The CTA row (spec §5.1 / §6). Exactly four affordances, and the source is a
// link rather than a fifth button.
// ---------------------------------------------------------------------------

function CTA({ action, onDone }) {
  const [mode, setMode] = useState(null);        // null | 'reply' | 'defer' | 'dismiss'
  const [text, setText] = useState("");
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (mode === "reply") inputRef.current?.focus();
  }, [mode]);

  if (!actionsAvailable()) {
    return <p className="bf-note">Read-only — launch with <code>node D:/Projects/.tools/catchup.mjs</code> to act from here.</p>;
  }

  if (result) {
    return (
      <p className="bf-note bf-note--ok">
        {result.resumesNextTick
          ? `Ruling saved · ${result.loop || "the lane"} resumes next tick`
          : `Ruling sent → ${result.loop || "the lane"}`}
      </p>
    );
  }

  async function run(kind, payload = {}) {
    setError(null);
    setPending(kind);
    try {
      const response = await recordAction({ id: action.id, action: kind, ...payload });
      setResult({ loop: action.loop, resumesNextTick: true });
      onDone?.(response);
    } catch (err) {
      // Never silently lose a ruling: the composer keeps its text.
      setError(err.message || String(err));
    } finally {
      setPending(null);
    }
  }

  const hasProposed = Boolean(String(action.proposed || "").trim());

  return (
    <div className="bf-cta">
      <div className="bf-cta__row">
        {hasProposed && (
          <button type="button" className="bf-cta__btn bf-cta__btn--approve" disabled={Boolean(pending)}
            onClick={() => run("approve")}>
            {pending === "approve" ? "…" : "Approve proposed"}
          </button>
        )}
        <button type="button" className={`bf-cta__btn${mode === "reply" ? " bf-cta__btn--on" : ""}`}
          onClick={() => setMode(mode === "reply" ? null : "reply")}>Reply…</button>
        <button type="button" className={`bf-cta__btn${mode === "defer" ? " bf-cta__btn--on" : ""}`}
          onClick={() => setMode(mode === "defer" ? null : "defer")}>Defer</button>
        <button type="button" className={`bf-cta__btn bf-cta__btn--more${mode === "dismiss" ? " bf-cta__btn--on" : ""}`}
          aria-label="More actions"
          onClick={() => setMode(mode === "dismiss" ? null : "dismiss")}>⋯</button>
      </div>

      {mode === "reply" && (
        <div className="bf-cta__panel">
          <div className="bf-chips">
            {REPLY_CHIPS.map((chip) => (
              <button key={chip} type="button" className="bf-chip" disabled={Boolean(pending)}
                onClick={() => run("reply", { note: chip })}>{chip}</button>
            ))}
          </div>
          <input
            ref={inputRef}
            className="bf-cta__note"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter submits; Shift+Enter is a line break (spec §5.1).
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (text.trim()) run("reply", { note: text });
              }
            }}
            placeholder="your reply, persisted verbatim"
            aria-label="Your reply"
          />
        </div>
      )}

      {mode === "defer" && (
        <div className="bf-cta__panel bf-chips">
          {DEFER_PRESETS.map((preset) => (
            <button key={preset} type="button" className="bf-chip" disabled={Boolean(pending)}
              onClick={() => run("defer", { until: resolveDeferPreset(preset).toISOString(), note: preset })}>
              {preset}
            </button>
          ))}
        </div>
      )}

      {mode === "dismiss" && (
        <div className="bf-cta__panel bf-chips">
          {/* Two clicks, no modal (spec §5.1). */}
          <button type="button" className="bf-chip bf-chip--danger" disabled={Boolean(pending)}
            onClick={() => run("dismiss", { note: text || "not needed" })}>Confirm dismiss</button>
          <span className="bf-note">Dismiss as not needed</span>
        </div>
      )}

      {error && <p className="bf-note bf-note--warn">{error}</p>}
    </div>
  );
}

function OwnerCard({ action, onDone }) {
  const hints = action.steps || [];
  return (
    <div className="bf-card">
      <div className="bf-card__eyebrow">
        Decision · {action.loop || "unfiled"}
        {action.severity && <em className={`bf-sev bf-sev--${action.severity}`}>{SEVERITY_LABEL[action.severity]}</em>}
        <span>{effortLabel(action.estimatedSeconds)}</span>
        <span>{agoLabel(action.updated)}</span>
      </div>
      <h2 className="bf-card__title">{action.title}</h2>

      {action.proposed && (
        <div className="bf-card__section">
          <h3>Proposed action</h3>
          <p className="bf-verbatim">{action.proposed}</p>
        </div>
      )}

      {/* CTA sits ABOVE provenance: the spec forbids making her open details
          before she can act. */}
      <CTA action={action} onDone={onDone} />

      {hints.length > 0 && (
        <div className="bf-card__section">
          <h3>Hints <small>derived from prose · not an authoritative checklist</small></h3>
          <ul className="bf-hints">
            {hints.map((hint, index) => (
              <li key={hint.n ?? index}><span className="bf-hint__tag">HINT</span>{hint.text}</li>
            ))}
          </ul>
        </div>
      )}

      {action.latestAmendment && (
        <details className="bf-more">
          <summary>Latest amendment{action.amendmentCount > 1 ? ` (${action.amendmentCount})` : ""}</summary>
          <p className="bf-verbatim">{action.latestAmendment}</p>
        </details>
      )}

      <div className="bf-card__foot">{action.id}</div>
    </div>
  );
}

function RecordCard({ item }) {
  return (
    <div className="bf-card">
      <div className="bf-card__eyebrow">{item.facet}<span>{agoLabel(item.at)}</span></div>
      <h2 className="bf-card__title">{item.title}</h2>
      {item.detail && <p className="bf-verbatim">{item.detail}</p>}
      {(item.links?.length > 0 || item.refs?.exceptions?.length > 0 || item.refs?.prs?.length > 0) && (
        <div className="bf-refs">
          {item.links?.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener">{link.text} ↗</a>)}
          {item.refs?.exceptions?.map((id) => <span key={id} className="bf-ref bf-ref--exception">{id}</span>)}
          {item.refs?.prs?.map((pr) => <span key={pr} className="bf-ref">{pr}</span>)}
        </div>
      )}
    </div>
  );
}

function HintCard({ card, onNav }) {
  return (
    <div className="bf-card">
      <div className="bf-card__eyebrow">HINT · derived from the filing lane's prose</div>
      <h2 className="bf-card__title">{card.hint?.text || "—"}</h2>
      {card.hint?.command && <div className="bf-step__cmd"><code>{card.hint.command}</code></div>}
      {card.hint?.href && <a className="bf-step__link" href={card.hint.href} target="_blank" rel="noreferrer noopener">{card.hint.href} ↗</a>}
      <p className="bf-note">Not an authoritative checklist. Selecting a hint never changes state.</p>
      {card.total > 1 && (
        <div className="bf-hintnav">
          <button type="button" disabled={card.index === 0} onClick={() => onNav(card.index - 1)}>← previous hint</button>
          <span>{card.index + 1} / {card.total}</span>
          <button type="button" disabled={card.index >= card.total - 1} onClick={() => onNav(card.index + 1)}>next hint →</button>
        </div>
      )}
    </div>
  );
}

function Stars() {
  const stars = useMemo(() => {
    const out = [];
    let seed = 20260817;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 80; i++) {
      out.push({ left: `${(rand() * 100).toFixed(2)}%`, top: `${(rand() * 100).toFixed(2)}%`, size: rand() > 0.85 ? 2 : 1, opacity: 0.1 + rand() * 0.28 });
    }
    return out;
  }, []);
  return (
    <div className="bf-stars" aria-hidden="true">
      {stars.map((s, i) => <span key={i} style={{ left: s.left, top: s.top, width: s.size, height: s.size, opacity: s.opacity }} />)}
    </div>
  );
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
  const initial = useMemo(() => readLocation(window.location.href), []);
  const [path, setPath] = useState(initial.path);
  const [brief, setBrief] = useState(initial.brief);
  const [page, setPage] = useState(initial.page);
  const [liveActions, setLiveActions] = useState(null);
  const [showDeferred, setShowDeferred] = useState(false);

  useEffect(() => {
    const restore = () => {
      const next = readLocation(window.location.href);
      setPath(next.path);
      setBrief(next.brief);
      setPage(next.page);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const effective = useMemo(
    () => (liveActions ? { ...data, ownerActions: liveActions } : data),
    [data, liveActions],
  );

  const scene = useMemo(
    () => buildScene(effective, { path, brief, page }),
    [effective, path, brief, page],
  );

  const go = useCallback((nextPath, mode = "push") => {
    setPath(nextPath);
    setPage(0);
    writeLocation({ path: nextPath, brief, page: 0 }, mode);
  }, [brief]);

  const setBriefPreset = useCallback((key) => {
    setBrief(key);
    writeLocation({ path, brief: key, page }, "replace");
  }, [path, page]);

  const turnPage = useCallback((delta) => {
    const next = Math.max(0, page + delta);
    setPage(next);
    writeLocation({ path, brief, page: next }, "replace");
  }, [path, brief, page]);

  const [containerRef, ringRef, geometry] = useMeasuredThreads([scene.nodes.length, scene.path, scene.card]);
  const origin = { x: 64, y: Math.max(70, geometry.height / 2) };

  // Keyboard: Escape climbs one semantic level (spec §11).
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && scene.path) {
        event.preventDefault();
        go(parentPath(scene.path));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scene.path, go]);

  const hasOrigin = scene.nodes.some((n) => n.kind === "origin" || n.kind === "parent");
  const away = awayLabel(data.lanes || []);
  const { counts } = scene;

  const onRuled = useCallback((response) => {
    // Render the server's rebuilt queue; never optimistically remove an item.
    if (response?.ownerActions) setLiveActions(response.ownerActions);
  }, []);

  return (
    <main className="bf-root">
      <Stars />

      <header className="bf-top">
        <div className="bf-brand"><span className="bf-brand__dot" />{config.siteName} <span>/ Continuity</span></div>
        <div className="bf-away">
          {away ? <>You were away for <b>{away}</b></> : "Catch-up"}
          <small>
            {" "}· {counts.dueNow} need you now
            {counts.deferred ? ` · ${counts.deferred} deferred` : ""}
            {" "}· {counts.lanes} lanes changed · {counts.records.toLocaleString()} source records hidden
          </small>
        </div>
        <div className="bf-top__actions">
          <div className="bf-briefsel" role="group" aria-label="Brief me in">
            <span>Brief me in:</span>
            {BRIEFS.map((preset) => (
              <button key={preset.key} type="button"
                className={brief === preset.key ? "bf-briefsel--active" : ""}
                onClick={() => setBriefPreset(preset.key)}>{preset.label}</button>
            ))}
          </div>
          <a href="?view=continuity">Continuity ↗</a>
        </div>
      </header>

      {scene.breadcrumb.length > 0 && (
        <nav className="bf-crumbs" aria-label="Semantic position">
          {scene.breadcrumb.map((crumb, index) => (
            <span key={crumb.path || "root"}>
              {index > 0 && <i>›</i>}
              <button type="button" onClick={() => go(crumb.path)}>{crumb.label}</button>
            </span>
          ))}
        </nav>
      )}

      {/* Without a card the stage is a single centred column — the spec warns
          against "an enormous empty right-side stage". */}
      <section className={`bf-stage${scene.card ? "" : " bf-stage--nocard"}`} ref={containerRef}>
        <ThreadFan geometry={geometry} origin={origin} enabled={hasOrigin} />
        <div className="bf-stage__nodes">
          {scene.nodes.map((n) => (
            <Node
              key={n.key}
              node={n}
              focal={n.kind === "focus"}
              refCallback={ringRef(n.key)}
              onSelect={n.kind === "focus" || n.kind === "absent" ? undefined : () => go(n.path)}
            />
          ))}
        </div>

        {scene.card?.kind === "owner_action" && <OwnerCard action={scene.card.action} onDone={onRuled} />}
        {scene.card?.kind === "record" && <RecordCard item={scene.card.item} />}
        {scene.card?.kind === "hint" && (
          <HintCard card={scene.card} onNav={(i) => go(`${parentPath(scene.path)}/hint/${i}`, "replace")} />
        )}
      </section>

      <footer className="bf-bottom">
        <div className="bf-bottomleft">
          {scene.hidden > 0 && scene.pageCount > 1 && (
            <div className="bf-pager">
              <button type="button" onClick={() => turnPage(-1)} aria-label="Previous page">‹</button>
              <span>+ {scene.hidden} quieter · {scene.page + 1}/{scene.pageCount}</span>
              <button type="button" onClick={() => turnPage(1)} aria-label="Next page">›</button>
            </div>
          )}
          {counts.deferred > 0 && (
            <button type="button" className="bf-deferred" onClick={() => setShowDeferred((v) => !v)}>
              {counts.deferred} deferred
            </button>
          )}
        </div>
        <div className="bf-detaildial" role="group" aria-label="Semantic resolution">
          <button type="button" onClick={() => go(parentPath(scene.path))} disabled={!scene.path} aria-label="Less detail">−</button>
          <span>less</span>
          <span className="bf-detaildial__dots">
            {["entry", "z0", "z1", "z2"].map((lvl, i) => (
              <i key={lvl} className={["entry", "z0", "z1", "z2", "z3", "z4"].indexOf(scene.level) >= i ? "on" : ""} />
            ))}
          </span>
          <span>more detail</span>
          <button type="button" aria-label="More detail"
            disabled={!scene.nodes.some((n) => n.kind !== "origin" && n.kind !== "parent" && n.kind !== "focus")}
            onClick={() => {
              const first = scene.nodes.find((n) => n.kind !== "origin" && n.kind !== "parent" && n.kind !== "focus");
              if (first) go(first.path);
            }}>+</button>
        </div>
      </footer>

      {showDeferred && (
        <aside className="bf-deferpanel">
          <h3>Deferred · {scene.deferredActions.length}</h3>
          {scene.deferredActions.map((a) => (
            <div key={a.id} className="bf-deferpanel__row">
              <span>{a.title}</span>
              <small>until {String(a.deferredUntil || "").slice(0, 16).replace("T", " ")}</small>
            </div>
          ))}
          <button type="button" onClick={() => setShowDeferred(false)}>close</button>
        </aside>
      )}
    </main>
  );
}

export default function BriefingView() {
  const data = store.briefing;
  if (!data?.lanes && !data?.ownerActions) return <EmptyBriefing />;
  return <BriefingSurface data={data} />;
}

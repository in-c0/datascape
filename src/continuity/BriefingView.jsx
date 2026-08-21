import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { store } from "../store.js";
import { config } from "../../datascape.config.js";
import { actionsAvailable, recordAction } from "./actions.js";
import Authored from "./authored.jsx";
import TemporalStage, { MARGIN_X, STAGE_RIGHT } from "./TemporalStage.jsx";
import { excerptAuthored, parseAuthored } from "./authored.js";
import { temporalAnchor, timeScale } from "./briefing.js";
import {
  agoLabel,
  awayLabel,
  spansNight,
  buildScene,
  buildUrl,
  effortLabel,
  excerpt,
  nextDueInBucket,
  parentPath,
  parsePath,
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

/** The run that was open at `at`, if any. */
function runContaining(runs, at, now) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return (runs || []).find((r) => {
    const a = Date.parse(r.startedAt);
    const live = r.execution === "live" || !r.endedAt;
    const b = live ? now : Date.parse(r.endedAt);
    return Number.isFinite(a) && Number.isFinite(b) && t >= a - 1000 && t <= b + 1000;
  }) || null;
}

// Which placed kinds read as the branch origin rather than a leaf.
const FOCAL_PLACED = new Set(["origin", "focus"]);

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

function Node({ node, onSelect, refCallback, focal, keyboard, now }) {
  const interactive = Boolean(onSelect);
  const activate = (event) => {
    if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelect();
  };
  return (
    <div
      className={
        `bf-node bf-node--${node.kind}` +
        (node.dim ? " bf-node--dim" : "") +
        (focal ? " bf-node--focal" : "") +
        (keyboard ? " bf-node--kb" : "") +
        // Orthogonal visual state (spec v2 §2): execution animates, supervision
        // encloses. Neither ever recolours the semantic status ring, which keeps
        // meaning Needs you / Finding / Progress / State.
        (node.execution ? ` bf-exec--${node.execution}` : "") +
        // No enclosure around the node itself: v2 drew a rounded card here and
        // it read as "a card for an autonomous session", which the spec
        // rejected. The envelope now lives on the temporal axis, where its
        // width actually means something.
        (node.supervision === "unknown" ? " bf-supervision--unknown" : "")
      }
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
        {/* v2.3 ruling: a node whose position and envelope already say when and
            how carries no time subtitle. `quiet` is set by the model for a
            temporally grounded unattended node; a node stranded in the
            non-temporal margin keeps a plain age, because nothing else can say
            when — and it still never claims attended or unattended. */}
        {(node.sub || (node.at && !node.quiet) || node.severity) && (
          <span className="bf-node__sub">
            {node.severity && <em className={`bf-sev bf-sev--${node.severity}`}>{SEVERITY_LABEL[node.severity]}</em>}
            {node.sub}
            {node.at && !node.quiet ? `${node.sub ? " · " : ""}${agoLabel(node.at, now)}` : ""}
            {/* No overnight pill at entry: once the run occupies the night
                portion of the axis, position carries the meaning. */}
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

function CTA({ action, onDone, api }) {
  const [mode, setMode] = useState(null);        // null | 'reply' | 'defer' | 'dismiss'
  const [text, setText] = useState("");
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (mode === "reply") inputRef.current?.focus();
  }, [mode]);

  // Publish the keyboard handles (spec §11: A / R / D). Registered only while a
  // Z2 owner card is mounted, so the shortcuts cannot fire from anywhere else.
  const hasProposedAction = Boolean(String(action.proposed || "").trim());
  useEffect(() => {
    if (!api) return undefined;
    api.current = {
      approve: () => { if (hasProposedAction && !result) run("approve"); },
      openReply: () => { if (!result) setMode("reply"); },
      openDefer: () => { if (!result) setMode("defer"); },
    };
    return () => { api.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, action.id, hasProposedAction, result]);

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

  const hasProposed = hasProposedAction;

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

function OwnerCard({ action, onDone, api }) {
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
          <Authored text={action.proposed} />
        </div>
      )}

      {/* CTA sits ABOVE provenance: the spec forbids making her open details
          before she can act. */}
      <CTA action={action} onDone={onDone} api={api} />

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
          <Authored text={action.latestAmendment} />
        </details>
      )}

      <div className="bf-card__foot">{action.id}</div>
    </div>
  );
}

// A non-owner record at Z2 shows a BOUNDED verbatim excerpt, not the whole
// authored record. The visual review's P1: the graph stopped being overloaded
// but one node reintroduced the same overload inside its card. The full text is
// one semantic level deeper — still verbatim, never summarised.
function RecordCard({ item, full, onOpenFull }) {
  // Parse first, then truncate the TREE. Slicing the raw Markdown and parsing
  // the slice could cut through an inline span and strand a `**` in the prose —
  // manufacturing the very delimiter noise the presentation pass removes.
  const body = full
    ? { blocks: parseAuthored(item.detail), truncated: false }
    : excerptAuthored(item.detail);
  return (
    <div className="bf-card">
      <div className="bf-card__eyebrow">{item.facet}<span>{agoLabel(item.at)}</span>{full && <span>full record</span>}</div>
      <h2 className="bf-card__title">{item.title}</h2>
      {body.blocks.length > 0 && <Authored nodes={body.blocks} />}
      {body.truncated && (
        <button type="button" className="bf-readfull" onClick={onOpenFull}>
          Read full authored record →
        </button>
      )}
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
    () => buildScene(
      initial.since ? { ...effective, ownerLastPresentAt: initial.since } : effective,
      { path, brief, page, ...(initial.now ? { now: initial.now } : {}) },
    ),
    [effective, path, brief, page],
  );

  const go = useCallback((nextPath, mode = "push") => {
    setPath(nextPath);
    setPage(0);
    writeLocation({ path: nextPath, brief, page: 0 }, mode);
  }, [brief]);

  // An invalid or stale semantic URL resolves to its nearest valid ancestor,
  // and the URL is REPLACED rather than pushed — so Back returns to wherever
  // she actually came from instead of bouncing through the broken address.
  useEffect(() => {
    if (scene.redirect == null || scene.redirect === path) return;
    setPath(scene.redirect);
    setPage(0);
    writeLocation({ path: scene.redirect, brief, page: 0 }, "replace");
  }, [scene.redirect, path, brief]);

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

  // Split the scene into the focal column and its children. Z2 keeps its single
  // column (that screenshot passed review); Z0/Z1 get the corrected geometry.
  const focalNodes = scene.nodes.filter((n) => n.kind === "origin");
  const childNodes = scene.nodes.filter((n) => n.kind !== "origin");
  const hasFocalColumn = focalNodes.length > 0;
  const hasPlacedOrigin = focalNodes.length > 0;
  // Declared here, above temporalRows, which reads it. It used to sit further
  // down and the memo hit the temporal dead zone, blanking the whole surface
  // with no console error the probe was armed to catch.
  const sceneNow = initial.now || Date.now();

  // Place entry roots on the shared temporal scale. A node whose provenance is
  // untrustworthy gets NO temporal position — it sits in the non-temporal
  // margin rather than being assigned a fake time.
  const temporalRows = useMemo(() => {
    if (!scene.timeline) return [];
    const scale = timeScale({
      from: scene.timeline.from, to: scene.timeline.to, width: STAGE_RIGHT - MARGIN_X,
    });
    const ROW = 92;
    const rows = scene.nodes.map((n, index) => {
      // v2.3: every level is placed, not just entry. A lane view that fell
      // back to a column had no node inside its own envelope, so the envelope
      // read as a free-floating run bar again.
      const at = temporalAnchor(n, sceneNow);
      const x = at ? scale.x(at) : null;
      // A node without its own run still belongs to whichever run was open
      // when its material change happened. That is what lets one envelope
      // enclose a whole visible branch instead of only its origin.
      const runId = n.run?.id || (at ? runContaining(scene.timeline.runs, at, sceneNow)?.id : null) || null;
      return {
        key: n.key,
        laneKey: n.key,
        runId,
        node: n,
        at,
        x: x == null ? 24 : MARGIN_X + x,
        y: 96 + index * ROW,
        temporal: x != null,
      };
    });
    // Mobile reflows vertically and the field carries an orientation cue that
    // claims top = older, bottom = newer. That claim has to be TRUE, so each
    // row carries its rank in time; the mobile stylesheet orders by it while
    // desktop ignores it and keeps y = semantic topology.
    const ranked = rows.filter((r) => r.temporal).slice()
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return rows.map((r) => ({
      ...r,
      order: r.temporal ? ranked.findIndex((x) => x.key === r.key) + 1 : 0,
    }));
  }, [scene.timeline, scene.nodes, sceneNow]);
  const focalPoint = geometry.points.find((p) => p.key === focalNodes[0]?.key)
    || { x: 64, y: Math.max(70, geometry.height / 2) };

  // ---- keyboard (spec §11) ----
  const selectable = scene.nodes.filter((n) => n.kind !== "focus" && n.kind !== "absent" && n.kind !== "origin");
  const [kbIndex, setKbIndex] = useState(-1);
  const kbKey = selectable[kbIndex]?.key ?? null;
  const ctaApi = useRef(null);

  useEffect(() => { setKbIndex(-1); }, [scene.path]);

  useEffect(() => {
    const onKey = (event) => {
      // Never steal keys from a composer the owner is typing in.
      const tag = String(event.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || event.target?.isContentEditable) {
        if (event.key === "Escape") event.target.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "Escape") {
        if (scene.path) { event.preventDefault(); go(parentPath(scene.path)); }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        if (!selectable.length) return;
        event.preventDefault();
        setKbIndex((i) => Math.min(selectable.length - 1, i + 1));
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        if (!selectable.length) return;
        event.preventDefault();
        setKbIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === "Enter") {
        const target = selectable[kbIndex];
        if (target) { event.preventDefault(); go(target.path); }
        return;
      }
      // A/R/D act on the focused Z2 owner card only. A destructive dismiss is
      // deliberately absent from the keyboard map.
      if (!ctaApi.current) return;
      const key = event.key.toLowerCase();
      if (key === "a") { event.preventDefault(); ctaApi.current.approve(); }
      else if (key === "r") { event.preventDefault(); ctaApi.current.openReply(); }
      else if (key === "d") { event.preventDefault(); ctaApi.current.openDefer(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scene.path, go, selectable, kbIndex]);

  const away = awayLabel(data.lanes || [], sceneNow, initial.since || data.ownerLastPresentAt);
  const { counts } = scene;

  // §9 auto-advance: after a ruling, focus the next due decision in the same
  // bucket so clearing ten reads "read → click → read → click" instead of
  // returning to a list between each one.
  const onRuled = useCallback((response) => {
    // Render the server's rebuilt queue; never optimistically remove an item.
    const fresh = response?.ownerActions || null;
    if (fresh) setLiveActions(fresh);
    const position = parsePath(scene.path);
    if (position.kind !== "needs" || !position.bucket) return;
    const next = nextDueInBucket(fresh || data.ownerActions || [], position.bucket, position.record);
    setTimeout(() => {
      if (next) go(`needs/${position.bucket}/${next.id}`, "replace");
      else {
        // Bucket cleared: step up rather than leaving her on a dead node.
        const remaining = (fresh || []).length;
        go(remaining ? "needs" : "", "replace");
      }
    }, 700);
  }, [scene.path, go, data.ownerActions]);

  return (
    <main className="bf-root">
      {/* Background context, not content: the local phase of day under the
          decision space. No geolocation — the spec forbids exposing precise
          location in rendered Continuity state. */}
      <div className={`bf-temporal bf-temporal--${scene.phase}`} aria-hidden="true" />
      <Stars />

      <header className="bf-top">
        <div className="bf-brand"><span className="bf-brand__dot" />{config.siteName} <span>/ Continuity</span></div>
        <div className="bf-away">
          {away ? <>You were away for <b>{away}</b></> : "Catch-up"}
          {/* Only clauses with a non-zero count appear, so the line says nothing
              about unattended work on a day when none happened (spec v2 §5). */}
          {scene.away.clauses.length > 0 && <small> · {scene.away.clauses.join(" · ")}</small>}
          {counts.deferred > 0 && <small> · {counts.deferred} deferred</small>}
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
        <nav className={`bf-crumbs${["z0","z1"].includes(scene.level) ? " bf-crumbs--secondary" : ""}`} aria-label="Semantic position">
          {scene.breadcrumb.map((crumb, index) => (
            <span key={crumb.path || "root"}>
              {index > 0 && <i>›</i>}
              <button type="button" onClick={() => go(crumb.path)}>{crumb.label}</button>
            </span>
          ))}
        </nav>
      )}

      {/* The stage IS the temporal field — no strip above it, no card edge.
          x = when, y = semantic topology. */}
      <section
        className={`bf-stage${scene.card ? "" : " bf-stage--nocard"}${scene.timeline ? " bf-stage--temporal" : ""}`}
        ref={containerRef}
        // The field ends where the content ends. A fixed 620px stage left a
        // third of the screen as empty gradient with a hard edge under it,
        // which read as a panel again.
        style={scene.timeline ? { minHeight: temporalRows.length ? Math.max(...temporalRows.map((r) => r.y)) + 150 : 260 } : undefined}
      >
        {scene.timeline && <TemporalStage timeline={scene.timeline} rows={temporalRows} />}
        <ThreadFan geometry={geometry} origin={focalPoint} enabled={hasFocalColumn || hasPlacedOrigin} />
        {/* The focal node IS the fan origin, in its own column. Drawing it as
            the first child (with the fan starting from an invisible point) was
            the visual review's P0: the eye could not tell what it was inside. */}
        {temporalRows.length > 0 ? (
          <div className="bf-placed">
            {temporalRows.map(({ key, node: n, x, y, temporal, order }) => (
              <div
                key={key}
                className={`bf-placed__node${temporal ? "" : " bf-placed__node--atemporal"}`}
                style={{ left: x, top: y, "--t-order": order }}
              >
                <Node
                  node={n}
                  focal={FOCAL_PLACED.has(n.kind)}
                  now={sceneNow}
                  keyboard={kbKey === n.key}
                  refCallback={ringRef(n.key)}
                  onSelect={n.kind === "focus" || n.kind === "absent" ? undefined : () => go(n.path)}
                />
              </div>
            ))}
          </div>
        ) : (
        <div className={`bf-stage__nodes${hasFocalColumn ? " bf-stage__nodes--split" : ""}`}>
          {hasFocalColumn && (
            <div className="bf-focalcol">
              {focalNodes.map((n) => (
                <Node
                  key={n.key}
                  node={n}
                  focal
                  now={sceneNow}
                  keyboard={kbKey === n.key}
                  refCallback={ringRef(n.key)}
                  onSelect={n.kind === "focus" || n.kind === "absent" ? undefined : () => go(n.path)}
                />
              ))}
            </div>
          )}
          <div className="bf-childcol">
            {(hasFocalColumn ? childNodes : scene.nodes).map((n) => (
              <Node
                key={n.key}
                node={n}
                focal={!hasFocalColumn && n.kind === "focus"}
                now={sceneNow}
                keyboard={kbKey === n.key}
                refCallback={ringRef(n.key)}
                onSelect={n.kind === "focus" || n.kind === "absent" ? undefined : () => go(n.path)}
              />
            ))}
          </div>
        </div>
        )}

        {scene.card?.kind === "owner_action" && <OwnerCard action={scene.card.action} onDone={onRuled} api={ctaApi} />}
        {scene.card?.kind === "record" && (
          <RecordCard
            item={scene.card.item}
            full={scene.level === "z3"}
            onOpenFull={() => go(scene.path + "/full")}
          />
        )}
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

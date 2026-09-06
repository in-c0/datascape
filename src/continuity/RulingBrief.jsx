// RulingBrief — the owner queue as DECISIONS ("The Ruling Brief", design/DESIGN.md).
//
// Owner directive 2026-09-06: "build the triage view". Six behaviours, none of
// them a new owner surface (SESSIONS.md rule 3): at most three answers per ask
// as buttons; grouping by decision; an overtaken strip with one batch dismiss;
// cost-of-delay order capped at seven with the rest folded by kind; the ask in
// plain words with what a yes and a no cost; one screen on the PC, one thumb
// scroll on the phone.
//
// Every button is one of the six EXISTING ruling classes queued into the
// EXISTING tray (batch-queue.js). Nothing here talks to the host; the tray's
// "Apply N — one confirm" does, through the same batch endpoint and the same
// Windows prompt. With no action API (the phone build) the sheet renders
// read-only and says so once.
//
// The data is `triage` from the briefing document (composed by
// _ship_inbox/ops/triage.mjs), never recomputed here: the CLI card, the JSON
// and this sheet can therefore never rank or group differently.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ACTION_API, actionsAvailable } from "./actions.js";
import { rulingTray } from "./batch-queue.js";
import { resolveDeferPreset } from "./briefing.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const shortId = (id) => String(id || "").slice(-4);

/** "Sunday 6 Sep" in Sydney, whatever the viewer's clock says. */
function sydneyDayLabel(now = new Date()) {
  // en-US only for the three-letter month ("Sep", not en-AU's "Sept"); the
  // day-first order is assembled by hand, so nothing else is American.
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "long", day: "numeric", month: "short", timeZone: "Australia/Sydney",
  }).formatToParts(now).reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

/** One access key per answer: the first letter not already taken in the row. */
function accessKeys(choices) {
  const used = new Set();
  return choices.map((c) => {
    const letters = String(c.label || "").toLowerCase().replace(/[^a-z]/g, "");
    let key = null;
    for (const ch of letters) if (!used.has(ch)) { key = ch; break; }
    if (key) used.add(key);
    return key;
  });
}

/** Draw the queued thread: from the pressed answer's edge to the existing tray. */
function drawThread(fromEl) {
  if (reducedMotion() || !fromEl) return;
  const tray = document.querySelector(".bf-tray");
  if (!tray) return;
  const a = fromEl.getBoundingClientRect();
  const b = tray.getBoundingClientRect();
  const x1 = a.right, y1 = a.top + a.height / 2;
  const x2 = b.left + Math.min(28, b.width / 2), y2 = b.top + b.height / 2;
  const mid = (x1 + x2) / 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "rb-thread");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
  svg.appendChild(path);
  document.body.appendChild(svg);
  const len = path.getTotalLength();
  path.style.strokeDasharray = String(len);
  path.style.strokeDashoffset = String(len);
  const anim = path.animate(
    [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
    { duration: 220, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
  );
  anim.onfinish = () => setTimeout(() => svg.remove(), 320);
}

function Row({ group, index, numeral, live, queued, focused, onRule, onFocusRow }) {
  const keys = useMemo(() => accessKeys(group.choices), [group.choices]);
  const firstButton = useRef(null);
  useEffect(() => { if (focused && live) firstButton.current?.focus(); }, [focused, live]);

  const ids = group.ids.map(shortId).join(" ");
  const settles = group.ids.length > 1 ? `settles ${group.ids.length}: ${ids}` : `settles ${ids}`;
  const meta = [group.loops.join(", "), group.severity, settles]
    .concat(group.oldestDays >= 7 ? [`${group.oldestDays}d open`] : [])
    .concat(group.expires ? [`by ${group.expires}`] : []);

  return (
    <li
      className={`rb-row${queued ? " rb-row--queued" : ""}${focused ? " rb-row--focus" : ""}`}
      role="group"
      aria-label={group.question || group.title}
      data-key={group.key}
      onClick={() => onFocusRow(index)}
    >
      <div className="rb-row__body">
        <div className="rb-row__inner">
          <span className="rb-num" aria-hidden="true">{queued ? "" : numeral}</span>
          <div className="rb-ask">
            <h3 className="rb-q">{group.question || group.title}</h3>
            {(group.yesCosts || group.noCosts) && (
              <dl className="rb-costs">
                {group.yesCosts && <div><dt>yes</dt><dd>{group.yesCosts}</dd></div>}
                {group.noCosts && <div><dt>no</dt><dd>{group.noCosts}</dd></div>}
              </dl>
            )}
            <p className="rb-meta">
              {meta.map((m, i) => (
                <span key={i} className={m === "high" ? "rb-meta__high" : m === "medium" ? "rb-meta__medium" : ""}>
                  {i > 0 && <i> · </i>}{m}
                </span>
              ))}
              {group.question && group.title !== group.question && (
                <span className="rb-meta__title"><i> · </i>{group.title}</span>
              )}
            </p>
          </div>
          {live ? (
            <div className="rb-answers" role="group" aria-label="Answers">
              {group.choices.map((choice, i) => (
                <button
                  key={choice.action}
                  ref={i === 0 ? firstButton : undefined}
                  type="button"
                  className={`rb-pill${i === 0 ? " rb-pill--first" : ""}`}
                  aria-label={`${choice.label} — ${group.question || group.title}`}
                  onClick={(event) => { event.stopPropagation(); onRule(group, choice, event.currentTarget); }}
                >
                  {keys[i] ? (
                    <>
                      {choice.label.slice(0, choice.label.toLowerCase().indexOf(keys[i]))}
                      <u>{choice.label.charAt(choice.label.toLowerCase().indexOf(keys[i]))}</u>
                      {choice.label.slice(choice.label.toLowerCase().indexOf(keys[i]) + 1)}
                    </>
                  ) : choice.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {queued && (
        <p className="rb-docket" aria-live="polite">
          <b>QUEUED</b> · {queued.label} · {group.loops[0]}{group.ids.length > 1 ? ` ×${group.ids.length}` : ""}
          {queued.skipped ? <span className="rb-docket__note"> · {queued.skipped} of {group.ids.length} has no proposal to approve and stays open</span> : null}
        </p>
      )}
    </li>
  );
}

export default function RulingBrief({ triage: initial, onRefresh }) {
  const live = actionsAvailable();
  const [triage, setTriage] = useState(initial);
  useEffect(() => { setTriage(initial); }, [initial]);
  const tray = useSyncExternalStore(rulingTray.subscribe, rulingTray.get, rulingTray.get);
  const [queued, setQueued] = useState(() => new Map());
  const [foldOpen, setFoldOpen] = useState(false);
  const [overtakenOpen, setOvertakenOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const sheetRef = useRef(null);

  const counts = triage?.counts || {};
  const top = triage?.top || [];
  const folded = triage?.folded || [];
  const overtaken = triage?.overtaken || [];
  const visible = useMemo(() => (foldOpen ? top.concat(folded) : top), [top, folded, foldOpen]);

  // Numerals count only the rows still awaiting her: a queued row gives up its
  // number, and the rows below renumber as they slide up (DESIGN.md, motion 3).
  const numerals = useMemo(() => {
    let n = 0;
    return visible.map((g) => (queued.has(g.key) ? null : ++n));
  }, [visible, queued]);

  const refresh = useCallback(async () => {
    if (!ACTION_API) return;
    try {
      const response = await fetch(`${ACTION_API}/api/briefing`);
      if (!response.ok) return;
      const doc = await response.json();
      if (doc?.triage) setTriage(doc.triage);
      setQueued(new Map());
      onRefresh?.(doc);
    } catch {
      // The tray already reported the outcome; a failed refresh just leaves the
      // docket marks in place until the next load.
    }
  }, [onRefresh]);

  // The tray applied (or cleared) what this sheet queued: re-read the queue
  // from the host rather than removing rows optimistically.
  const trayCount = tray.items.length;
  const hadQueued = useRef(false);
  useEffect(() => {
    if (trayCount > 0) hadQueued.current = true;
    else if (hadQueued.current && queued.size) { hadQueued.current = false; refresh(); }
  }, [trayCount, queued.size, refresh]);

  const rule = useCallback((group, choice, buttonEl) => {
    const until = choice.action === "defer" ? resolveDeferPreset("Tomorrow").toISOString() : null;
    const note = choice.action === "reply_need_context" ? choice.label
      : choice.action === "dismiss" ? (group.reason || "not needed")
      : choice.action === "defer" ? "Tomorrow"
      : "";
    if (!rulingTray.get().mode) rulingTray.setMode(true);
    let skipped = 0;
    for (const item of group.items || group.ids.map((id) => ({ id }))) {
      // `approve` binds to a proposal; an item without one cannot be approved
      // and would refuse the whole batch, so it stays open and is said so.
      if (choice.action === "approve" && item.proposed !== undefined && !String(item.proposed).trim()) { skipped++; continue; }
      rulingTray.add({ id: item.id, action: choice.action, note, until, title: group.question || group.title });
    }
    setQueued((m) => new Map(m).set(group.key, { label: choice.label, action: choice.action, skipped }));
    drawThread(buttonEl);
  }, []);

  const dismissAllOvertaken = useCallback((buttonEl) => {
    if (!rulingTray.get().mode) rulingTray.setMode(true);
    for (const o of overtaken) rulingTray.add({ id: o.id, action: "dismiss", note: o.reason || "overtaken by events", until: null, title: o.title });
    setQueued((m) => new Map(m).set("__overtaken__", { label: `Dismiss all ${overtaken.length}`, action: "dismiss", skipped: 0 }));
    drawThread(buttonEl);
  }, [overtaken]);

  // Keyboard (DESIGN.md): 1–7 focus a row; the underlined letter of an answer
  // rules the focused row; Esc closes an open seam and drops the focus.
  useEffect(() => {
    if (!live) return undefined;
    const onKey = (event) => {
      const tag = String(event.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || event.target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        if (foldOpen || overtakenOpen || focusIndex >= 0) {
          event.preventDefault();
          setFoldOpen(false); setOvertakenOpen(false); setFocusIndex(-1);
        }
        return;
      }
      if (/^[1-7]$/.test(event.key)) {
        const i = Number(event.key) - 1;
        if (i < visible.length) { event.preventDefault(); setFocusIndex(i); }
        return;
      }
      if (focusIndex >= 0 && /^[a-z]$/i.test(event.key)) {
        const group = visible[focusIndex];
        if (!group || queued.has(group.key)) return;
        const keys = accessKeys(group.choices);
        const at = keys.indexOf(event.key.toLowerCase());
        if (at >= 0) {
          event.preventDefault();
          const row = sheetRef.current?.querySelector(`[data-key="${CSS.escape(group.key)}"]`);
          const button = row?.querySelectorAll(".rb-pill")[at] || null;
          rule(group, group.choices[at], button);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, visible, focusIndex, foldOpen, overtakenOpen, queued, rule]);

  if (!triage || !counts.open) return null;

  const header = [
    "Needs you",
    sydneyDayLabel(),
    `${counts.decisions} decision${counts.decisions === 1 ? "" : "s"} from ${counts.open} open`,
    `${counts.top} shown`,
  ]
    .concat(counts.folded ? [`${counts.folded} folded`] : [])
    .concat(counts.later ? [`${counts.later} later`] : [])
    .concat(counts.overtaken ? [`${counts.overtaken} overtaken`] : []);

  const foldSummary = (triage.foldedByKind || []).map((k) => `${k.kind.charAt(0).toUpperCase() + k.kind.slice(1)} ${k.count}`).join(" · ");

  return (
    <section className="rb-sheet" ref={sheetRef} aria-label="Needs you — the queue as decisions">
      <header className="rb-head">
        <h2 className="rb-head__line">{header.map((h, i) => <span key={i}>{i > 0 && <i> · </i>}{h}</span>)}</h2>
        {!live && <p className="rb-readonly">Read-only on phone · queue rulings from Continuity on your PC.</p>}
      </header>

      <ol className="rb-rows">
        {visible.map((group, index) => (
          <Row
            key={group.key}
            group={group}
            index={index}
            numeral={numerals[index]}
            live={live}
            queued={queued.get(group.key) || null}
            focused={focusIndex === index}
            onRule={rule}
            onFocusRow={setFocusIndex}
          />
        ))}
      </ol>

      {folded.length > 0 && (
        <div className={`rb-seam${foldOpen ? " rb-seam--open" : ""}`}>
          <button type="button" className="rb-seam__btn" aria-expanded={foldOpen} onClick={() => setFoldOpen((v) => !v)}>
            <span>{counts.folded} folded</span>
            {foldSummary && <span className="rb-seam__kinds"><i> · </i>{foldSummary}</span>}
            <span className="rb-seam__toggle">{foldOpen ? "Hide" : "Show"} <b aria-hidden="true">▾</b></span>
          </button>
        </div>
      )}

      {overtaken.length > 0 && (
        <div className={`rb-seam rb-seam--overtaken${overtakenOpen ? " rb-seam--open" : ""}`}>
          <button type="button" className="rb-seam__btn" aria-expanded={overtakenOpen} onClick={() => setOvertakenOpen((v) => !v)}>
            <span>Overtaken by events</span><i> · </i><span>{overtaken.length}</span>
            <span className="rb-seam__toggle">Review <b aria-hidden="true">▾</b></span>
          </button>
          <div className="rb-fold">
            <div className="rb-fold__inner">
              <ul className="rb-overtaken">
                {overtaken.map((o) => (
                  <li key={o.id}>
                    <span className="rb-overtaken__title">{o.title}</span>
                    {o.reason && <span className="rb-overtaken__reason"> — {o.reason}</span>}
                    <span className="rb-meta"> {o.loop} · {shortId(o.id)}</span>
                  </li>
                ))}
              </ul>
              {live ? (
                queued.has("__overtaken__") ? (
                  <p className="rb-docket"><b>QUEUED</b> · Dismiss all {overtaken.length}</p>
                ) : (
                  <div className="rb-answers rb-answers--seam">
                    <button type="button" className="rb-pill rb-pill--first" onClick={(e) => dismissAllOvertaken(e.currentTarget)}>
                      Dismiss all {overtaken.length} — one confirm
                    </button>
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

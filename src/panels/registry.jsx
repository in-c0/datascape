// Panel registry — every panel is an instrument over the same data core.
// Panels receive { thoughts, focused, filters, applySpec, listen } and
// dispatch specs themselves (a month click IS a spec) — the same loop the
// command bar and the LLM navigator drive.
import { useMemo, useRef, useState } from "react";
import { NODES, CATEGORIES, SURFACE, STATUS_GLYPH } from "../data/nodes.js";
import { ERA_WINDOWS } from "../spec.js";
import { seedQueue } from "../seeds.js";
import { store } from "../store.js";
import { TOTALS, BRAND_LC } from "../brand.js";

const CREED = store.creed;
const MIRRORS = store.mirrors;
const BECOMING = store.becoming;
const CORPUS = store.corpus;
const EVIDENCE = store.evidence;

const yearOf = (m) => m.slice(0, 4);

// most-common cluster labels within a set of thoughts
function topClusters(thoughts, list, k = 3) {
  const counts = new Map();
  for (const t of list) counts.set(t.c, (counts.get(t.c) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([c, n]) => ({ label: thoughts.meta.clusters[c]?.label || "misc", n, c }));
}

// ---- timeline: 40 months, hover to read, click to relive one ---------------
function TimelinePanel({ thoughts, filters, applySpec }) {
  const [hoverI, setHoverI] = useState(null);
  const byMonth = useMemo(() => {
    if (!thoughts) return {};
    const m = {};
    thoughts.thoughts.forEach((t) => (m[t.m] = m[t.m] || []).push(t));
    return m;
  }, [thoughts]);
  if (!thoughts) return <div className="panel__hint">loading corpus…</div>;
  const months = thoughts.meta.months;
  const max = Math.max(...months.map(([, c]) => c));
  const W = 232, H = 56;
  const bw = W / months.length;
  const hovered = hoverI != null ? months[hoverI] : null;
  const hoveredTop = hovered ? topClusters(thoughts, byMonth[hovered[0]] || [], 1)[0] : null;
  return (
    <>
      <svg width={W} height={H} className="panel__chart" onMouseLeave={() => setHoverI(null)}>
        {months.map(([m, c], i) => {
          const h = Math.max(1.5, (c / max) * (H - 6));
          const on = filters.month === m;
          const cls = on || i === hoverI
            ? "panel__bar panel__bar--hot"
            : m >= "2026-01" ? "panel__bar panel__bar--now" : "panel__bar";
          return (
            <rect
              key={m}
              x={i * bw + 0.5}
              y={H - h}
              width={Math.max(1, bw - 1.2)}
              height={h}
              className={cls}
              onMouseEnter={() => setHoverI(i)}
              onClick={() =>
                applySpec({
                  filters: { ...filters, month: filters.month === m ? null : m },
                  narration:
                    filters.month === m
                      ? "the field returns"
                      : `${m}: ${c} thoughts — mostly ${topClusters(thoughts, byMonth[m] || [], 1)[0]?.label}`,
                })
              }
            />
          );
        })}
      </svg>
      {hovered ? (
        <div className="panel__row">
          <span>{hovered[0]}</span>
          <span className="panel__dim">
            {hovered[1]} thoughts · {hoveredTop?.label}
          </span>
        </div>
      ) : (
        <div className="panel__row">
          <span>{months[0][0]}</span>
          <span className="panel__dim">hover a month · click to isolate it</span>
          <span>{months[months.length - 1][0]}</span>
        </div>
      )}
    </>
  );
}

// ---- eras: sedimented layers with their dominant matter ---------------------
function ErasPanel({ thoughts, applySpec, filters }) {
  const eras = ["2025a", "2025b", "2026"];
  const rows = useMemo(
    () =>
      eras.map((era) => {
        const projs = NODES.filter((n) => n.era === era);
        const w = ERA_WINDOWS[era];
        const inWindow = thoughts
          ? thoughts.thoughts.filter((t) => t.m >= w[0] && t.m <= w[1])
          : [];
        return {
          era,
          projs,
          live: projs.filter((n) => n.status === "live"),
          th: inWindow.length,
          top: thoughts ? topClusters(thoughts, inWindow, 2) : [],
        };
      }),
    [thoughts]
  );
  return (
    <>
      {rows.map(({ era, projs, live, th, top }) => (
        <button
          key={era}
          className={`panel__era ${filters.era === era ? "panel__era--on" : ""}`}
          onClick={() =>
            applySpec({
              filters: { ...filters, era: filters.era === era ? null : era, month: null },
              narration:
                filters.era === era
                  ? "filter lifted — the whole field returns"
                  : `era ${era}: ${projs.length} projects born, ${live.length} still live · thinking about ${top[0]?.label}`,
            })
          }
        >
          <span className="panel__era-name">{era}</span>
          <span className="panel__era-stat">
            {projs.length} born · {live.length} still live · {th.toLocaleString()} thoughts
          </span>
          <span className="panel__era-stat panel__dim">
            {top.map((t) => t.label).join(" · ") || "…"}
          </span>
          {filters.era === era && (
            <span className="panel__era-stat">
              {projs.map((p) => p.title.toLowerCase()).join(" · ")}
            </span>
          )}
        </button>
      ))}
      <div className="panel__hint">click an era to filter · click again to lift</div>
    </>
  );
}

// ---- provenance: what a project is built on — navigable ----------------------
function ProvenancePanel({ thoughts, focused, listen }) {
  const lastRef = useRef(null);
  if (focused != null) lastRef.current = focused;
  const idx = focused ?? lastRef.current;
  const linked = useMemo(() => {
    if (idx == null || !thoughts) return [];
    return thoughts.thoughts
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.pj === idx);
  }, [thoughts, idx]);
  if (idx == null)
    return <div className="panel__hint">focus a project node to trace its roots</div>;
  const node = NODES[idx];
  const stats = thoughts?.meta?.projects?.[idx];
  if (!stats?.count)
    return (
      <>
        <div className="panel__strong">{node.title}</div>
        <div className="panel__hint">no conversations linked to this one</div>
      </>
    );
  const byTime = [...linked].sort((a, b) => (a.t.m < b.t.m ? -1 : 1));
  const first = byTime[0];
  const latest = byTime[byTime.length - 1];
  const longest = [...linked].sort((a, b) => b.t.n - a.t.n)[0];
  // monthly sparkline of linked activity
  const months = thoughts.meta.months.map(([m]) => m);
  const perMonth = months.map((m) => linked.filter(({ t }) => t.m === m).length);
  const pmax = Math.max(...perMonth, 1);
  const Chat = ({ item, tag }) => (
    <button className="panel__item panel__item--btn" onClick={() => listen(item.i)}>
      <span className="panel__item-t">{item.t.t.toLowerCase()}</span>
      <span className="panel__item-n">{tag || `${item.t.n}`}</span>
    </button>
  );
  return (
    <>
      <div className="panel__strong">{node.title}</div>
      <div className="panel__row">
        <span>{stats.count} conversations · {stats.msgs.toLocaleString()} msgs</span>
      </div>
      <svg width={232} height={22} className="panel__chart">
        {perMonth.map((c, i) => (
          <rect
            key={i}
            x={i * (232 / months.length) + 0.5}
            y={20 - (c / pmax) * 18}
            width={Math.max(1, 232 / months.length - 1.2)}
            height={Math.max(c ? 2 : 0.5, (c / pmax) * 18)}
            className={c ? "panel__bar panel__bar--now" : "panel__bar"}
          />
        ))}
      </svg>
      <div className="panel__row panel__dim">
        <span>{stats.firstMonth} → {stats.lastMonth}</span>
        <span>linked activity</span>
      </div>
      <div className="panel__sect">first spark</div>
      <Chat item={first} tag={first.t.m} />
      <div className="panel__sect">deepest</div>
      <Chat item={longest} tag={`${longest.t.n} msgs`} />
      <div className="panel__sect">latest thought</div>
      <Chat item={latest} tag={latest.t.m} />
      <div className="panel__hint" style={{ marginTop: 6 }}>click a conversation to listen in</div>
    </>
  );
}

// ---- comparison: domains side by side, and where they diverge ----------------
function ComparisonPanel({ thoughts }) {
  const rows = useMemo(() => {
    const cats = Object.keys(CATEGORIES);
    const totalProjects = NODES.length;
    const linkedAll = thoughts ? thoughts.thoughts.filter((t) => t.pj != null) : [];
    return cats.map((c) => {
      const projs = NODES.filter((n) => n.category === c);
      const idxs = new Set(projs.map((n) => NODES.indexOf(n)));
      const chats = linkedAll.filter((t) => idxs.has(t.pj));
      return {
        c,
        n: projs.length,
        live: projs.filter((n) => n.status === "live").length,
        chats: chats.length,
        msgs: chats.reduce((s, t) => s + t.n, 0),
        sig: projs.reduce((s, n) => s + n.sig, 0),
        projShare: projs.length / totalProjects,
        chatShare: linkedAll.length ? chats.length / linkedAll.length : 0,
      };
    });
  }, [thoughts]);
  const maxSig = Math.max(...rows.map((r) => r.sig), 0.1);
  const maxShare = Math.max(...rows.map((r) => r.chatShare), 0.01);
  const divergent = [...rows].sort(
    (a, b) => Math.abs(b.chatShare - b.projShare) - Math.abs(a.chatShare - a.projShare)
  )[0];
  return (
    <>
      {rows.map((r) => (
        <div key={r.c} className="panel__cmp">
          <div className="panel__row">
            <span style={{ color: CATEGORIES[r.c].hue }}>{r.c}</span>
            <span className="panel__dim">
              {r.n} proj · {r.live} live · {r.chats} chats · {(r.msgs / 1000).toFixed(1)}k msgs
            </span>
          </div>
          <div className="panel__track">
            <span
              className="panel__fill"
              style={{ width: `${(r.sig / maxSig) * 100}%`, background: CATEGORIES[r.c].hue }}
            />
          </div>
          <div className="panel__track panel__track--thin">
            <span
              className="panel__fill panel__fill--dim"
              style={{ width: `${(r.chatShare / maxShare) * 100}%` }}
            />
          </div>
        </div>
      ))}
      <div className="panel__hint">thick bar significance · thin bar thought-share</div>
      {divergent && (
        <div className="panel__insight">
          {divergent.c}: {Math.round(divergent.projShare * 100)}% of projects,{" "}
          {Math.round(divergent.chatShare * 100)}% of linked thought —{" "}
          {divergent.chatShare > divergent.projShare
            ? "thought about more than it's shipped"
            : "shipped more than it's talked about"}
        </div>
      )}
    </>
  );
}

// ---- mirrors: the measured tier, live now ------------------------------------
function MirrorPanel({ thoughts, openPage, applySpec, instruments }) {
  const m = useMemo(() => {
    if (!thoughts) return null;
    const years = ["2023", "2024", "2025", "2026"];
    const byYear = years.map((y) => ({
      y,
      list: thoughts.thoughts.filter((t) => yearOf(t.m) === y),
    }));
    const domByYear = byYear.map(({ y, list }) => ({
      y,
      top: topClusters(thoughts, list, 5),
      korean: list.length ? list.filter((t) => t.k).length / list.length : 0,
      depth: list.length ? list.reduce((s, t) => s + t.n, 0) / list.length : 0,
    }));
    // clusters that appear in the top-5 of EVERY year = what never left
    const persistent = domByYear[0].top
      .map((t) => t.c)
      .filter((c) => domByYear.every(({ top }) => top.some((t) => t.c === c)))
      .map((c) => thoughts.meta.clusters[c]?.label || "misc");
    const busiest = [...thoughts.meta.months].sort((a, b) => b[1] - a[1])[0];
    return { domByYear, persistent, busiest };
  }, [thoughts]);
  if (!m) return <div className="panel__hint">loading corpus…</div>;
  const d0 = m.domByYear[0], dNow = m.domByYear[m.domByYear.length - 1];
  return (
    <>
      <div className="panel__sect">what changed <span className="panel__tier">measured</span></div>
      {m.domByYear.map(({ y, top }) => (
        <div key={y} className="panel__row">
          <span>{y}</span>
          <span className="panel__dim">{top.slice(0, 2).map((t) => t.label).join(" · ")}</span>
        </div>
      ))}
      <div className="panel__sect">what never left <span className="panel__tier">measured</span></div>
      {Object.entries(CORPUS.motifs)
        .filter(([, v]) => v.convos >= 5)
        .sort((a, b) => b[1].convos - a[1].convos)
        .slice(0, 5)
        .map(([motif, v]) => (
          <div key={motif} className="panel__row">
            <span>{motif}</span>
            <span className="panel__dim">
              {v.convos} chats · {Object.keys(v.byYear).length} of 4 years
            </span>
          </div>
        ))}
      <div className="panel__hint">
        the named recurrences, counted in the messages themselves
        {m.persistent.length ? ` · clusters that never left: ${m.persistent.join(" · ")}` : ""}
      </div>
      <div className="panel__sect">rhythm <span className="panel__tier">measured</span></div>
      <div className="panel__row">
        <span>busiest month</span>
        <span className="panel__dim">{m.busiest[0]} · {m.busiest[1]} thoughts</span>
      </div>
      <div className="panel__row">
        <span>depth per chat</span>
        <span className="panel__dim">
          {d0.depth.toFixed(0)} msgs in {d0.y} → {dNow.depth.toFixed(0)} in {dNow.y}
          {dNow.depth > d0.depth ? " · digging deeper" : " · moving lighter"}
        </span>
      </div>
      <div className="panel__sect">the korean thread <span className="panel__tier">measured</span></div>
      <div className="panel__row">
        {m.domByYear.map(({ y, korean }) => (
          <span key={y} className="panel__dim">{y.slice(2)}: {(korean * 100).toFixed(0)}%</span>
        ))}
      </div>
      <div className="panel__disclaimer" style={{ marginTop: 9 }}>
        Incomplete by design — an LLM's read of {TOTALS.thoughtsLabel} chat titles. Not a test,
        no baseline, no clinical meaning. It only sees what was typed into one app.
      </div>
      <button className="panel__open" onClick={() => openPage("mirror")}>
        open the full mirror — jungian shells · dark triad · metaperception →
      </button>
      <button
        className="panel__open"
        onClick={() =>
          applySpec({
            instruments: instruments?.includes("metaperception") ? [] : ["metaperception"],
            camera: "core",
            narration: instruments?.includes("metaperception")
              ? "the three bodies rest"
              : "metaperception, embodied — three readings of one person, disagreements drawn taut",
          })
        }
      >
        {instruments?.includes("metaperception")
          ? "rest the three bodies"
          : "project metaperception into the scene →"}
      </button>
      <button
        className="panel__open"
        onClick={() =>
          applySpec({
            instruments: instruments?.includes("rarity") ? [] : ["rarity"],
            camera: "overview",
            narration: instruments?.includes("rarity")
              ? "the shore recedes"
              : "the rarity shore — obsessions by size, the baseline left deliberately blank",
          })
        }
      >
        {instruments?.includes("rarity") ? "let the shore recede" : "raise the rarity shore →"}
      </button>
    </>
  );
}

// ---- the becoming: where she is going vs where she wants to be going ---------
function BecomingPanel({ applySpec }) {
  const now = useMemo(() => {
    const v = CORPUS.voice.filter((x) => x.words > 0);
    const recent = v.slice(-3);
    const wpm = Math.round(recent.reduce((a, x) => a + x.words, 0) / recent.length);
    const bw = +(recent.reduce((a, x) => a + x.build / Math.max(x.wonder, 1e-4), 0) / recent.length).toFixed(1);
    const lbw = v.map((x) => Math.log((x.build + 1e-4) / (x.wonder + 1e-4)));
    const tail = lbw.slice(-12);
    const drift = tail[tail.length - 1] - tail[0];
    return { wpm, bw, drift: drift >= 0 ? "toward building" : "toward wondering" };
  }, []);
  return (
    <>
      <div className="panel__sect">
        measured now <span className="panel__tier">measured</span>
      </div>
      <div className="panel__row">
        <span>{(now.wpm / 1000).toFixed(1)}k words/month</span>
        <span className="panel__dim">build:wonder {now.bw} · drifting {now.drift}</span>
      </div>
      <div className="panel__sect">
        the projection <span className="panel__tier">measured</span>
      </div>
      <div className="panel__hint">
        height = words per month; the lateral axis = build:wonder balance.
        trend ± volatility from the last twelve months, in both dimensions —
        cones widen because reality is chaotic; exceptions a–z on purpose.
      </div>
      <div className="panel__sect">
        the aspiration <span className="panel__tier">inferred</span>
      </div>
      {BECOMING.aspiration.statements.map((s, i) => (
        <div key={i} className="panel__item" style={{ display: "block" }}>
          <span className="panel__item-t" style={{ whiteSpace: "normal" }}>
            “{s.text}”
          </span>
          <div className="panel__dim" style={{ fontSize: 8.5 }}>{s.source}</div>
        </div>
      ))}
      <div className="panel__sect">{BECOMING.gap.label} <span className="panel__tier">inferred</span></div>
      <div className="panel__insight">{BECOMING.gap.reading}</div>
      <button
        className="panel__open"
        onClick={() =>
          applySpec({
            topology: "strata",
            camera: "future",
            narration: "the fan of futures — where it’s going, where it wants to be going, and the gap",
          })
        }
      >
        walk the fan →
      </button>
    </>
  );
}

// ---- creed: borrowed wisdom, kept apart from her own thoughts ----------------
function CreedPanel({ openPage }) {
  return (
    <>
      <div className="panel__hangul-block">{CREED.centerpiece.ko.split("\n")[0]}</div>
      <div className="panel__hint" style={{ marginTop: 4 }}>
        the centerpiece — {CREED.centerpiece.note}
      </div>
      <div className="panel__sect">borrowed wisdom</div>
      {CREED.quotes.filter((q) => q.drift).slice(0, 3).map((q, i) => (
        <div key={i} className="panel__quote-sm">
          “{(q.driftText || q.text).toLowerCase()}”
        </div>
      ))}
      <div className="panel__hint" style={{ marginTop: 7 }}>
        {CREED.quotes.length} quotes drift between the clusters · creed ≠ seeds:
        these are borrowed; seeds are yours
      </div>
      <button className="panel__open" onClick={() => openPage("creed")}>
        read the full creed →
      </button>
    </>
  );
}

// ---- hub: the observatory's own dashboard (never public) ---------------------
function HubPanel({ thoughts, applySpec }) {
  const ledger = useMemo(() => {
    const by = (s) => NODES.filter((n) => n.status === s).length;
    const reveal = NODES.filter((n) => n.visibility === "reveal").length;
    const top = [...NODES].sort((a, b) => b.sig - a.sig).slice(0, 3);
    return { live: by("live"), soon: by("soon"), building: by("building"), archived: by("archived"), reveal, top };
  }, []);
  const queue = useMemo(() => seedQueue(thoughts), [thoughts]);
  if (SURFACE === "public")
    return <div className="panel__hint">the hub lives in the observatory</div>;
  return (
    <>
      <div className="panel__row">
        <span>{STATUS_GLYPH.live} {ledger.live} live</span>
        <span>{STATUS_GLYPH.soon} {ledger.soon} soon</span>
        <span>{STATUS_GLYPH.building} {ledger.building} building</span>
        <span>{STATUS_GLYPH.archived} {ledger.archived} archived</span>
      </div>
      <div className="panel__sect">visibility audit</div>
      <div className="panel__row">
        <span>{ledger.reveal} reveal · {NODES.length - ledger.reveal} vault</span>
        <span className="panel__dim">
          {ledger.reveal === 0 ? "public build renders empty" : "public shows " + ledger.reveal}
        </span>
      </div>
      <div className="panel__sect">heaviest matter</div>
      {ledger.top.map((n) => (
        <button
          key={n.id}
          className="panel__item panel__item--btn"
          onClick={() => applySpec({ focus: n.id, panels: ["hub", "provenance"] })}
        >
          <span className="panel__item-t">{n.title.toLowerCase()}</span>
          <span className="panel__item-n">sig {n.sig.toFixed(1)}</span>
        </button>
      ))}
      <div className="panel__sect">the three pillars</div>
      <div className="panel__row"><span>analysis</span><span className="panel__dim">live — the panels</span></div>
      <div className="panel__row"><span>chatbot</span><span className="panel__dim">live — the navigator</span></div>
      <div className="panel__row">
        <span>approximation</span>
        <span className="panel__dim">the inferred tier, unified — twin awaits the deep read</span>
      </div>
      <div className="panel__row panel__dim" style={{ marginTop: 6 }}>
        <span>seed queue: {queue.length}</span>
        <span>{thoughts ? thoughts.meta.thoughts.toLocaleString() : "…"} thoughts indexed</span>
      </div>
    </>
  );
}

// ---- seeds: the recommender queue, v1 heuristic --------------------------------
function SeedPanel({ thoughts, listen, openPage }) {
  const queue = useMemo(
    () => (SURFACE === "public" ? [] : seedQueue(thoughts)),
    [thoughts]
  );
  if (SURFACE === "public")
    return (
      <div className="panel__hint">
        seeds are your own thoughts worth keeping — authored, not borrowed.
        the first ones are being chosen; they'll live here and at {BRAND_LC}/seeds.
      </div>
    );
  if (!queue.length) return <div className="panel__hint">loading corpus…</div>;
  return (
    <>
      <div className="panel__hint" style={{ marginBottom: 6 }}>
        candidate seeds, ranked by heuristic (depth · resonant words · unlinked
        to any build). your yes decides — nothing publishes from here.
      </div>
      {queue.map(({ t, i, score }) => (
        <button key={i} className="panel__item panel__item--btn" onClick={() => listen(i)}>
          <span className="panel__item-t">{t.t.toLowerCase()}</span>
          <span className="panel__item-n">{score.toFixed(1)}</span>
        </button>
      ))}
      <div className="panel__hint" style={{ marginTop: 6 }}>
        click to listen in · exemplars live on disk, vault by default
      </div>
      <button className="panel__open" onClick={() => openPage("seeds")}>
        open the seed garden →
      </button>
    </>
  );
}

// ---- value: worth, read three ways — to others, created, held ---------------
function ValuePanel() {
  const v = useMemo(() => {
    const live = NODES.filter((n) => n.status === "live");
    const commits = Object.values(EVIDENCE).reduce((a, e) => a + (e?.commits || 0), 0);
    const gitYears = Object.values(EVIDENCE)
      .filter((e) => e?.firstCommit)
      .map((e) => e.firstCommit.slice(0, 4));
    const skillsBreadth = CORPUS.skills.length;
    const topRecent = CORPUS.skills.filter((s) => s.last >= "2026-01").length;
    return {
      live: live.length,
      liveNames: live.map((n) => n.title.toLowerCase()).join(" · "),
      commits,
      since: gitYears.sort()[0],
      projects: NODES.length,
      skillsBreadth,
      topRecent,
      creedValues: CREED.quotes.filter((q) => q.attribution?.includes("hers")).length,
    };
  }, []);
  return (
    <>
      <div className="panel__sect">worth to others <span className="panel__tier">measured</span></div>
      <div className="panel__row"><span>{v.live} services in production</span><span className="panel__dim">today</span></div>
      <div className="panel__row"><span>{v.skillsBreadth} technologies</span><span className="panel__dim">{v.topRecent} active this year</span></div>
      <div className="panel__row"><span>{v.commits.toLocaleString()} commits</span><span className="panel__dim">since {v.since}</span></div>

      <div className="panel__sect">value created <span className="panel__tier">measured</span></div>
      <div className="panel__hint">{v.liveNames}</div>
      <div className="panel__row panel__dim" style={{ marginTop: 4 }}>
        <span>{v.projects} projects · {TOTALS.thoughtsLabel} conversations · {TOTALS.messagesLabel} messages of thought</span>
      </div>

      <div className="panel__sect">values held <span className="panel__tier">borrowed</span></div>
      <div className="panel__hint">
        until a corpus-wide read measures what you actually value in your own
        words, the creed carries what you chose to borrow.
      </div>
      <div className="panel__hint" style={{ marginTop: 6 }}>
        value, read broadly — worth to others, value created, and values held,
        all three faces at once.
      </div>
    </>
  );
}

// ---- skills: what you can do, counted from what you actually did -------------
function SkillsPanel() {
  const top = CORPUS.skills.slice(0, 11);
  const max = top[0]?.convos || 1;
  return (
    <>
      <div className="panel__hint" style={{ marginBottom: 7 }}>
        counted from actual messages across {TOTALS.months} months — not claimed,
        measured. <span className="panel__tier">measured</span>
      </div>
      {top.map((s) => (
        <div key={s.tech} className="panel__cmp">
          <div className="panel__row">
            <span>{s.tech}</span>
            <span className="panel__dim">
              {s.convos} chats · {s.first} → {s.last}
            </span>
          </div>
          <div className="panel__track">
            <span
              className="panel__fill"
              style={{ width: `${(s.convos / max) * 100}%`, background: "#4af08c" }}
            />
          </div>
        </div>
      ))}
      <div className="panel__hint" style={{ marginTop: 6 }}>
        {CORPUS.skills.length} technologies traced · depth: message-level
      </div>
    </>
  );
}

// ---- voice: how she writes, measured year by year -----------------------------
function VoicePanel() {
  const byYear = useMemo(() => {
    const years = {};
    for (const v of CORPUS.voice) {
      const y = (years[v.m.slice(0, 4)] = years[v.m.slice(0, 4)] || {
        words: 0, convos: 0, q: 0, ko: 0, rich: 0, build: 0, wonder: 0, n: 0,
      });
      y.words += v.words; y.convos += v.convos; y.q += v.questionRate;
      y.ko += v.koreanShare; y.rich += v.vocabRichness;
      y.build += v.build; y.wonder += v.wonder; y.n++;
    }
    return Object.entries(years).map(([y, v]) => ({
      y,
      wpc: Math.round(v.words / v.convos),
      q: +(v.q / v.n).toFixed(1),
      ko: +((v.ko / v.n) * 100).toFixed(1),
      bw: v.wonder ? +(v.build / v.wonder).toFixed(1) : 0,
      rich: +(v.rich / v.n).toFixed(2),
    }));
  }, []);
  const f = byYear[0], l = byYear[byYear.length - 1];
  return (
    <>
      <div className="panel__hint" style={{ marginBottom: 6 }}>
        your actual words, year by year <span className="panel__tier">measured</span>
      </div>
      <div className="panel__row panel__dim">
        <span>year</span><span>words/chat</span><span>?/chat</span><span>한국어</span><span>build:wonder</span>
      </div>
      {byYear.map((v) => (
        <div key={v.y} className="panel__row">
          <span>{v.y}</span>
          <span>{v.wpc}</span>
          <span>{v.q}</span>
          <span>{v.ko}%</span>
          <span>{v.bw}</span>
        </div>
      ))}
      {f && l && (
        <div className="panel__insight">
          {l.wpc > f.wpc
            ? `${(l.wpc / f.wpc).toFixed(1)}× more words per conversation than in ${f.y}`
            : `conversations grew terser since ${f.y}`}
          {" — and the build:wonder ratio moved "}
          {l.bw > f.bw ? `toward building (${f.bw} → ${l.bw})` : `toward wondering (${f.bw} → ${l.bw})`}
        </div>
      )}
    </>
  );
}

export const PANELS = {
  timeline: { title: "timeline", sub: `${TOTALS.months} months of thinking`, C: TimelinePanel },
  eras: { title: "eras", sub: "sedimented layers", C: ErasPanel },
  becoming: { title: "becoming", sub: "the fan of futures", C: BecomingPanel },
  provenance: { title: "provenance", sub: "what fed the work", C: ProvenancePanel },
  comparison: { title: "comparison", sub: "domains, side by side", C: ComparisonPanel },
  mirror: { title: "mirrors", sub: "how the machine sees you", C: MirrorPanel },
  value: { title: "value", sub: "all three faces at once", C: ValuePanel },
  skills: { title: "skills", sub: "counted, not claimed", C: SkillsPanel },
  voice: { title: "voice", sub: "how you write, measured", C: VoicePanel },
  seeds: { title: "seeds", sub: "thoughts worth planting", C: SeedPanel },
  creed: { title: "creed", sub: "borrowed wisdom", C: CreedPanel },
  hub: { title: "hub", sub: "the observatory's own desk", C: HubPanel, observatoryOnly: true },
};

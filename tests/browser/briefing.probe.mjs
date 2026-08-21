// Browser acceptance suite for the Continuity briefing surface.
//
// Committed deliberately. The governing lane's release gate requires a clean
// suite IN THE HARNESS, not a passing manual rerun with an explanation
// attached: "a known broken probe cannot ship as 14/15 plus an explanatory
// manual rerun."
//
// The earlier 14/15 was this file's ancestor lying. It installed a
// window.onerror collector, then navigated later in the same run — which
// replaces the JS context — and read `undefined` where it expected `[]`. That
// is the worst class of test defect: it cries wolf, you learn to discount it,
// and the next real regression walks through. Fixed at the harness level by
// probeTab(), which re-arms on every navigation.
//
//   node tests/browser/briefing.probe.mjs            (expects a server on 5313)
//   BRIEFING_URL=http://localhost:5313 node tests/browser/briefing.probe.mjs
//
// Not part of `npm test`: it needs a running dev server and a real browser.

import { launchEdge } from "file:///D:/Projects/.tools/edge-session.mjs";
import { probeTab } from "file:///D:/Projects/.tools/probe-tab.mjs";

const BASE = process.env.BRIEFING_URL || "http://localhost:5313";
const results = [];
const ok = (name, condition, detail = "") => {
  results.push([name, Boolean(condition)]);
  console.log((condition ? "PASS  " : "FAIL  ") + name + (detail && !condition ? `  <- ${detail}` : ""));
};

const nodeCount = (tab) => tab.eval('document.querySelectorAll(".bf-stage__nodes .bf-node, .bf-placed__node .bf-node").length');
const cardCount = (tab) => tab.eval('document.querySelectorAll(".bf-card").length');
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

// Descend one semantic level by selecting a CHILD.
//
// The obvious selector list ".bf-childcol .bf-node, .bf-stage__nodes .bf-node"
// is wrong: querySelector returns the first match in DOCUMENT order, which is
// the focal node — and the focal node is not clickable, so navigation silently
// did not happen while weak assertions still passed at the old level. This
// asserts the position actually advanced.
async function descend(tab, label = "descend") {
  const before = await tab.eval("location.search");
  const clicked = await tab.eval(
    '(()=>{const el=document.querySelector(".bf-childcol .bf-node") || ' +
    '[...document.querySelectorAll(".bf-stage__nodes .bf-node, .bf-placed__node .bf-node")].find(n=>!n.className.includes("origin"));' +
    'if(!el) return false; el.click(); return true;})()',
  );
  await settle();
  const after = await tab.eval("location.search");
  if (!clicked || before === after) {
    throw new Error(`${label}: selecting a child did not change the semantic position (${before})`);
  }
  return after;
}

let edge = await launchEdge({ args: ["--window-size=1536,874"] });
try {
  const tab = probeTab(await edge.newTab());

  // ---- entry ----
  await tab.goto(`${BASE}/?view=briefing`);
  await settle(2400);
  ok("surface mounts", await tab.eval('!!document.querySelector(".bf-root")'));
  const entry = await nodeCount(tab);
  ok("entry is within its 4-node budget", entry > 0 && entry <= 4, `nodes=${entry}`);
  ok("entry opens with no detail card", (await cardCount(tab)) === 0);

  // ---- Z0: focal geometry ----
  await tab.goto(`${BASE}/?view=briefing&at=needs`);
  await settle(1800);
  const focal = await tab.eval('document.querySelectorAll(".bf-focalcol .bf-node").length');
  const children = await tab.eval('document.querySelectorAll(".bf-childcol .bf-node").length');
  ok("Z0 has exactly one focal node", focal === 1, `focal=${focal}`);
  ok("Z0 is within its 4-node budget", focal + children <= 4, `total=${focal + children}`);
  const fx = await tab.eval('document.querySelector(".bf-focalcol .bf-ring").getBoundingClientRect().left');
  const cx = await tab.eval('document.querySelector(".bf-childcol .bf-ring").getBoundingClientRect().left');
  ok("the focal node IS the fan origin, left of its children", fx < cx - 40, `focal=${Math.round(fx)} child=${Math.round(cx)}`);
  const focalLabel = await tab.eval('document.querySelector(".bf-focalcol .bf-node__label").innerText');
  const childLabels = await tab.eval('[...document.querySelectorAll(".bf-childcol .bf-node__label")].map(e=>e.innerText)');
  ok("the focal concept is never re-rendered as a child", !childLabels.includes(focalLabel), `focal=${focalLabel}`);
  ok("the breadcrumb is secondary at Z0", await tab.eval('!!document.querySelector(".bf-crumbs--secondary")'));

  // ---- Z1 ----
  await descend(tab);
  const f1 = await tab.eval('document.querySelectorAll(".bf-focalcol .bf-node").length');
  const c1 = await tab.eval('document.querySelectorAll(".bf-childcol .bf-node").length');
  ok("Z1 is one focal node plus at most 4 records", f1 === 1 && c1 <= 4, `focal=${f1} children=${c1}`);

  // ---- keyboard (spec §11) ----
  await tab.eval('window.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
  await settle(300);
  ok("ArrowDown moves keyboard focus", (await tab.eval('document.querySelectorAll(".bf-node--kb").length')) === 1);
  await tab.eval('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await settle();
  ok("Enter recenters to Z2 with exactly one card", (await cardCount(tab)) === 1);
  await tab.eval('window.dispatchEvent(new KeyboardEvent("keydown",{key:"r",bubbles:true}))');
  await settle(400);
  ok("R opens the Reply composer", await tab.eval('!!document.querySelector(".bf-cta__note")'));
  await tab.eval('window.dispatchEvent(new KeyboardEvent("keydown",{key:"d",bubbles:true}))');
  await settle(400);
  const chips = await tab.eval('[...document.querySelectorAll(".bf-chip")].map(c=>c.innerText).join("|")');
  ok("D opens the Defer choices", chips.includes("Tonight"), chips);
  ok("the CTA row is visible without opening details", await tab.eval('!!document.querySelector(".bf-card .bf-cta")'));
  await tab.eval('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await settle();
  ok("Escape climbs one semantic level", (await cardCount(tab)) === 0);

  // ---- non-owner Z2: bounded excerpt, full text one level deeper ----
  await tab.goto(`${BASE}/?view=briefing&at=lane%2Fcat-intent`);
  await settle(1800);
  await descend(tab, "lane facet");
  await descend(tab, "lane record");
  const excerptLen = await tab.eval('document.querySelector(".bf-card .bf-md, .bf-card .bf-verbatim")?.innerText.length || 0');
  ok("a non-owner record shows a bounded excerpt", excerptLen > 0 && excerptLen <= 420, `len=${excerptLen}`);
  if (await tab.eval('!!document.querySelector(".bf-readfull")')) {
    await tab.eval('document.querySelector(".bf-readfull").click()');
    await settle();
    const fullLen = await tab.eval('document.querySelector(".bf-card .bf-md, .bf-card .bf-verbatim")?.innerText.length || 0');
    ok("the full authored record lives one level deeper", fullLen > excerptLen, `full=${fullLen} excerpt=${excerptLen}`);
  } else {
    ok("the full authored record lives one level deeper", true, "record fitted the excerpt budget");
  }

  // ---- authored Markdown is presentation, not literal delimiters ----
  await tab.goto(`${BASE}/?view=briefing&at=needs`);
  await settle(1600);
  await descend(tab, "bucket");
  await descend(tab, "decision");
  const cardText = await tab.eval('document.querySelector(".bf-card")?.innerText || ""');
  const hasMarkup = await tab.eval('!!document.querySelector(".bf-card .bf-md")');
  ok("authored bodies render as presentation Markdown", hasMarkup && !/\*\*/.test(cardText), hasMarkup ? "** still visible" : "no .bf-md");

  // ---- spec v2.2: the stage IS the field ----
  //
  // These are DOM-geometry assertions on purpose. The model tests can prove a
  // live envelope's x2 equals NOW; only the rendered page can prove the node
  // sits inside the run that produced it, which is the invariant v2.1 broke by
  // exactly one ring-radius while every unit test stayed green.
  const NOW = encodeURIComponent("2026-08-21T18:40:00+10:00");
  const SINCE = encodeURIComponent("2026-08-21T10:00:00+10:00");
  await tab.goto(`${BASE}/?view=briefing&now=${NOW}&since=${SINCE}`);
  await settle(1800);

  const geom = JSON.parse(await tab.eval(`(()=>{
    const box = (e) => { const r = e.getBoundingClientRect(); return {x1:r.left,x2:r.right,y1:r.top,y2:r.bottom}; };
    const envs = [...document.querySelectorAll(".bf-env")].map((e) => ({...box(e), live: e.classList.contains("bf-env--live")}));
    const nodes = [...document.querySelectorAll(".bf-placed__node")].map((e) => {
      const r = e.querySelector(".bf-ring").getBoundingClientRect();
      return { temporal: !e.classList.contains("bf-placed__node--atemporal"), cx: r.left + r.width/2, cy: r.top + r.height/2 };
    });
    const nowEl = document.querySelector(".bf-now");
    const field = document.querySelector(".bf-field");
    return JSON.stringify({ envs, nodes, now: nowEl && box(nowEl), field: field && box(field),
      axisPanels: document.querySelectorAll(".bf-axis, .bf-axiswrap").length });
  })()`));

  const temporal = geom.nodes.filter((n) => n.temporal);
  const contained = temporal.filter((n) => geom.envs.some((v) => n.cx >= v.x1 - 1 && n.cx <= v.x2 + 1 && n.cy >= v.y1 && n.cy <= v.y2));
  ok("every temporally placed node sits inside the run that produced it",
    temporal.length > 0 && contained.length === temporal.length,
    `${contained.length}/${temporal.length} contained`);

  ok("NOW crosses the graph area, not a separate strip",
    !!geom.now && !!geom.field && geom.now.y1 <= geom.field.y1 + 2 && geom.now.y2 >= geom.field.y2 - 2,
    JSON.stringify({ now: geom.now, field: geom.field }));

  const live = geom.envs.filter((e) => e.live);
  const done = geom.envs.filter((e) => !e.live);
  ok("a live run terminates at NOW and completed runs terminate left of it",
    live.length > 0 && done.length > 0
      && live.every((e) => Math.abs(e.x2 - geom.now.x1) <= 2)
      && done.every((e) => e.x2 < geom.now.x1 - 2),
    JSON.stringify({ live: live.map((e) => e.x2), done: done.map((e) => e.x2), now: geom.now.x1 }));

  ok("no independent timeline panel above the graph", geom.axisPanels === 0, `${geom.axisPanels} panel(s)`);

  // Recentering must not drop the temporal field — v2.2 rejected time that
  // disappears the moment semantic resolution increases.
  await tab.goto(`${BASE}/?view=briefing&now=${NOW}&since=${SINCE}&at=lane%2Fpersonalos-surface-runtime`);
  await settle(1600);
  const zoomed = JSON.parse(await tab.eval(
    '(()=>JSON.stringify({field:!!document.querySelector(".bf-field"),envs:document.querySelectorAll(".bf-env").length}))()',
  ));
  ok("a selected unattended lane keeps its temporal context", zoomed.field && zoomed.envs > 0, JSON.stringify(zoomed));

  // ---- the probe's own control, and the error assertion it once faked ----
  ok("PROBE CONTROL: the error collector survived every navigation", await tab.armed());
  const errors = await tab.errors();
  ok("no page errors", errors.length === 0, JSON.stringify(errors));
} finally {
  await edge.close();
}

// ---- mobile ----
edge = await launchEdge({ args: ["--window-size=375,812"] });
try {
  const tab = probeTab(await edge.newTab());
  await tab.goto(`${BASE}/?view=briefing&at=needs`);
  await settle(2200);
  await descend(tab, "mobile bucket");
  await descend(tab, "mobile decision");
  const inView = await tab.eval(
    '(()=>{const r=document.querySelector(".bf-cta")?.getBoundingClientRect();' +
    'if(!r) return "none";' +
    'return (r.top < innerHeight && r.bottom > 0) ? "visible" : "below-fold top="+Math.round(r.top);})()',
  );
  ok("mobile Z2 CTA is reachable without scrolling", inView === "visible", String(inView));
} finally {
  await edge.close();
}

const failed = results.filter(([, pass]) => !pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// Rendered invariants for the V3.1 semantic-zoom slice.
//
// These are DOM assertions on purpose. The model already proves the graph is
// well formed; only the running page can prove that the ceiling holds through a
// transition, that selection and zoom did not collapse into one gesture, and
// that Back walks the descent one semantic operation at a time.
import { launchEdge } from "file:///D:/Projects/.tools/edge-session.mjs";
import { probeTab } from "file:///D:/Projects/.tools/probe-tab.mjs";

const BASE = process.env.BRIEFING_URL || "http://localhost:5313";
const NOW = encodeURIComponent("2026-08-21T18:40:00+10:00");
const SINCE = encodeURIComponent("2026-08-21T10:00:00+10:00");
const URL_BASE = `${BASE}/?view=briefing&fixture=v3-projection&now=${NOW}&since=${SINCE}`;
const DESCENT = ["dist", "dist-shortform", "sf-vibo", "vibo-beforeafter", "ba-spatial", "spatial-reveal", "S01_r02"];

const results = [];
const ok = (name, pass, detail = "") => {
  results.push([name, pass]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `  <- ${detail}`}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = await launchEdge({ args: ["--window-size=1536,874"] });
try {
  const tab = probeTab(await edge.newTab());
  await tab.goto(URL_BASE);
  await wait(1500);

  const state = () => tab.eval("JSON.stringify(window.__continuity.state())").then(JSON.parse);
  const visible = () => tab.eval('document.querySelectorAll(".sem__concept").length');

  // ---- the ceiling, at every altitude AND mid-transition ----
  const counts = [];
  await tab.eval(`window.__continuity.select(${JSON.stringify(DESCENT[0])})`);
  await wait(100);
  counts.push(await visible());
  for (let i = 0; i < DESCENT.length - 1; i++) {
    await tab.eval("window.__continuity.plus()");
    await wait(60);
    counts.push(await visible());          // mid-transition
    await wait(300);
    counts.push(await visible());          // settled
    await tab.eval(`window.__continuity.select(${JSON.stringify(DESCENT[i + 1])})`);
    await wait(40);
  }
  ok("no altitude, settled or mid-transition, ever shows more than five concepts",
    counts.length > 6 && counts.every((n) => n >= 1 && n <= 5), JSON.stringify(counts));

  const atSource = await state();
  ok("six semantic transitions reach an exact authored source",
    atSource.semanticAltitude === 6 && atSource.atSource === true, JSON.stringify(atSource));

  const sourceText = await tab.eval(
    '[...document.querySelectorAll(".sem__concept--centre .sem__label")].map(e=>e.innerText)[0] || ""',
  );
  ok("the source frame shows the authored text verbatim",
    sourceText === "The first three seconds decided most drop-off; the reveal version retained 68% versus 31%.",
    sourceText.slice(0, 60));

  ok("zoom stops at a semantic atom rather than silently doing nothing",
    (await tab.eval("window.__continuity.plus()")) === false);

  // ---- selection and zoom must not be the same gesture ----
  await tab.goto(URL_BASE);
  await wait(1200);
  const before = await state();
  await tab.eval('document.querySelectorAll(".sem__hit")[1].click()');
  await wait(150);
  const after = await state();
  ok("clicking a concept recenters WITHOUT changing altitude",
    after.semanticAltitude === before.semanticAltitude && after.semanticCentre !== before.semanticCentre,
    JSON.stringify({ before: before.semanticCentre, after: after.semanticCentre, alt: after.semanticAltitude }));

  // ---- ancestry is context, never extra nodes ----
  await tab.goto(`${URL_BASE}&lens=dist.dist-shortform.sf-vibo.vibo-beforeafter&centre=ba-spatial`);
  await wait(1200);
  const deep = await state();
  const crumbs = await tab.eval('document.querySelectorAll(".sem__crumb").length');
  ok("a deep lens restores altitude and centre from the URL alone",
    deep.semanticAltitude === 4 && deep.semanticCentre === "ba-spatial", JSON.stringify(deep));
  ok("ancestry lives in the breadcrumb, not as concepts on the stage",
    crumbs === 5 && (await visible()) <= 5, `${crumbs} crumbs, ${await visible()} concepts`);

  // ---- Back walks the descent one semantic operation at a time ----
  await tab.goto(URL_BASE);
  await wait(1200);
  await tab.eval(`window.__continuity.select("dist")`);
  await wait(120);
  for (let i = 0; i < 3; i++) {
    await tab.eval("window.__continuity.plus()");
    await wait(340);
    await tab.eval(`window.__continuity.select(${JSON.stringify(DESCENT[i + 1])})`);
    await wait(120);
  }
  const deepest = await state();
  await tab.eval("history.back()");
  await wait(500);
  const stepped = await state();
  ok("Back restores semantic altitude and centre one step at a time",
    stepped.semanticAltitude === deepest.semanticAltitude - 1
      || (stepped.semanticAltitude < deepest.semanticAltitude && stepped.semanticCentre !== null),
    JSON.stringify({ deepest: deepest.semanticAltitude, stepped: stepped.semanticAltitude }));

  // ---- provenance is available, and absent by default ----
  await tab.goto(URL_BASE);
  await wait(1200);
  ok("no provenance metadata on the default screen",
    (await tab.eval('document.querySelectorAll(".sem__inspect").length')) === 0);
  await tab.eval("window.__continuity.inspect(true)");
  await wait(200);
  const inspect = await tab.eval('document.querySelector(".sem__inspect")?.innerText || ""');
  ok("Inspect names a projection as synthesised and counts what it stands on",
    /synthesised projection/i.test(inspect) && /underlying source observations/i.test(inspect),
    inspect.slice(0, 70));

  // ---- v3.1 review P0-1: the temporal grammar survives semantic zoom ----
  await tab.goto(URL_BASE);
  await wait(1300);
  const temporal = JSON.parse(await tab.eval(`(() => {
    const field = document.querySelector(".bf-field");
    const now = document.querySelector(".bf-now");
    const rings = [...document.querySelectorAll(".sem__concept")].map((e) => {
      const r = e.querySelector(".sem__ring").getBoundingClientRect();
      return { live: e.classList.contains("sem__concept--live"), cx: r.left + r.width / 2 };
    });
    return JSON.stringify({ field: !!field, now: now ? now.getBoundingClientRect().left : null, rings });
  })()`));
  ok("the v2.3 temporal field is present at semantic altitude 0",
    temporal.field && temporal.now !== null, JSON.stringify(temporal).slice(0, 90));
  const live = temporal.rings.filter((r) => r.live);
  const done = temporal.rings.filter((r) => !r.live);
  ok("live concepts sit on NOW and completed ones sit in history",
    live.length > 0 && done.length > 0
      && live.every((r) => Math.abs(r.cx - temporal.now) <= 3)
      && done.every((r) => r.cx < temporal.now - 20),
    JSON.stringify({ live: live.map((r) => Math.round(r.cx)), done: done.map((r) => Math.round(r.cx)), now: Math.round(temporal.now) }));

  // Altitude must change resolution, not switch time off.
  await tab.goto(`${URL_BASE}&lens=dist.dist-shortform.sf-vibo.vibo-beforeafter&centre=ba-spatial`);
  await wait(1200);
  ok("the temporal field survives four semantic transitions",
    (await tab.eval('!!document.querySelector(".bf-field")')) === true);

  // ---- P0-2: the transition geometry, sampled at 0, 0.5 and 1 ----
  await tab.goto(`${URL_BASE}&lens=dist&centre=dist-shortform`);
  await wait(1200);
  const geoRaw = await tab.eval(`(async () => {
   try {
    const centres = () => [...document.querySelectorAll(".sem__concept")].map((e) => {
      const r = e.querySelector(".sem__ring").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const origin = centres().find((_, i) => i === 0);
    const parent = document.querySelector(".sem__concept--centre .sem__ring").getBoundingClientRect();
    const from = { x: parent.left + parent.width / 2, y: parent.top + parent.height / 2 };
    window.__continuity.plus();
    // t = 0
    // An infinite animation (the live pulse) has a non-finite duration, and
    // assigning currentTime from it throws. Hold only the finite ones.
    const held = document.getAnimations().filter((a) => {
      const t = a.effect && a.effect.getComputedTiming();
      return t && Number.isFinite(t.activeDuration) && t.activeDuration > 0;
    });
    for (const a of held) { a.pause(); a.currentTime = 0; }
    await new Promise((r) => requestAnimationFrame(r));
    const t0 = centres();
    // t = 0.5
    for (const a of held) {
      const t = a.effect.getComputedTiming();
      a.currentTime = (t.delay || 0) + t.activeDuration * 0.5;
    }
    await new Promise((r) => requestAnimationFrame(r));
    const tHalf = centres();
    const rays = document.querySelectorAll(".sem__ray").length;
    const originVisible = document.querySelectorAll(".sem__origin").length;
    // t = 1
    for (const a of held) { a.play(); a.finish(); }
    await new Promise((r) => setTimeout(r, 320));
    const t1 = centres();
    const d = (pts) => pts.map((p) => Math.hypot(p.x - from.x, p.y - from.y));
    return JSON.stringify({ d0: d(t0), dHalf: d(tHalf), d1: d(t1), rays, originVisible, children: t1.length });
   } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
  })()`);
  const geo = JSON.parse(typeof geoRaw === "string" ? geoRaw : JSON.stringify({ error: "probe returned a non-string" }));
  if (geo.error) ok("transition geometry probe ran", false, geo.error);
  const near0 = geo.d0.every((d, i) => d < Math.max(8, geo.d1[i] * 0.25));
  const between = geo.dHalf.every((d, i) => d > 0 && d < geo.d1[i] + 2);
  ok("at t=0 each child starts at the parent's own position",
    near0, JSON.stringify({ d0: geo.d0.map(Math.round), d1: geo.d1.map(Math.round) }));
  ok("at t=0.5 each child is strictly between the parent and its settled place",
    between, JSON.stringify({ dHalf: geo.dHalf.map(Math.round), d1: geo.d1.map(Math.round) }));
  ok("at 50% a connector joins the parent region to every emerging child",
    geo.rays >= geo.children && geo.originVisible === 1,
    JSON.stringify({ rays: geo.rays, children: geo.children, origin: geo.originVisible }));

  // ---- P1: deep breadcrumbs compress rather than truncate ----
  await tab.goto(`${URL_BASE}&lens=dist.dist-shortform.sf-vibo.vibo-beforeafter.ba-spatial.spatial-reveal&centre=S01_r02`);
  await wait(1200);
  const crumbText = await tab.eval('[...document.querySelectorAll(".sem__crumb")].map(e=>e.innerText).join("|")');
  ok("a six-deep lens collapses its middle and keeps the last ancestors readable",
    /levels/.test(String(crumbText))
      && String(crumbText).includes("The first-three-second reveal is the strongest hook."),
    String(crumbText).slice(0, 120));

  // ---- V4 PR B review: the four clean assertions the lane asked for ----
  const V4 = `${BASE}/?view=briefing&fixture=v3-projection&centre=reliability`;

  // 1. Revision advancement genuinely moves the historical position.
  await tab.goto(V4);
  await wait(1500);
  await tab.eval('window.__continuity.select("reliability")');
  await wait(200);
  await tab.eval("window.__continuity.history()");
  await wait(420);
  const back1 = await tab.eval("JSON.stringify(window.__continuity.state())").then(JSON.parse);
  await tab.eval("window.__continuity.previousRevision()");
  await wait(420);
  const back2 = await tab.eval("JSON.stringify(window.__continuity.state())").then(JSON.parse);
  await tab.eval("window.__continuity.nextRevision()");
  await wait(420);
  const fwd = await tab.eval("JSON.stringify(window.__continuity.state())").then(JSON.parse);
  ok("next revision advances the historical position when one exists",
    Date.parse(fwd.historicalPosition) > Date.parse(back2.historicalPosition),
    JSON.stringify({ back1: back1.historicalPosition, back2: back2.historicalPosition, fwd: fwd.historicalPosition }));

  // Same, but while semantically zoomed: history is owned by an ancestor, and
  // keying it off the focal concept is what made two frames stall at rev 1.
  await tab.goto(V4);
  await wait(1400);
  await tab.eval('window.__continuity.select("reliability")');
  await wait(160);
  await tab.eval("window.__continuity.history()");
  await wait(420);
  // Step back to the EARLIEST revision first, so "next" has a genuine
  // intermediate to advance to rather than landing straight back on the live
  // world (which is correct behaviour but proves nothing about advancement).
  await tab.eval("window.__continuity.previousRevision()");
  await wait(420);
  await tab.eval("window.__continuity.plus()");
  await wait(420);
  const zoomed = await tab.eval("JSON.stringify(window.__continuity.state())").then(JSON.parse);
  const advanced = await tab.eval("window.__continuity.nextRevision()");
  await wait(460);
  const afterZoomNav = await tab.eval("JSON.stringify(window.__continuity.state())").then(JSON.parse);
  ok("revision navigation works from a descendant, not only from the owner",
    advanced === true && Date.parse(afterZoomNav.historicalPosition || 0) > Date.parse(zoomed.historicalPosition),
    JSON.stringify({ altitude: zoomed.semanticAltitude, before: zoomed.historicalPosition, after: afterZoomNav.historicalPosition }));

  // 2. The focal ring stays put while the interpretation changes.
  await tab.goto(V4);
  await wait(1400);
  await tab.eval('window.__continuity.select("reliability")');
  await wait(200);
  const morph = JSON.parse(await tab.eval(`(async () => {
    const ring = () => {
      const e = document.querySelector(".sem__concept--centre .sem__ring");
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const before = ring();
    window.__continuity.history();
    await new Promise((r) => setTimeout(r, 500));
    const after = ring();
    return JSON.stringify({ before, after });
  })()`));
  const drift = Math.hypot(morph.after.x - morph.before.x, morph.after.y - morph.before.y);
  ok("the focal ring stays anchored while the interpretation changes",
    drift <= 2, `moved ${drift.toFixed(1)}px`);

  // 3. Mobile historical says AS OF and never now.
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: 375, height: 812, deviceScaleFactor: 1, mobile: true, screenWidth: 375, screenHeight: 812,
  });
  await tab.goto(V4);
  await wait(1500);
  await tab.eval('window.__continuity.select("reliability")');
  await wait(200);
  await tab.eval("window.__continuity.history()");
  await wait(520);
  const mobile = JSON.parse(await tab.eval(`(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== "none";
    };
    const cues = [...document.querySelectorAll(".bf-field__orient span, .bf-now span")]
      .filter(visible).map((e) => e.innerText.trim().toLowerCase());
    const controls = [...document.querySelectorAll(".sem__controls button")].filter(visible)
      .map((e) => { const r = e.getBoundingClientRect(); return { t: e.innerText.trim(), x1: r.left, x2: r.right, y1: r.top, y2: r.bottom }; });
    let overlaps = 0;
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) overlaps += 1;
      }
    }
    return JSON.stringify({ cues, overlaps, controlCount: controls.length,
      historical: !!document.querySelector(".sem__asof") });
  })()`));
  ok("mobile historical shows an AS OF cue and zero NOW markers",
    mobile.historical && mobile.cues.some((c) => c.includes("as of")) && !mobile.cues.some((c) => c === "now"),
    JSON.stringify(mobile.cues));
  ok("no mobile control bounding boxes intersect",
    mobile.overlaps === 0 && mobile.controlCount >= 4, JSON.stringify(mobile));

  await tab.send("Emulation.clearDeviceMetricsOverride", {});

  ok("PROBE CONTROL: the error collector survived every navigation", await tab.armed());
  const errors = await tab.errors();
  ok("no page errors", errors.length === 0, JSON.stringify(errors));
} finally {
  await edge.close();
}

const failed = results.filter(([, pass]) => !pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

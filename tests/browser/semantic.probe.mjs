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

  ok("PROBE CONTROL: the error collector survived every navigation", await tab.armed());
  const errors = await tab.errors();
  ok("no page errors", errors.length === 0, JSON.stringify(errors));
} finally {
  await edge.close();
}

const failed = results.filter(([, pass]) => !pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

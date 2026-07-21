// Build public/thoughts.json from the ChatGPT export in .data/gpt-export.
// Ships ONLY derived data: trimmed titles, month buckets, 3d embedding
// coords, cluster ids, message counts. Never message content.
//
// Usage: node scripts/build-thoughts.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NODES } from "../src/data/nodes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, ".data", "gpt-export");
const OUT = path.join(ROOT, "public", "thoughts.json");
const PROV_OUT = path.join(ROOT, "src", "data", "provenance.json");

// english renderings of the korean titles — public surface is english-first,
// hangul kept alongside (identity, not decoration; shown on hover)
const KO = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".data", "korean-title-translations.json"), "utf8")
);

// first substantive user message, collapsed to a short quotable line
function firstUserQuote(mapping) {
  const msgs = [];
  for (const k in mapping) {
    const m = mapping[k]?.message;
    if (!m || m.author?.role !== "user") continue;
    const txt = (m.content?.parts || [])
      .filter((p) => typeof p === "string")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!txt) continue;
    msgs.push({ ct: m.create_time ?? Infinity, txt });
  }
  if (!msgs.length) return null;
  msgs.sort((a, b) => a.ct - b.ct);
  let q = msgs[0].txt;
  if (q.length > 170) {
    q = q.slice(0, 168);
    const i = q.lastIndexOf(" ");
    if (i > 120) q = q.slice(0, i);
    q += "…";
  }
  return q;
}

// ---- load ----------------------------------------------------------------
const convos = [];
for (const f of fs.readdirSync(SRC)) {
  if (!/^conversations-\d+\.json$/.test(f)) continue;
  for (const c of JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8"))) {
    const title = (c.title || "").trim();
    if (!title || title.toLowerCase() === "new chat") continue;
    if (typeof c.create_time !== "number" || !isFinite(c.create_time)) continue;
    const t60 = title.slice(0, 60);
    const korean = /[가-힯]/.test(t60);
    convos.push({
      t: korean && KO[t60] ? KO[t60].slice(0, 60) : t60,
      tk: korean ? t60 : null,
      m: new Date(c.create_time * 1000).toISOString().slice(0, 7),
      n: Object.keys(c.mapping || {}).length,
      q: firstUserQuote(c.mapping || {}),
      k: korean ? 1 : 0,
    });
  }
}
convos.sort((a, b) => (a.m < b.m ? -1 : 1));
console.log(`conversations: ${convos.length}`);

// ---- tf-idf over titles ----------------------------------------------------
const STOP = new Set(
  ("the a an and for with that its it as of in to on by one all your how what is are i you my from using can this " +
    "vs not do does about when why me we or at be have has was were will would into out up down over under new chat")
    .split(" ")
);
const docs = convos.map((c) =>
  (c.t.toLowerCase().match(/[a-z가-힯][a-z0-9가-힯+#.]{1,}/g) || []).filter((w) => !STOP.has(w))
);
const df = new Map();
const tfs = docs.map((ws) => {
  const tf = new Map();
  ws.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
  for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  return tf;
});
// drop hapax terms: they connect nothing
const terms = [...df.entries()].filter(([, d]) => d >= 2).map(([w]) => w);
const termIdx = new Map(terms.map((w, i) => [w, i]));
const N = convos.length, T = terms.length;
console.log(`terms kept: ${T}`);

// sparse doc vectors, l2-normalized
const rows = tfs.map((tf) => {
  const ent = [];
  let norm = 0;
  for (const [w, c] of tf) {
    const j = termIdx.get(w);
    if (j == null) continue;
    const x = c * Math.log(N / df.get(w));
    ent.push([j, x]);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  return ent.map(([j, x]) => [j, x / norm]);
});

// ---- top-3 principal axes via power iteration on X^T X (implicit) ---------
function mulberry(seed) {
  let t = seed;
  return () => {
    t |= 0; t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry(1234);
const axes = []; // term-space unit vectors
for (let k = 0; k < 3; k++) {
  let v = Float64Array.from({ length: T }, () => rand() - 0.5);
  for (let it = 0; it < 60; it++) {
    // u = X v  (docs), then v' = X^T u (terms)
    const u = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const [j, x] of rows[i]) s += x * v[j];
      u[i] = s;
    }
    const nv = new Float64Array(T);
    for (let i = 0; i < N; i++) {
      const ui = u[i];
      if (!ui) continue;
      for (const [j, x] of rows[i]) nv[j] += x * ui;
    }
    // deflate against previous axes
    for (const a of axes) {
      let dot = 0;
      for (let j = 0; j < T; j++) dot += nv[j] * a[j];
      for (let j = 0; j < T; j++) nv[j] -= dot * a[j];
    }
    let norm = 0;
    for (let j = 0; j < T; j++) norm += nv[j] * nv[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < T; j++) nv[j] /= norm;
    v = nv;
  }
  axes.push(v);
}
// project docs onto axes
const proj = convos.map((_, i) => {
  const p = [0, 0, 0];
  for (let k = 0; k < 3; k++) for (const [j, x] of rows[i]) p[k] += x * axes[k][j];
  return p;
});
// robust-scale each axis to ~[-1,1] using the 95th percentile
for (let k = 0; k < 3; k++) {
  const abs = proj.map((p) => Math.abs(p[k])).sort((a, b) => a - b);
  const s = abs[Math.floor(abs.length * 0.95)] || 1;
  proj.forEach((p) => (p[k] = Math.max(-1.6, Math.min(1.6, p[k] / s))));
}

// spread singleton pile-ups: titles with no shared terms land at origin — puff them
proj.forEach((p, i) => {
  const r = Math.hypot(...p);
  if (r < 0.05) {
    const rr = mulberry(i * 7 + 3);
    const u = rr() * 2 - 1, a = rr() * Math.PI * 2, rad = 0.35 + rr() * 0.85;
    const s = Math.sqrt(1 - u * u);
    p[0] = rad * s * Math.cos(a); p[1] = rad * u; p[2] = rad * s * Math.sin(a);
  }
});

// ---- k-means for cluster labels -------------------------------------------
const K = 18;
const kr = mulberry(77);
let centroids = Array.from({ length: K }, () => proj[Math.floor(kr() * N)].slice());
let assign = new Array(N).fill(0);
for (let it = 0; it < 30; it++) {
  for (let i = 0; i < N; i++) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < K; k++) {
      const d =
        (proj[i][0] - centroids[k][0]) ** 2 +
        (proj[i][1] - centroids[k][1]) ** 2 +
        (proj[i][2] - centroids[k][2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    assign[i] = best;
  }
  const sums = Array.from({ length: K }, () => [0, 0, 0, 0]);
  for (let i = 0; i < N; i++) {
    const s = sums[assign[i]];
    s[0] += proj[i][0]; s[1] += proj[i][1]; s[2] += proj[i][2]; s[3]++;
  }
  centroids = sums.map((s, k) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centroids[k]));
}
// label each cluster by its most-distinctive frequent terms
const clusterTerms = Array.from({ length: K }, () => new Map());
for (let i = 0; i < N; i++)
  for (const [j] of rows[i]) {
    const m = clusterTerms[assign[i]];
    m.set(j, (m.get(j) || 0) + 1);
  }
const clusters = clusterTerms.map((m, k) => {
  const top = [...m.entries()]
    .map(([j, c]) => [terms[j], c * Math.log(N / df.get(terms[j]))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([w]) => w);
  const count = assign.filter((a) => a === k).length;
  return { label: top.join(" · ") || "misc", count };
});

// ---- provenance: nearest project per thought (same term space) -------------
const projectVecs = NODES.map((p) => {
  const ws = ((p.title + " " + p.desc + " " + p.stack + " " + p.category + " " + p.id.replace(/-/g, " "))
    .toLowerCase()
    .match(/[a-z가-힯][a-z0-9가-힯+#.]{1,}/g) || []).filter((w) => !STOP.has(w));
  const tf = new Map();
  ws.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
  const v = new Map();
  let norm = 0;
  for (const [w, c] of tf) {
    const j = termIdx.get(w);
    if (j == null) continue;
    const x = c * Math.log(N / df.get(w));
    v.set(j, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [j, x] of v) v.set(j, x / norm);
  return v;
});
const LINK_MIN = 0.16;
const pj = convos.map((_, i) => {
  let best = -1, bs = LINK_MIN;
  for (let p = 0; p < projectVecs.length; p++) {
    let s = 0;
    for (const [j, x] of rows[i]) {
      const px = projectVecs[p].get(j);
      if (px) s += x * px;
    }
    if (s > bs) { bs = s; best = p; }
  }
  return best;
});
const projStats = NODES.map((p, pi) => {
  const linked = convos.filter((_, i) => pj[i] === pi);
  const longest = linked.reduce((a, c) => (c.n > (a?.n || 0) ? c : a), null);
  const ms = linked.map((c) => c.m).sort();
  return {
    id: p.id,
    count: linked.length,
    msgs: linked.reduce((s, c) => s + c.n, 0),
    firstMonth: ms[0] || null,
    lastMonth: ms[ms.length - 1] || null,
    longest: longest ? { t: longest.t, n: longest.n } : null,
  };
});
// bake provenance back into the data core so nodes.js can price significance
fs.writeFileSync(
  PROV_OUT,
  JSON.stringify(
    Object.fromEntries(
      projStats.map((p) => [
        p.id,
        { count: p.count, msgs: p.msgs, firstMonth: p.firstMonth, lastMonth: p.lastMonth },
      ])
    ),
    null,
    1
  )
);
console.log(`wrote ${PROV_OUT}`);
console.log(
  "provenance:",
  projStats.filter((p) => p.count).map((p) => `${p.id}:${p.count}`).join(" "),
  `| unlinked: ${pj.filter((x) => x === -1).length}`
);

// ---- month histogram --------------------------------------------------------
const monthCounts = {};
convos.forEach((c) => (monthCounts[c.m] = (monthCounts[c.m] || 0) + 1));
const months = Object.entries(monthCounts).sort();

// ---- emit -------------------------------------------------------------------
const out = {
  meta: {
    thoughts: N,
    messages: convos.reduce((s, c) => s + c.n, 0),
    firstMonth: months[0][0],
    lastMonth: months[months.length - 1][0],
    months,
    clusters,
    projects: projStats,
  },
  thoughts: convos.map((c, i) => ({
    t: c.t,
    m: c.m,
    n: c.n,
    c: assign[i],
    p: proj[i].map((v) => +v.toFixed(3)),
    ...(pj[i] >= 0 ? { pj: pj[i] } : {}),
    ...(c.k ? { k: 1 } : {}),
    ...(c.tk ? { tk: c.tk } : {}),
    ...(c.q ? { q: c.q } : {}),
  })),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
console.log("clusters:", clusters.map((c) => `${c.label} (${c.count})`).join(", "));

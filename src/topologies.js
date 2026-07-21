import { NODES, CATEGORIES } from "./data/nodes.js";

// Deterministic pseudo-random so layouts are stable across renders.
function mulberry(seed) {
  let t = seed;
  return () => {
    t |= 0; t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const catKeys = Object.keys(CATEGORIES);

// ---- centralized: hub-and-spoke shells around a core -------------------
function layoutCentralized() {
  const rand = mulberry(7);
  const pos = [];
  const edges = [];
  NODES.forEach((n, i) => {
    const shell = 3.2 + (3 - n.weight) * 1.4 + rand() * 0.8;
    // fibonacci-ish sphere distribution
    const phi = Math.acos(1 - (2 * (i + 0.5)) / NODES.length);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    pos.push([
      shell * Math.sin(phi) * Math.cos(theta),
      shell * Math.cos(phi) * 0.72,
      shell * Math.sin(phi) * Math.sin(theta),
    ]);
    edges.push([-1, i]); // -1 = the core
  });
  return { pos, edges, core: [0, 0, 0] };
}

// ---- clustered: category centroids on a ring, gaussian puffs -----------
function layoutClustered() {
  const rand = mulberry(23);
  const centroids = {};
  catKeys.forEach((k, ci) => {
    const a = (ci / catKeys.length) * Math.PI * 2;
    centroids[k] = [Math.cos(a) * 5.0, (rand() - 0.5) * 1.6, Math.sin(a) * 5.0];
  });
  const pos = NODES.map((n) => {
    const c = centroids[n.category];
    const g = () => (rand() + rand() + rand() - 1.5) * 1.55;
    return [c[0] + g(), c[1] + g() * 0.7, c[2] + g()];
  });
  // edges: connect each node to its 2 nearest siblings in the same category
  const edges = [];
  NODES.forEach((n, i) => {
    const sibs = NODES.map((m, j) => ({ j, m }))
      .filter(({ j, m }) => j !== i && m.category === n.category)
      .map(({ j }) => ({
        j,
        d: (pos[i][0] - pos[j][0]) ** 2 + (pos[i][1] - pos[j][1]) ** 2 + (pos[i][2] - pos[j][2]) ** 2,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    sibs.forEach(({ j }) => {
      if (!edges.some(([a, b]) => (a === j && b === i))) edges.push([i, j]);
    });
  });
  return { pos, edges, core: null, centroids };
}

// ---- strata: projects float above the thought-terrain, placed on the ----
// ---- same real-time axis (months since 2023-01, z-aligned) ---------------
export const TIMEBASE = { m0: 2023 * 12 + 0, zOff: 32, dz: 0.55 };
export const monthZ = (m) => {
  const mi = +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1) - TIMEBASE.m0;
  return (mi - TIMEBASE.zOff) * TIMEBASE.dz;
};

function layoutStrata() {
  const rand = mulberry(41);
  const ERA_CENTER = { "2025a": "2025-03", "2025b": "2025-09", "2026": "2026-04" };
  const eras = [...new Set(NODES.map((n) => n.era))].sort();
  const pos = [];
  const byLayer = eras.map(() => []);
  NODES.forEach((n, i) => {
    byLayer[eras.indexOf(n.era)].push(i);
  });
  byLayer.forEach((layer, li) => {
    const zc = monthZ(ERA_CENTER[eras[li]] || "2025-09");
    layer.forEach((i, k) => {
      const fx = (k / Math.max(1, layer.length - 1)) * 2 - 1; // spread across x
      pos[i] = [
        fx * 6.4 + (rand() - 0.5) * 1.6,
        1.7 + rand() * 1.5 + Math.sin(fx * 2.2) * 0.35,
        zc + (rand() - 0.5) * 1.7,
      ];
    });
  });
  // edges: each node links to its 2 nearest siblings in the same layer,
  // plus one riser between consecutive layers (closest pair)
  const edges = [];
  const d2 = (i, j) =>
    (pos[i][0] - pos[j][0]) ** 2 + (pos[i][1] - pos[j][1]) ** 2 + (pos[i][2] - pos[j][2]) ** 2;
  byLayer.forEach((layer, li) => {
    layer.forEach((i) => {
      layer
        .filter((j) => j !== i)
        .map((j) => ({ j, d: d2(i, j) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
        .forEach(({ j }) => {
          if (!edges.some(([a, b]) => a === j && b === i)) edges.push([i, j]);
        });
    });
    if (li > 0) {
      let best = null;
      byLayer[li - 1].forEach((i) =>
        layer.forEach((j) => {
          const dd = d2(i, j);
          if (!best || dd < best.d) best = { i, j, d: dd };
        })
      );
      if (best) edges.push([best.i, best.j]);
    }
  });
  return { pos, edges, core: null, eras };
}

// ---- semantic: tf-idf embeddings of each project's own words, ----------
// ---- projected to 3d with classical MDS. no api, no fakery: the ---------
// ---- geometry IS what the descriptions say. ------------------------------
function layoutSemantic() {
  const N = NODES.length;
  const STOP = new Set([
    "the", "a", "an", "and", "for", "with", "that", "its", "it", "as", "of",
    "in", "to", "on", "by", "one", "all", "your", "before", "between", "out",
  ]);
  const docs = NODES.map((n) =>
    (n.title + " " + n.desc + " " + n.stack + " " + n.category)
      .toLowerCase()
      .match(/[a-z][a-z0-9+.]+/g)
      .filter((w) => !STOP.has(w))
  );
  const df = {};
  const tfs = docs.map((ws) => {
    const tf = {};
    ws.forEach((w) => (tf[w] = (tf[w] || 0) + 1));
    Object.keys(tf).forEach((w) => (df[w] = (df[w] || 0) + 1));
    return tf;
  });
  const vecs = tfs.map((tf) => {
    const v = {};
    let norm = 0;
    for (const [w, c] of Object.entries(tf)) {
      const x = c * Math.log(N / df[w]);
      v[w] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    Object.keys(v).forEach((w) => (v[w] /= norm));
    return v;
  });
  const cos = (a, b) => {
    let s = 0;
    for (const w in a) if (b[w]) s += a[w] * b[w];
    return s;
  };
  const S = vecs.map((a) => vecs.map((b) => cos(a, b)));

  // classical MDS: double-center squared distances, take top-3 eigenvectors
  const D2 = S.map((r) => r.map((s) => (1 - s) ** 2));
  const rowM = D2.map((r) => r.reduce((x, y) => x + y, 0) / N);
  const totM = rowM.reduce((x, y) => x + y, 0) / N;
  let M = D2.map((r, i) => r.map((v, j) => -0.5 * (v - rowM[i] - rowM[j] + totM)));
  const rand = mulberry(97);
  const axes = [];
  for (let k = 0; k < 3; k++) {
    let v = Array.from({ length: N }, () => rand() - 0.5);
    let lam = 0;
    for (let it = 0; it < 160; it++) {
      const nv = M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
      lam = Math.sqrt(nv.reduce((s, x) => s + x * x, 0)) || 1;
      v = nv.map((x) => x / lam);
    }
    axes.push(v.map((x) => x * Math.sqrt(Math.max(lam, 0))));
    M = M.map((row, i) => row.map((x, j) => x - lam * v[i] * v[j])); // deflate
  }
  let max = 0;
  for (let i = 0; i < N; i++)
    max = Math.max(max, Math.hypot(axes[0][i], axes[1][i], axes[2][i]));
  const sc = 6.4 / (max || 1);
  const pos = NODES.map((_, i) => [axes[0][i] * sc, axes[1][i] * sc * 0.75, axes[2][i] * sc]);

  // edges + neighbors: 2 most-similar thoughts per node (genuinely meaningful)
  const edges = [];
  const neighbors = [];
  for (let i = 0; i < N; i++) {
    const near = S[i]
      .map((s, j) => ({ j, s }))
      .filter((o) => o.j !== i)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);
    neighbors.push(near.map((o) => o.j));
    near.forEach(({ j }) => {
      if (!edges.some(([a, b]) => a === j && b === i)) edges.push([i, j]);
    });
  }
  return { pos, edges, core: null, neighbors };
}

export const LAYOUTS = {
  centralized: layoutCentralized(),
  clustered: layoutClustered(),
  strata: layoutStrata(),
  semantic: layoutSemantic(),
};

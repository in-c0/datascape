// The message-level corpus pipeline — supersedes build-thoughts.mjs.
// Reads the FULL export (every user message, not just titles) and emits:
//   public/thoughts.json      — same shape as before, better values:
//                               embeddings/clusters/provenance from content,
//                               plus per-thought depth fields (uw/kr/qd/dur)
//   src/data/provenance.json  — provenance v2 (content-grounded links)
//   src/data/corpus.json      — the measured tier's raw material: monthly
//                               voice metrics, tech/skill timeline, motifs
// Ships only derived data + titles + short first-message quotes. Never full
// message content.
//
// Usage: node scripts/build-corpus.mjs   (takes a minute or two)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSensitiveText } from "./detect-private.mjs";

// The "bring your own data" pipeline. Reads your raw ChatGPT export from
// .data/gpt-export and the project list you authored in DATA_DIR/content.json,
// and writes thoughts.json + provenance.json + corpus.json into DATA_DIR.
// Point datascape.config.js `dataBase` at "/data/" (or upload DATA_DIR to
// Cloudflare) to run the site on your real corpus.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, ".data", "gpt-export");
const DATA_DIR = path.join(ROOT, "public", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const OUT = path.join(DATA_DIR, "thoughts.json");
const PROV_OUT = path.join(DATA_DIR, "provenance.json");
const CORPUS_OUT = path.join(DATA_DIR, "corpus.json");

// your project list — authored by you (start from public/sample-data/content.json)
const CONTENT_PATH = path.join(DATA_DIR, "content.json");
if (!fs.existsSync(CONTENT_PATH)) {
  console.error(`missing ${CONTENT_PATH} — copy public/sample-data/content.json there and edit it to list your projects.`);
  process.exit(1);
}
const PROJECTS = JSON.parse(fs.readFileSync(CONTENT_PATH, "utf8")).projects;

// optional: map non-English titles to English (see the Korean example in docs).
// {} means titles ship as-is.
const KO_PATH = path.join(ROOT, ".data", "title-translations.json");
const KO = fs.existsSync(KO_PATH) ? JSON.parse(fs.readFileSync(KO_PATH, "utf8")) : {};

// ---- Directive 8: the privacy layer ----------------------------------------
// private terms (real names) live GITIGNORED in .data — they are scrubbed
// from every shipped string; sensitive conversations keep their dot but ship
// abstracted (no title, no hangul, no quote). over-scrub by default.
const PRIV_PATH = path.join(ROOT, ".data", "private-terms.json");
const PRIV_RAW = fs.existsSync(PRIV_PATH)
  ? JSON.parse(fs.readFileSync(PRIV_PATH, "utf8"))
  : { manualTerms: [] };
// manualTerms is the SOLE source of truth — the words SHE types, nothing
// auto-merged. (`terms` is a legacy mirror; prefer manualTerms if present.)
const PRIV = { terms: [...new Set(PRIV_RAW.manualTerms || PRIV_RAW.terms || [])] };
// \b is ASCII-only — it silently never matches around hangul, so non-ASCII
// terms (korean names) scrub as plain substrings instead
const TERM_RES = (PRIV.terms || [])
  .filter((t) => t && t.length >= 2)
  .map((t) => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[\x00-\x7F]+$/.test(t)
      ? new RegExp(`\\b${esc}\\b`, "gi")
      : new RegExp(esc, "gi");
  });
const scrub = (s) => {
  if (!s) return s;
  let out = s;
  for (const re of TERM_RES) out = out.replace(re, "◌");
  return out;
};
const isSensitive = (title, q, text) => {
  const head = (title + " " + (q || "")).toLowerCase();
  if (isSensitiveText(head)) return true; // announced personal → abstract
  // names alone don't abstract a conversation — they get scrubbed instead;
  // body-only signals must be dense (both halves) to quiet a whole thought
  return isSensitiveText(text.slice(0, 2000)) && isSensitiveText(text.slice(2000, 8000));
};

// ---- lexicons (measured means countable) -----------------------------------
const TECH = {
  python: ["python", "pip", "pypi"], javascript: ["javascript", "js"], typescript: ["typescript"],
  react: ["react", "jsx"], "next.js": ["nextjs", "next.js"], node: ["nodejs", "node.js", "npm"],
  flutter: ["flutter", "dart"], unity: ["unity"], "c#": ["c#", "csharp"], "c++": ["c++", "cpp"],
  rust: ["rust", "cargo"], go: ["golang"], docker: ["docker", "dockerfile"],
  aws: ["aws", "lambda", "ec2", "s3"], gcp: ["gcp", "cloud run", "google cloud"],
  firebase: ["firebase", "firestore"], supabase: ["supabase"], postgres: ["postgres", "postgresql"],
  sql: ["sql", "sqlite"], whisper: ["whisper"], ffmpeg: ["ffmpeg"], electron: ["electron"],
  "chrome ext": ["chrome extension", "manifest v3", "content script"],
  webgl: ["webgl", "three.js", "threejs", "shader"], godot: ["godot", "gdscript"],
  pytorch: ["pytorch", "torch"], tensorflow: ["tensorflow"], "hugging face": ["huggingface", "hugging face"],
  llm: ["llm", "gpt", "claude", "openai api", "anthropic", "fine-tun", "prompt engineering"],
  "stable diffusion": ["stable diffusion", "comfyui"], fastapi: ["fastapi"], flask: ["flask"],
  django: ["django"], vite: ["vite"], tailwind: ["tailwind"], prisma: ["prisma"],
  stripe: ["stripe"], cloudflare: ["cloudflare", "wrangler", "workers kv", "r2 bucket"],
  vercel: ["vercel"], heroku: ["heroku"], git: ["git ", "git\n", "github"],
  websocket: ["websocket"], obs: ["obs studio", "obs plugin"], audacity: ["audacity"],
  "computer vision": ["opencv", "mediapipe", "yolo", "bounding box", "image classification"],
  embeddings: ["embedding", "vector database", "cosine similarity", "rag "],
  blender: ["blender"], figma: ["figma"], arduino: ["arduino", "raspberry pi", "esp32"],
};
const MOTIFS = {
  "lucid dreaming": ["lucid dream"],
  "time dilation": ["time dilation", "time dilat", "subjective time"],
  "minds in machines": ["is the mind", "machine consciousness", "sentien", "digital mind", "mind upload"],
  journaling: ["journal"],
  "financial independence": ["financial independence", "financial freedom"],
  "day one": ["day one", "everyday is day 1", "day 1 mentality"],
  "self-belief": ["believe in myself", "trust myself", "저를 믿", "스스로를 믿"],
};
const BUILD_WORDS = new Set("build built building deploy deployed ship shipped launch launched code coding debug fix fixed error implement implementation server api endpoint database commit release install setup config".split(" "));
const WONDER_WORDS = new Set("why meaning feel feeling think wonder believe life self dream soul happiness afraid fear love lonely purpose philosophy conscious".split(" "));

const STOP = new Set(
  ("the a an and for with that its it as of in to on by one all your how what is are i you my from using can this vs not do does about when why me we or at be have has was were will would into out up down over under new chat please help need want make just like get use so if then than there here should could also its it's im i'm dont don't can't its let lets ok okay yes no now some more most much many very really thing things way file code line error work works working right left good bad but they them their he she his her hers our us been being had did doing say said see try trying tried after before because while each other same different only own too any both few between").split(" ")
);

// ---- pass 1: load conversations, extract user text + metrics ----------------
const convos = [];
for (const f of fs.readdirSync(SRC).sort()) {
  if (!/^conversations-\d+\.json$/.test(f)) continue;
  const arr = JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8"));
  for (const c of arr) {
    const title = (c.title || "").trim();
    if (!title || title.toLowerCase() === "new chat") continue;
    if (typeof c.create_time !== "number" || !isFinite(c.create_time)) continue;

    let userText = "";
    let userMsgs = 0, questions = 0, userChars = 0, koChars = 0;
    let firstT = Infinity, lastT = 0, firstQ = null, firstQT = Infinity;
    let msgCount = 0;
    for (const k in c.mapping || {}) {
      const m = c.mapping[k]?.message;
      if (!m) continue;
      msgCount++;
      const t = m.create_time ?? null;
      if (t) { firstT = Math.min(firstT, t); lastT = Math.max(lastT, t); }
      if (m.author?.role !== "user") continue;
      const txt = (m.content?.parts || []).filter((p) => typeof p === "string").join(" ");
      if (!txt.trim()) continue;
      userMsgs++;
      userChars += txt.length;
      koChars += (txt.match(/[가-힯]/g) || []).length;
      if (/\?/.test(txt)) questions++;
      if (userText.length < 60000) userText += " " + txt;
      const clean = txt.replace(/\s+/g, " ").trim();
      if (clean && t != null && t < firstQT) { firstQT = t; firstQ = clean; }
    }
    let q = firstQ;
    if (q && q.length > 170) {
      q = q.slice(0, 168);
      const sp = q.lastIndexOf(" ");
      if (sp > 120) q = q.slice(0, sp);
      q += "…";
    }
    const t60 = title.slice(0, 60);
    const korean = /[가-힯]/.test(t60);
    convos.push({
      t: korean && KO[t60] ? KO[t60].slice(0, 60) : t60,
      tk: korean ? t60 : null,
      m: new Date(c.create_time * 1000).toISOString().slice(0, 7),
      n: msgCount,
      q,
      k: korean ? 1 : 0,
      // depth fields (shipped)
      uw: Math.round(userChars / 5.2), // ≈ user word count
      kr: userChars ? +(koChars / userChars).toFixed(2) : 0,
      qd: userMsgs ? +(questions / userMsgs).toFixed(2) : 0,
      dur: isFinite(firstT) && lastT > firstT ? +((lastT - firstT) / 86400).toFixed(1) : 0,
      // working fields (not shipped)
      _text: (t60 + " " + userText).toLowerCase(),
      _userMsgs: userMsgs,
      _userChars: userChars,
    });
  }
}
convos.sort((a, b) => (a.m < b.m ? -1 : 1));
console.log(`conversations: ${convos.length} · user text loaded`);

// ---- pass 2: tf-idf over FULL user text -------------------------------------
const tokenize = (s) =>
  (s.match(/[a-z가-힯][a-z0-9가-힯+#.']{1,}/g) || []).filter((w) => !STOP.has(w) && w.length < 24);

const df = new Map();
const tfs = convos.map((c) => {
  const tf = new Map();
  const words = tokenize(c._text);
  // cap per-convo influence: long chats shouldn't own the space
  const cap = words.slice(0, 5000);
  cap.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
  for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  return tf;
});
// keep discriminative vocab: appears in ≥3 convos, ≤40% of corpus
const N = convos.length;
const terms = [...df.entries()]
  .filter(([, d]) => d >= 3 && d <= N * 0.4)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12000)
  .map(([w]) => w);
const termIdx = new Map(terms.map((w, i) => [w, i]));
const T = terms.length;
console.log(`vocab kept: ${T}`);

const rows = tfs.map((tf) => {
  const ent = [];
  let norm = 0;
  for (const [w, cnt] of tf) {
    const j = termIdx.get(w);
    if (j == null) continue;
    const x = (1 + Math.log(cnt)) * Math.log(N / df.get(w));
    ent.push([j, x]);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  return ent.map(([j, x]) => [j, x / norm]);
});

// ---- 3 principal axes via power iteration -----------------------------------
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
const axes = [];
for (let k = 0; k < 3; k++) {
  let v = Float64Array.from({ length: T }, () => rand() - 0.5);
  for (let it = 0; it < 50; it++) {
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
const proj = convos.map((_, i) => {
  const p = [0, 0, 0];
  for (let k = 0; k < 3; k++) for (const [j, x] of rows[i]) p[k] += x * axes[k][j];
  return p;
});
for (let k = 0; k < 3; k++) {
  const abs = proj.map((p) => Math.abs(p[k])).sort((a, b) => a - b);
  const s = abs[Math.floor(abs.length * 0.95)] || 1;
  proj.forEach((p) => (p[k] = Math.max(-1.6, Math.min(1.6, p[k] / s))));
}
proj.forEach((p, i) => {
  const r = Math.hypot(...p);
  if (r < 0.05) {
    const rr = mulberry(i * 7 + 3);
    const u = rr() * 2 - 1, a = rr() * Math.PI * 2, rad = 0.35 + rr() * 0.85;
    const s = Math.sqrt(1 - u * u);
    p[0] = rad * s * Math.cos(a); p[1] = rad * u; p[2] = rad * s * Math.sin(a);
  }
});

// ---- k-means + content-grounded labels --------------------------------------
const K = 18;
const kr2 = mulberry(77);
let centroids = Array.from({ length: K }, () => proj[Math.floor(kr2() * N)].slice());
const assign = new Array(N).fill(0);
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
// labels come from TITLES — human-named, human-readable — while the
// clustering itself stays content-based. full-text labels surface code and
// coursework jargon; titles say what a conversation was actually about.
const titleDf = new Map();
const titleToks = convos.map((c) => {
  const toks = [...new Set(tokenize(c.t.toLowerCase()))].filter(
    (w) => /^[a-z]/.test(w) && !/\d/.test(w) && w.length > 2
  );
  toks.forEach((w) => titleDf.set(w, (titleDf.get(w) || 0) + 1));
  return toks;
});
const clusterSize = Array.from({ length: K }, (_, k) => assign.filter((a) => a === k).length);
const clusters = Array.from({ length: K }, (_, k) => {
  const counts = new Map();
  for (let i = 0; i < N; i++) {
    if (assign[i] !== k) continue;
    for (const w of titleToks[i]) counts.set(w, (counts.get(w) || 0) + 1);
  }
  const privLower = new Set((PRIV.terms || []).map((t) => t.toLowerCase()));
  const top = [...counts.entries()]
    .filter(([w, c]) => c >= 2 && titleDf.get(w) >= 3 && !privLower.has(w))
    .map(([w, c]) => [w, c * Math.log(N / titleDf.get(w))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  return { label: top.slice(0, 2).join(" · ") || "misc", terms: top, count: clusterSize[k] };
});

// ---- provenance v2: linked in title+opening space, guarded ------------------
// full-text cosine drowns short project descriptions, so links live in the
// space of what a conversation ANNOUNCES itself to be (title + opening
// message) — with a shared-vocabulary guard so one generic word can't fake
// a link (the old pipeline's habit-tracker→youtubetotext failure mode).
const provDocs = convos.map((c) => tokenize(c.t.toLowerCase()));
const provDf = new Map();
provDocs.forEach((ws) => new Set(ws).forEach((w) => provDf.set(w, (provDf.get(w) || 0) + 1)));
const provVec = (ws) => {
  const tf = new Map();
  ws.forEach((w) => { if ((provDf.get(w) || 0) >= 2) tf.set(w, (tf.get(w) || 0) + 1); });
  const v = new Map();
  let norm = 0;
  for (const [w, cnt] of tf) {
    const x = cnt * Math.log(N / provDf.get(w));
    v.set(w, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [w, x] of v) v.set(w, x / norm);
  return v;
};
const convVecs = provDocs.map(provVec);
const projectVecs = PROJECTS.map((p) =>
  provVec(tokenize((p.title + " " + p.desc + " " + p.stack + " " + p.category + " " + p.id.replace(/-/g, " ") + " " + (p.aka || "")).toLowerCase()))
);
// a real link needs a SPECIFIC anchor — some shared term that is rare in the
// corpus (a project name, "transcript", "keepr"), not just generic overlap
// ("data" + "cloud" faking a link, the old habit-tracker failure mode)
// sensitivity computed once — used for provenance exclusion AND shipping
const sens = convos.map((c) => isSensitive(c.t, c.q, c._text));

const LINK_MIN = 0.18;
const ANCHOR_DF_MAX = 30;
// broad-domain words may contribute to the score but never anchor a link alone
const NO_ANCHOR = new Set("cloud data local sync app apps web server code run running project projects react python node api ai game games video videos chat google image images model file files github chrome extension design system idea ideas".split(" "));
const pj = convos.map((_, i) => {
  let best = -1, bs = LINK_MIN;
  for (let p = 0; p < projectVecs.length; p++) {
    let s = 0, anchored = false;
    for (const [w, x] of convVecs[i]) {
      const px = projectVecs[p].get(w);
      if (px) {
        s += x * px;
        if (provDf.get(w) <= ANCHOR_DF_MAX && !NO_ANCHOR.has(w)) anchored = true;
      }
    }
    if (anchored && s > bs) { bs = s; best = p; }
  }
  return best;
});
// private thoughts never join a build story or light a constellation
sens.forEach((isS, i) => { if (isS) pj[i] = -1; });
const projStats = PROJECTS.map((p, pi) => {
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
console.log(
  "provenance v2:",
  projStats.filter((p) => p.count).map((p) => `${p.id}:${p.count}`).join(" "),
  `| linked: ${pj.filter((x) => x >= 0).length}`
);

// ---- voice metrics by month + skills + motifs -------------------------------
const monthly = {};
for (const c of convos) {
  const mo = (monthly[c.m] = monthly[c.m] || {
    convos: 0, msgs: 0, userWords: 0, koChars: 0, chars: 0, questions: 0,
    build: 0, wonder: 0, lex: 0, vocab: new Set(),
  });
  mo.convos++;
  mo.msgs += c.n;
  mo.userWords += c.uw;
  mo.chars += c._userChars;
  mo.koChars += Math.round(c.kr * c._userChars);
  mo.questions += Math.round(c.qd * c._userMsgs);
  const words = tokenize(c._text).slice(0, 3000);
  for (const w of words) {
    mo.lex++;
    if (mo.vocab.size < 30000) mo.vocab.add(w);
    if (BUILD_WORDS.has(w)) mo.build++;
    if (WONDER_WORDS.has(w)) mo.wonder++;
  }
}
const voice = Object.entries(monthly)
  .sort()
  .map(([m, v]) => ({
    m,
    convos: v.convos,
    words: v.userWords,
    avgWordsPerConvo: Math.round(v.userWords / v.convos),
    questionRate: v.msgs ? +(v.questions / v.convos).toFixed(1) : 0,
    koreanShare: v.chars ? +(v.koChars / v.chars).toFixed(3) : 0,
    vocabRichness: v.lex ? +(v.vocab.size / v.lex).toFixed(3) : 0,
    build: v.lex ? +(v.build / v.lex).toFixed(4) : 0,
    wonder: v.lex ? +(v.wonder / v.lex).toFixed(4) : 0,
  }));

const skills = {};
for (const c of convos) {
  for (const [tech, pats] of Object.entries(TECH)) {
    let hits = 0;
    for (const p of pats) {
      let idx = 0;
      while ((idx = c._text.indexOf(p, idx)) !== -1 && hits < 200) { hits++; idx += p.length; }
    }
    if (!hits) continue;
    const s = (skills[tech] = skills[tech] || { mentions: 0, convos: 0, first: c.m, last: c.m, byYear: {} });
    s.mentions += hits;
    s.convos++;
    if (c.m < s.first) s.first = c.m;
    if (c.m > s.last) s.last = c.m;
    const y = c.m.slice(0, 4);
    s.byYear[y] = (s.byYear[y] || 0) + hits;
  }
}
const skillList = Object.entries(skills)
  .map(([tech, s]) => ({ tech, ...s }))
  .sort((a, b) => b.convos - a.convos);

const motifs = {};
for (const [motif, pats] of Object.entries(MOTIFS)) {
  const byYear = {};
  let total = 0;
  for (const c of convos) {
    if (pats.some((p) => c._text.includes(p))) {
      const y = c.m.slice(0, 4);
      byYear[y] = (byYear[y] || 0) + 1;
      total++;
    }
  }
  motifs[motif] = { convos: total, byYear };
}

// ---- emit --------------------------------------------------------------------
const monthCounts = {};
convos.forEach((c) => (monthCounts[c.m] = (monthCounts[c.m] || 0) + 1));
const months = Object.entries(monthCounts).sort();

const out = {
  meta: {
    thoughts: N,
    messages: convos.reduce((s, c) => s + c.n, 0),
    firstMonth: months[0][0],
    lastMonth: months[months.length - 1][0],
    months,
    clusters,
    projects: projStats,
    depth: "message-level", // the flag that the corpus is no longer titles
  },
  thoughts: convos.map((c, i) => {
    const s = sens[i];
    return s
      ? {
          // Directive 8: the dot stays, the content goes quiet
          t: "a private thought",
          m: c.m,
          n: c.n,
          c: assign[i],
          p: proj[i].map((v) => +v.toFixed(3)),
          ...(c.k ? { k: 1 } : {}),
          uw: c.uw,
          ...(c.dur ? { dur: c.dur } : {}),
          s: 1,
        }
      : {
          t: scrub(c.t),
          m: c.m,
          n: c.n,
          c: assign[i],
          p: proj[i].map((v) => +v.toFixed(3)),
          ...(pj[i] >= 0 ? { pj: pj[i] } : {}),
          ...(c.k ? { k: 1 } : {}),
          ...(c.tk ? { tk: scrub(c.tk) } : {}),
          ...(c.q ? { q: scrub(c.q) } : {}),
          uw: c.uw,
          ...(c.kr ? { kr: c.kr } : {}),
          ...(c.qd ? { qd: c.qd } : {}),
          ...(c.dur ? { dur: c.dur } : {}),
        };
  }),
};
fs.writeFileSync(OUT, JSON.stringify(out));
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
fs.writeFileSync(
  CORPUS_OUT,
  JSON.stringify({ _readme: "message-level aggregates — the measured tier's raw material. voice: monthly metrics from her actual words. skills: tech lexicon hits with first-seen dates (evidence, not claims). motifs: her named recurrences counted by year.", voice, skills: skillList, motifs }, null, 1)
);
console.log(`wrote thoughts.json (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB), corpus.json (${(fs.statSync(CORPUS_OUT).size / 1024).toFixed(0)} KB)`);
console.log("clusters:", clusters.map((c) => `${c.label}(${c.count})`).join(" "));
console.log("top skills:", skillList.slice(0, 12).map((s) => `${s.tech}:${s.convos}`).join(" "));
console.log("motifs:", Object.entries(motifs).map(([m, v]) => `${m}:${v.convos}`).join(" "));

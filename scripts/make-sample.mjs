// Generate the synthetic sample dataset — a fictional maker, "Sam Rivers",
// so the template runs with zero setup and shows the engine off with a real-
// feeling landscape. Everything here is invented; swap it for your own by
// running the real pipeline (build-corpus / build-evidence / git-walk) on your
// ChatGPT export and project folders. Output → public/sample-data/.
//
// Usage: node scripts/make-sample.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sample-data");
fs.mkdirSync(OUT, { recursive: true });
const write = (name, obj) => {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
  console.log(`  ${name.padEnd(18)} ${(fs.statSync(path.join(OUT, name)).size / 1024).toFixed(1)} KB`);
};

// deterministic PRNG so the sample is stable across runs
let seed = 20260718;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const range = (n) => Array.from({ length: n }, (_, i) => i);
const round = (v, d = 2) => +v.toFixed(d);

// ── the persona ──────────────────────────────────────────────────────────
const CATEGORIES = {
  "web tools": { hue: "#CDEF4A" },
  "games & play": { hue: "#FF9EC6" },
  "ai experiments": { hue: "#8FB0FF" },
  "writing": { hue: "#7FDCB2" },
  "hardware": { hue: "#FFD37A" },
};

const MONTHS = [];
for (let y = 2024; y <= 2025; y++) for (let m = 1; m <= 12; m++) MONTHS.push(`${y}-${String(m).padStart(2, "0")}`);
const LAST_MONTH = MONTHS[MONTHS.length - 1];
const midx = (m) => +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1);

// projects — order matters: thoughts index into this array by position (pj)
const PROJECTS = [
  { id: "tab-tamer", title: "TabTamer", category: "web tools", era: "2024", desc: "a browser extension that auto-groups your tabs by what you're actually doing.", stack: "typescript/chrome", status: "live", flagship: true, visibility: "reveal", first: "2024-02", last: "2024-09", commits: 141, url: "https://tabtamer.example.com" },
  { id: "loopdeck", title: "LoopDeck", category: "games & play", era: "2024", desc: "a tiny rhythm game where the level is the song's own waveform.", stack: "typescript/webaudio", status: "live", flagship: true, visibility: "reveal", first: "2024-05", last: "2025-01", commits: 96, url: "https://loopdeck.example.com" },
  { id: "quiet-inbox", title: "QuietInbox", category: "ai experiments", era: "2024", desc: "summarizes a noisy newsletter folder into one calm morning digest.", stack: "python/fastapi", status: "building", flagship: false, visibility: "reveal", first: "2024-08", last: "2025-06", commits: 63 },
  { id: "field-notes", title: "FieldNotes", category: "writing", era: "2025", desc: "a plain-text journaling cli that turns entries into a searchable garden.", stack: "rust", status: "live", flagship: false, visibility: "reveal", first: "2025-01", last: "2025-07", commits: 108, url: "https://fieldnotes.example.com" },
  { id: "palm-synth", title: "PalmSynth", category: "hardware", era: "2025", desc: "a pocket synthesizer on a $4 microcontroller, one knob, endless drones.", stack: "c++/embedded", status: "building", flagship: false, visibility: "reveal", first: "2025-03", last: "2025-05", commits: 34 },
  { id: "recipe-graph", title: "RecipeGraph", category: "ai experiments", era: "2025", desc: "point a photo of your fridge at it, get a graph of what you can cook.", stack: "python/torch", status: "soon", flagship: false, visibility: "reveal", first: "2025-04", last: "2025-07", commits: 47, url: "https://recipegraph.example.com" },
  { id: "dawn-timer", title: "DawnTimer", category: "web tools", era: "2025", desc: "a gentle focus timer that follows the actual sunrise where you live.", stack: "svelte", status: "live", flagship: false, visibility: "reveal", first: "2025-02", last: "2025-06", commits: 71, url: "https://dawntimer.example.com" },
  { id: "spritefarm", title: "SpriteFarm", category: "games & play", era: "2024", desc: "a little zoo of pixel creatures that evolve from your git commits.", stack: "typescript/canvas", status: "archived", flagship: false, visibility: "reveal", first: "2024-03", last: "2024-06", commits: 52 },
];
const PID = (i) => PROJECTS[i].id;

// ── thoughts ─────────────────────────────────────────────────────────────
// clusters = the domains Sam thinks in. each thought lands in one, near its
// centroid on a sphere, so the semantic topology reads as real neighborhoods.
const CLUSTERS = [
  { label: "browser tooling", terms: ["tabs", "extension", "chrome"] },
  { label: "audio & rhythm", terms: ["waveform", "synth", "beat"] },
  { label: "llm plumbing", terms: ["prompt", "summarize", "embedding"] },
  { label: "journaling & habit", terms: ["journal", "habit", "morning"] },
  { label: "microcontrollers", terms: ["firmware", "solder", "sensor"] },
  { label: "game feel", terms: ["sprite", "juice", "level"] },
  { label: "shipping & doubt", terms: ["launch", "quit", "ship"] },
  { label: "learning notes", terms: ["rust", "torch", "study"] },
];
// a spread of message templates per cluster (question-shaped and statement)
const T = {
  0: ["how do i detect which tabs belong to the same task?", "chrome storage keeps dropping my tab groups on restart — why?", "idea: cluster tabs by the domain graph, not just the domain", "manifest v3 broke my background worker, what replaced it?"],
  1: ["how do i turn a wav into a playable level layout?", "the web audio clock drifts against requestAnimationFrame — fix?", "what makes a rhythm game feel tight vs mushy?", "can i generate a drone from a single oscillator and feedback?"],
  2: ["summarize a folder of newsletters into one digest — best approach?", "how do i keep the summary from hallucinating a sender's name?", "is a local embedding model good enough to cluster emails?", "prompt keeps ignoring my json schema, how do i force it"],
  3: ["a journaling cli that turns entries into a searchable garden", "how do i get 1% better every day without it feeling like a chore?", "should the morning digest come before or after coffee?", "what's a good plain-text format that survives 10 years?"],
  4: ["one knob, one oscillator — what's the minimum viable synth?", "my microcontroller browns out when the speaker kicks in, why?", "how do i debounce a single knob cleanly in firmware?", "can a $4 chip do wavetable synthesis at all?"],
  5: ["pixel creatures that evolve from commit history — how to map genes?", "what gives a sprite game 'juice' with almost no art?", "how many frames does a satisfying jump actually need?", "should the zoo persist locally or sync to a repo?"],
  6: ["is it okay to archive a project i still love but never open?", "how do i know when a side project is actually done?", "launching tomorrow and i'm terrified nobody will care", "why do i start three things the week i almost finish one?"],
  7: ["rust borrow checker is fighting me on this tree, help", "what's the cleanest way to learn torch without a course?", "taking notes on everything i build — is that overkill?", "how do i study a codebase i didn't write?"],
};
const TITLES = {
  0: ["Tab grouping heuristics", "MV3 worker port", "Domain graph clustering", "Storage persistence bug"],
  1: ["Waveform to level", "Audio clock drift", "Rhythm game feel", "Single-osc drone"],
  2: ["Newsletter digest", "Summary grounding", "Local embed clustering", "JSON schema prompt"],
  3: ["Journaling garden", "1% every day", "Digest timing", "Durable note format"],
  4: ["Minimum viable synth", "Brownout on speaker", "Knob debounce", "Cheap wavetable"],
  5: ["Commit-evolved sprites", "Game juice on a budget", "Jump frame count", "Zoo persistence"],
  6: ["Archiving what I love", "Is it done?", "Launch-eve nerves", "Starting vs finishing"],
  7: ["Borrow checker tree", "Learning torch", "Note-taking overkill?", "Reading foreign code"],
};
// each cluster leans toward some projects (pj) and a mood band
const CLUSTER_PJ = { 0: [0, 6], 1: [1, 4], 2: [2, 5], 3: [3, 6], 4: [4], 5: [7, 1], 6: [0, 1, 2, 3], 7: [3, 5, 4] };

// cluster centroids on a sphere
const centroids = CLUSTERS.map((_, i) => {
  const phi = Math.acos(1 - 2 * (i + 0.5) / CLUSTERS.length);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  return [Math.cos(theta) * Math.sin(phi), Math.sin(theta) * Math.sin(phi), Math.cos(phi)];
});

const thoughts = [];
const perProject = {}; // id -> {count, msgs, months:Set, longest}
const perMonthCount = {};
const perClusterCount = {};
let messages = 0;

const N = 168;
for (let k = 0; k < N; k++) {
  const c = Math.floor(rnd() * CLUSTERS.length);
  const m = MONTHS[Math.floor(rnd() * MONTHS.length)];
  const q = pick(T[c]);
  const t = pick(TITLES[c]) + ".";
  const n = 2 + Math.floor(rnd() * 22);          // messages in the convo
  const uw = 20 + Math.floor(rnd() * 420);       // user words
  const qd = round(rnd(), 2);                     // question density
  const dur = round(rnd() * 0.9, 2);              // duration (normalized)
  // position: cluster centroid + jitter
  const ct = centroids[c];
  const jit = () => (rnd() - 0.5) * 0.5;
  const p = [round(ct[0] * 0.7 + jit(), 3), round(ct[1] * 0.7 + jit(), 3), round(ct[2] * 0.7 + jit(), 3)];
  // ~55% of thoughts link to a project
  let pj = null;
  if (rnd() < 0.55) pj = pick(CLUSTER_PJ[c]);
  const th = { t, m, n, c, p, q, uw, qd, dur };
  if (pj != null) th.pj = pj;
  thoughts.push(th);
  messages += n;
  perMonthCount[m] = (perMonthCount[m] || 0) + 1;
  perClusterCount[c] = (perClusterCount[c] || 0) + 1;
  if (pj != null) {
    const id = PID(pj);
    const e = perProject[id] || (perProject[id] = { count: 0, msgs: 0, months: new Set(), longest: { t, n: 0 } });
    e.count++; e.msgs += n; e.months.add(m);
    if (n > e.longest.n) e.longest = { t, n };
  }
}
thoughts.sort((a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));

// ── content.json ───────────────────────────────────────────────────────────
write("content.json", {
  _readme: "SAMPLE DATA — a fictional maker (Sam Rivers). Replace by running the real pipeline on your own export. projects[]: id,title,category,era,desc,stack,status(live|soon|building|archived),flagship,visibility(reveal|vault).",
  corpusLastMonth: LAST_MONTH,
  categories: CATEGORIES,
  projects: PROJECTS.map(({ first, last, commits, url, ...p }) => p),
});

// ── provenance.json ─────────────────────────────────────────────────────────
const provenance = {};
for (const p of PROJECTS) {
  const e = perProject[p.id];
  const months = e ? [...e.months].sort() : [];
  provenance[p.id] = {
    count: e ? e.count : 0,
    msgs: e ? e.msgs : 0,
    firstMonth: months[0] || p.first,
    lastMonth: months[months.length - 1] || p.last,
  };
}
write("provenance.json", provenance);

// ── evidence.json + git-history.json ────────────────────────────────────────
const evidence = {}, gitHistory = {};
for (const p of PROJECTS) {
  const langs = p.stack.split("/");
  evidence[p.id] = {
    repo: p.id, firstCommit: p.first + "-04", lastCommit: p.last + "-18",
    commits: p.commits, remote: `https://github.com/sam-rivers/${p.id}`,
    langs, urlHints: p.url ? [p.url.replace("https://", "")] : [],
    ...(p.url ? { url: p.url } : {}),
  };
  // a plausible monthly commit series across the project's life
  const a = midx(p.first), b = midx(p.last), span = Math.max(1, b - a);
  const monthly = [];
  let left = p.commits;
  for (let i = 0; i <= span; i++) {
    const mm = `${Math.floor((a + i) / 12)}-${String(((a + i) % 12) + 1).padStart(2, "0")}`;
    const n = i === span ? left : Math.max(1, Math.round((left / (span - i + 1)) * (0.5 + rnd())));
    left = Math.max(0, left - n);
    monthly.push({ k: mm, n });
  }
  gitHistory[p.id] = {
    repo: p.id, firstCommit: p.first + "-04", lastCommit: p.last + "-18",
    commits: p.commits, activeSpanDays: span * 30 + 14,
    dormancyDays: (midx(LAST_MONTH) - b) * 30,
    gaps: { medianDays: round(2 + rnd() * 6, 1), meanDays: round(4 + rnd() * 8, 1), maxDays: round(20 + rnd() * 60, 1) },
    burstiness: round(0.2 + rnd() * 0.6, 3),
    taper: { trailingSlopeLogPerMonth: round(-rnd() * 0.4, 4), decayHalfLifeMonths: round(1 + rnd() * 5, 1), last90dCommits: Math.round(rnd() * 8) },
    monthly,
  };
}
write("evidence.json", evidence);
write("git-history.json", gitHistory);

// ── corpus.json ─────────────────────────────────────────────────────────────
const voice = MONTHS.map((m) => {
  const convos = perMonthCount[m] || 1 + Math.floor(rnd() * 4);
  const words = convos * (120 + Math.floor(rnd() * 260));
  return {
    m, convos, words, avgWordsPerConvo: Math.round(words / convos),
    questionRate: round(0.3 + rnd() * 0.5, 2), koreanShare: 0,
    vocabRichness: round(0.35 + rnd() * 0.4, 2),
    build: round(0.3 + rnd() * 0.6, 2), wonder: round(0.1 + rnd() * 0.5, 2),
  };
});
const SKILLS = [
  ["typescript", 2024], ["python", 2024], ["rust", 2025], ["c++", 2025],
  ["web audio", 2024], ["chrome extensions", 2024], ["fastapi", 2024],
  ["pytorch", 2025], ["svelte", 2025], ["embedded", 2025], ["canvas", 2024], ["ffmpeg", 2024],
];
const skills = SKILLS.map(([tech, y0]) => {
  const byYear = { 2024: 0, 2025: 0 };
  const mentions = 4 + Math.floor(rnd() * 40);
  byYear[y0] = Math.round(mentions * 0.6); byYear[y0 === 2024 ? 2025 : 2024] = mentions - byYear[y0];
  return { tech, mentions, convos: Math.round(mentions * 0.7), first: `${y0}-0${1 + Math.floor(rnd() * 8)}`, last: "2025-1" + Math.floor(rnd() * 2), byYear };
}).sort((a, b) => b.mentions - a.mentions);
const motifs = {
  "shipping": { convos: 22, byYear: { 2024: 12, 2025: 10 } },
  "1% better every day": { convos: 14, byYear: { 2024: 6, 2025: 8 } },
  "tools for thought": { convos: 18, byYear: { 2024: 9, 2025: 9 } },
  "starting vs finishing": { convos: 11, byYear: { 2024: 7, 2025: 4 } },
  "sound as material": { convos: 9, byYear: { 2024: 5, 2025: 4 } },
};
write("corpus.json", { _readme: "SAMPLE — monthly voice metrics, skill lexicon, recurring motifs.", voice, skills, motifs });

// ── thoughts.json ───────────────────────────────────────────────────────────
const clusters = CLUSTERS.map((c, i) => ({ label: c.label, terms: c.terms, count: perClusterCount[i] || 0 }));
const projMeta = PROJECTS.map((p) => {
  const e = perProject[p.id];
  const months = e ? [...e.months].sort() : [];
  return { id: p.id, count: e ? e.count : 0, msgs: e ? e.msgs : 0, firstMonth: months[0] || p.first, lastMonth: months[months.length - 1] || p.last, longest: e ? e.longest : { t: "", n: 0 } };
});
const monthsMeta = MONTHS.map((m) => [m, perMonthCount[m] || 0]).filter(([, n]) => n > 0);
write("thoughts.json", {
  meta: { thoughts: thoughts.length, messages, firstMonth: MONTHS[0], lastMonth: LAST_MONTH, months: monthsMeta, clusters, projects: projMeta, depth: "message-level (sample)" },
  thoughts,
});

// ── mirrors.json ────────────────────────────────────────────────────────────
write("mirrors.json", {
  _readme: "SAMPLE self-perception gauges — invented, illustrative only.",
  disclaimer: "Incomplete by design — a language model's read of one person's chat titles. Not a test, no baseline, no clinical meaning.",
  readBy: "a local model reading sample conversation titles",
  jungian: [
    { key: "openness", label: "openness", value: 0.86, reading: "chases the unfamiliar; starts more than finishes", limit: "novelty can read as restlessness" },
    { key: "conscientiousness", label: "conscientiousness", value: 0.58, reading: "ships real things, but on impulse more than plan", limit: "titles under-count quiet follow-through" },
    { key: "introversion", label: "introversion", value: 0.64, reading: "thinks on the page before speaking to anyone", limit: "a journal skews inward by nature" },
    { key: "intuition", label: "intuition", value: 0.79, reading: "reasons by analogy and feel, then checks", limit: "hard to separate from how they prompt" },
  ],
  darkTriad: [
    { key: "narcissism", label: "self-focus", value: 0.31, reading: "builds for themselves first, others second", limit: "a private log is a self-focused artifact" },
    { key: "machiavellianism", label: "strategy", value: 0.27, reading: "little maneuvering; mostly earnest questions", limit: "strategy rarely shows up in a scratchpad" },
    { key: "psychopathy", label: "detachment", value: 0.12, reading: "warm, worried about being useful", limit: "near the floor of what titles can show" },
  ],
  metaperception: {
    how_she_presents: "a cheerful generalist who ships small delightful tools",
    how_she_suspects_shes_seen: "as scattered — too many half-built things",
    how_the_data_reads_her: "consistent obsessions (tools, sound, shipping) revisited under new names",
    the_gap: "what looks like scatter from outside is one question asked in eight materials",
    tensions: { presents_data: "cheerful surface vs real launch-eve dread", presents_suspects: "confident maker vs fear of being scattered", suspects_data: "feels scattered; the record shows a throughline" },
    limit: "a mirror this small reflects the asker as much as the asked",
  },
  essays: {},
  essaysNote: "Longer self-writing would live here.",
});

// ── becoming.json ───────────────────────────────────────────────────────────
write("becoming.json", {
  _readme: "SAMPLE — 'where I'm going' vs 'where I want to be going'; the gap is the instrument.",
  aspiration: {
    tier: "inferred from sample goal statements",
    statements: [
      { text: "make one small tool a month that a stranger actually uses", source: "sample:2024-06", verbatim: false },
      { text: "learn hardware well enough to build the pocket synth for real", source: "sample:2025-03", verbatim: false },
      { text: "finish the things I start before starting the next", source: "sample:2025-05", verbatim: false },
    ],
    endLabel: "a maker who finishes",
    note: "Every line here is yours to overwrite.",
  },
  projection: {
    endLabel: "where the commits actually point",
    coneNote: "projected from monthly build-share and shipping cadence, widened by measured volatility",
    axesNote: "building ↑ vs wondering ↓, across time →",
    exceptions: ["archived SpriteFarm mid-excitement", "QuietInbox stalled at 80%", "three launches clustered in one month"],
  },
  gap: { label: "the gap", reading: "aims to finish; the record shows starting is the stronger habit", tier: "sample" },
});

// ── creed.json ──────────────────────────────────────────────────────────────
write("creed.json", {
  _readme: "SAMPLE — borrowed wisdom, kept separate from your own thoughts. The centerpiece ships in your own words; attributions stay hedged until verified.",
  centerpiece: { ko: "", en: "Make the thing that only you would make, then make it small enough to finish.", note: "Replace with the line that actually runs your work." },
  motto: "small tools, shipped.",
  quotes: [
    { text: "The best way to predict the future is to invent it.", attribution: "commonly attributed to Alan Kay", drift: true },
    { text: "Real artists ship.", attribution: "commonly attributed to Steve Jobs", drift: false },
    { text: "Make it work, make it right, make it fast.", attribution: "commonly attributed to Kent Beck", drift: true },
    { text: "A little and often fills the purse.", attribution: "proverb", drift: false },
    { text: "The obstacle is the way.", attribution: "after Marcus Aurelius", drift: true },
    { text: "You do not rise to the level of your goals; you fall to the level of your systems.", attribution: "commonly attributed to James Clear", drift: false },
  ],
});

// ── featured.json ───────────────────────────────────────────────────────────
write("featured.json", {
  _readme: "SAMPLE — precomputed navigator answers (question → dashboard spec). Regenerate for your own corpus.",
  featured: [
    { q: "what's live right now", aliases: ["what shipped", "live projects", "what's out", "released", "what can i use"], spec: { filters: { status: "live" }, panels: ["timeline"], camera: "wide", narration: "The tools that made it out the door and are in use." } },
    { q: "what did you abandon", aliases: ["dead projects", "archived", "what died", "graveyard", "quit"], spec: { filters: { status: "archived" }, panels: ["eras"], camera: "wide", narration: "The ones that were shelved — and what they taught." } },
    { q: "show me the games", aliases: ["play", "toys", "fun stuff", "game projects", "playful"], spec: { filters: { category: "games & play" }, panels: ["comparison"], camera: "orbit", narration: "The playful corner: rhythm, sprites, and sound." } },
    { q: "who are you", aliases: ["about", "introduce yourself", "what is this", "tell me about yourself", "sam rivers"], spec: { panels: ["becoming"], camera: "hero", narration: "A generalist maker of small, delightful tools — building in public, one month at a time." } },
    { q: "what are you best at", aliases: ["skills", "strengths", "what can you do", "expertise", "tech"], spec: { panels: ["skills"], camera: "orbit", narration: "The materials returned to most: typescript, sound, and shipping." } },
  ],
});

console.log(`\nsample dataset: ${thoughts.length} thoughts · ${PROJECTS.length} projects · ${MONTHS.length} months → public/sample-data/`);

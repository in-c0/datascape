// The generative canvas' query engine — her ceiling ask: "visualizations
// and UIs that don't exist in the current scene." A viz clause is a small
// declarative program the navigator (or a featured answer) composes:
//
//   { title, form: curve|bars|scatter,
//     source: "voice" | "thoughts",
//     field:  voice → words|questionRate|koreanShare|vocabRichness|build|wonder|bw
//             thoughts → uw|kr|qd|dur|n  (metric avg|sum|count)
//     groupBy: thoughts → month|year|cluster|project,
//     filter: the ordinary spec filters }
//
// executeViz runs it over real data client-side and returns plottable rows;
// everything is whitelisted, so the LLM can compose freely but never escape
// the data it's allowed to read.
import { thoughtMatches } from "./spec.js";
import { store } from "./store.js";

const CORPUS = store.corpus;

const VOICE_FIELDS = new Set(["words", "questionRate", "koreanShare", "vocabRichness", "build", "wonder", "bw", "convos"]);
const THOUGHT_FIELDS = new Set(["uw", "kr", "qd", "dur", "n"]);
const FORMS = new Set(["curve", "bars", "scatter"]);
const GROUPS = new Set(["month", "year", "cluster", "project"]);
const METRICS = new Set(["count", "avg", "sum"]);

export function executeViz(viz, thoughts) {
  if (!viz || typeof viz !== "object") return null;
  const form = FORMS.has(viz.form) ? viz.form : "curve";
  const title = String(viz.title || "untitled instrument").slice(0, 90);

  // voice source: monthly measured series straight from the corpus
  if (viz.source === "voice") {
    const field = VOICE_FIELDS.has(viz.field) ? viz.field : "words";
    const rows = CORPUS.voice
      .filter((v) => v.convos > 0)
      .map((v) => ({
        label: v.m,
        y: field === "bw" ? +(v.build / Math.max(v.wonder, 1e-4)).toFixed(2) : v[field],
      }));
    return { title, form, rows, yLabel: field, xLabel: "month", tier: "measured" };
  }

  // thoughts source: filter → group → aggregate
  if (!thoughts) return null;
  const groupBy = GROUPS.has(viz.groupBy) ? viz.groupBy : "month";
  const metric = METRICS.has(viz.metric) ? viz.metric : "count";
  const field = THOUGHT_FIELDS.has(viz.field) ? viz.field : "uw";
  const filter = viz.filter && typeof viz.filter === "object" ? viz.filter : {};

  const groups = new Map();
  thoughts.thoughts.forEach((t) => {
    if (!thoughtMatches(t, filter)) return;
    let key;
    if (groupBy === "month") key = t.m;
    else if (groupBy === "year") key = t.m.slice(0, 4);
    else if (groupBy === "cluster") key = thoughts.meta.clusters[t.c]?.label || "misc";
    else {
      if (t.pj == null) return;
      key = thoughts.meta.projects[t.pj]?.id || "?";
    }
    const g = groups.get(key) || { sum: 0, n: 0 };
    g.sum += t[field] ?? 0;
    g.n++;
    groups.set(key, g);
  });
  if (!groups.size) return null;

  let rows = [...groups.entries()].map(([label, g]) => ({
    label,
    y: metric === "count" ? g.n : metric === "sum" ? g.sum : +(g.sum / g.n).toFixed(2),
  }));
  rows =
    groupBy === "month" || groupBy === "year"
      ? rows.sort((a, b) => (a.label < b.label ? -1 : 1))
      : rows.sort((a, b) => b.y - a.y).slice(0, 14);

  const yLabel = metric === "count" ? "conversations" : `${metric} ${field}`;
  return { title, form, rows, yLabel, xLabel: groupBy, tier: "measured" };
}

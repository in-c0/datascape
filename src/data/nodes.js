// The thought-matter of ava.kim — one data core (content.json) in, nodes out.
// significance is computed here, from real signals, and the formula is shown
// on the card: live-in-service weighs heaviest, then how many conversations
// fed the project, how long it lived, how fresh it is, plus a manual
// flagship tier that only she assigns.
// visibility: reveal | vault | no — vault by default. the public surface
// (config.surface === "public") shows only projects flipped to reveal.
//
// data comes from the runtime store (fetched from config.dataBase), not a
// baked import — this module is only ever evaluated after loadData() resolves.
import { store } from "../store.js";
import { config } from "../../datascape.config.js";

const CONTENT = store.content;
const PROV = store.prov || {};

export const CATEGORIES = CONTENT.categories;

export const STATUS_GLYPH = { live: "●", soon: "◐", building: "◌", archived: "·" };
const STATUS_PTS = { live: 3.5, soon: 1.2, building: 0.8, archived: 0 };

const monthIdx = (m) => +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1);
const LAST = monthIdx(CONTENT.corpusLastMonth);

function computeSig(p) {
  const prov = PROV[p.id] || {};
  const count = prov.count || 0;
  const span =
    prov.firstMonth && prov.lastMonth
      ? monthIdx(prov.lastMonth) - monthIdx(prov.firstMonth)
      : 0;
  const sinceLast = prov.lastMonth ? LAST - monthIdx(prov.lastMonth) : null;
  const parts = {
    status: STATUS_PTS[p.status] ?? 0,
    chats: +(0.6 * Math.log1p(count)).toFixed(1),
    span: +Math.min(1, span / 18).toFixed(1),
    fresh:
      sinceLast == null
        ? p.era === "2026" ? 0.3 : 0
        : sinceLast <= 2 ? 0.6 : sinceLast <= 8 ? 0.3 : 0,
    flagship: p.flagship ? 1.5 : 0,
  };
  const sig = +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(1);
  return { sig, sigParts: parts, chatCount: count };
}

export const SURFACE = config.surface || "public";

const projects = CONTENT.projects
  .filter((p) => SURFACE !== "public" || p.visibility === "reveal")
  .map((p) => ({ ...p, ...computeSig(p) }));

// thoughts.json indexes projects by their position in the FULL content list;
// on the public surface the visible list is shorter, so remap (or drop) the
// provenance links before anything renders. identity on the observatory.
const VISIBLE_IDX = CONTENT.projects.map((p) =>
  projects.findIndex((v) => v.id === p.id)
);
export function remapThoughts(data) {
  if (!data || SURFACE !== "public") return data;
  for (const t of data.thoughts) {
    if (t.pj == null) continue;
    const v = VISIBLE_IDX[t.pj];
    if (v >= 0) t.pj = v;
    else delete t.pj;
  }
  data.meta.projects = data.meta.projects.filter((_, i) => VISIBLE_IDX[i] >= 0);
  return data;
}

// weight is a continuous 1..3 driven by significance — node size IS the data
const maxSig = Math.max(...projects.map((p) => p.sig), 1.1);
export const NODES = projects.map((p) => ({
  ...p,
  weight: +(1 + 2 * Math.max(0, Math.min(1, (p.sig - 1) / (maxSig - 1)))).toFixed(2),
}));

// human-readable formula line for the card — the formula is part of the UI
export function sigFormula(n) {
  const p = n.sigParts;
  const bits = [`${n.status} ${p.status.toFixed(1)}`];
  if (p.chats) bits.push(`${n.chatCount} chats ${p.chats.toFixed(1)}`);
  if (p.span) bits.push(`span ${p.span.toFixed(1)}`);
  if (p.fresh) bits.push(`fresh ${p.fresh.toFixed(1)}`);
  if (p.flagship) bits.push(`flagship ${p.flagship.toFixed(1)}`);
  return `sig ${n.sig.toFixed(1)} = ${bits.join(" + ")}`;
}

export const TOPOLOGIES = [
  { key: "centralized", label: "centralized", hint: "one core self connected to all other thoughts" },
  { key: "clustered", label: "clustered", hint: "thoughts grouped by domain gravity" },
  { key: "strata", label: "strata", hint: "layered landscape, sedimented by era" },
  { key: "semantic", label: "semantic", hint: "thoughts arranged by what they actually say" },
];

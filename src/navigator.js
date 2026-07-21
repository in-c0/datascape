// The navigator — free text in, dashboard spec out.
// Three tiers, in order, and the public site never pays for a model call:
//   1. featured: precomputed question→spec pairs, shipped static
//   2. grammar: the local word-matcher (command.js, handled by the caller)
//   3. live: an optional endpoint on her own machine; absent = asleep
import { store } from "./store.js";

const FEATURED = store.featured;

const STOP = new Set(
  "the a an and of in to for with is are was were do does did me my her she it this that show tell what how where who whats".split(" ")
);
const tokens = (s) =>
  (s.toLowerCase().match(/[a-z0-9가-힯']+/g) || []).filter((w) => !STOP.has(w));

export function matchFeatured(input) {
  const inToks = new Set(tokens(input));
  if (!inToks.size) return null;
  const flat = input.toLowerCase().replace(/[^a-z0-9가-힯 ]/g, "").trim();
  let best = null;
  for (const f of FEATURED.featured) {
    for (const cand of [f.q, ...(f.aliases || [])]) {
      const candFlat = cand.toLowerCase();
      const cToks = tokens(cand);
      if (!cToks.length) continue;
      // single-word candidates ("about", "korean") only match exactly —
      // substring/overlap matching would hijack any sentence containing them
      if (cToks.length < 2) {
        if (flat === candFlat && (!best || 2 > best.score)) best = { f, score: 2 };
        continue;
      }
      const overlap = cToks.filter((w) => inToks.has(w)).length / cToks.length;
      const score =
        flat === candFlat ? 2 : flat.includes(candFlat) ? 1.5 : overlap >= 0.75 ? overlap : 0;
      if (score && (!best || score > best.score)) best = { f, score };
    }
  }
  return best ? best.f : null;
}

export const FEATURED_QUESTIONS = FEATURED.featured.map((f) => f.q);

// live tier — POST { question } to a navigator running on her machine.
// no endpoint, slow endpoint, or malformed reply all mean "asleep".
const NAV_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_NAVIGATOR_URL) ||
  "http://localhost:8787/navigate";

const SPEC_KEYS = new Set(["panels", "camera", "filters", "narration", "focus", "topology", "listen", "instruments", "viz"]);

export async function askLive(question) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(NAV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== "object") return null;
    const spec = {};
    for (const [k, v] of Object.entries(data.spec || {}))
      if (SPEC_KEYS.has(k)) spec[k] = v; // applySpec validates values
    if (typeof data.answer === "string" && data.answer.trim())
      spec.narration = data.answer.slice(0, 200);
    return Object.keys(spec).length ? { spec } : null;
  } catch {
    return null;
  }
}

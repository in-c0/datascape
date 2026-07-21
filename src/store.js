// The data store — fetched at runtime from config.dataBase, then held in a
// singleton so the rest of the engine stays synchronous.
//
// How the decoupling works: main.jsx calls loadData() and only AFTER it
// resolves does it dynamically import the app. Every module that reads data
// (nodes.js building NODES, the panels, the instruments) is therefore
// evaluated with `store` already populated — no async plumbing anywhere else.
//
// This is what makes the template a template: the code imports nothing from
// ./data, so it carries no one's data. You bring your own by pointing
// config.dataBase at wherever your JSON lives.

export const store = {
  content: null,      // { projects[], categories[], corpusLastMonth }
  prov: null,         // { [projectId]: { count, msgs, firstMonth, lastMonth } }
  corpus: null,       // monthly voice metrics + skill lexicon + motifs
  evidence: null,     // git facts per project
  creed: null,        // centerpiece statement
  mirrors: null,      // self-perception gauges + metaperception
  becoming: null,     // aspiration axes
  featured: null,     // precomputed navigator answers
  gitHistory: null,   // per-commit cadence (optional)
  thoughts: null,     // { meta, thoughts[] } — the big one
};

export function dataUrl(name) {
  const base = store._base || "/sample-data/";
  return base.endsWith("/") ? base + name : base + "/" + name;
}

async function fetchJson(base, name, { optional = false } = {}) {
  const url = base.endsWith("/") ? base + name : base + "/" + name;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      if (optional) return null;
      throw new Error(`${name} → HTTP ${r.status}`);
    }
    return await r.json();
  } catch (e) {
    if (optional) return null;
    throw new Error(`could not load ${name} from ${base} (${e.message})`);
  }
}

// Load every data file in parallel. Core files are required; git-history is
// optional (only present once you've run the git-walker). Throws on a missing
// core file so the boot screen can report exactly what's absent.
export async function loadData(base) {
  store._base = base;
  const [
    content, prov, corpus, evidence, creed,
    mirrors, becoming, featured, gitHistory, thoughts,
  ] = await Promise.all([
    fetchJson(base, "content.json"),
    fetchJson(base, "provenance.json"),
    fetchJson(base, "corpus.json"),
    fetchJson(base, "evidence.json"),
    fetchJson(base, "creed.json"),
    fetchJson(base, "mirrors.json"),
    fetchJson(base, "becoming.json"),
    fetchJson(base, "featured.json"),
    fetchJson(base, "git-history.json", { optional: true }),
    fetchJson(base, "thoughts.json"),
  ]);
  Object.assign(store, {
    content, prov, corpus, evidence, creed,
    mirrors, becoming, featured, gitHistory, thoughts,
  });
  return store;
}

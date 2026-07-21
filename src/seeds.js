// Seed recommender v1 — a heuristic, not a judge. Ranks conversations that
// look like her own deep thinking: long, worded like philosophy, and feeding
// no project. The queue is a proposal; her yes decides what gets planted.
const SEED_WORDS = new Set(
  ("why meaning self life decision mind philosophy human think thinking identity belief consciousness memory time trajectory chaos dream soul future truth value happiness loneliness growth fear love free will genius formula moment understanding wound cling forgiveness").split(" ")
);

export function seedScore(t) {
  const words = (t.t + " " + (t.q || "")).toLowerCase().match(/[a-z']+/g) || [];
  const hits = words.filter((w) => SEED_WORDS.has(w)).length;
  return (
    1.1 * Math.log1p(t.n) +
    1.6 * Math.min(hits, 5) +
    (t.pj == null ? 0.8 : 0) +
    ((t.q?.length || 0) > 90 ? 0.5 : 0)
  );
}

export function seedQueue(thoughts, k = 7) {
  if (!thoughts) return [];
  return thoughts.thoughts
    .map((t, i) => ({ t, i, score: seedScore(t) }))
    .filter(({ t, score }) => t.q && score > 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// The dashboard spec — the spine of the site.
// One declarative object drives everything the visitor sees:
//   { panels: ["timeline", ...], camera: "terrain", filters: {...}, narration: "..." }
// Phase 3 renders specs from HUD buttons; the command bar (P4) and the LLM
// navigator (P5) are just other generators of this same object.

export const CAMERA_PRESETS = {
  overview: { pos: [0, 6, 15.5], target: [0, 0, 0] },
  top: { pos: [0.5, 19, 0.5], target: [0, 0, 0] },
  core: { pos: [0, 1.2, 5.2], target: [0, 0, 0] },
  terrain: { pos: [13.5, 2.2, -5.5], target: [0, -2.5, -6] },
  future: { pos: [10.5, 3.4, 13.5], target: [1, -1.2, 8] },
};

// in-scene instruments a spec can mount (the mirrors' bodies in the world)
export const INSTRUMENTS = ["metaperception", "rarity"];

// era → month window, for filtering the thought-dots by project era
export const ERA_WINDOWS = {
  "2025a": ["2025-01", "2025-06"],
  "2025b": ["2025-07", "2025-12"],
  "2026": ["2026-01", "2026-12"],
};

export function normalizeSpec(raw) {
  const s = raw || {};
  return {
    panels: Array.isArray(s.panels) ? s.panels.slice(0, 4) : [],
    instruments: Array.isArray(s.instruments)
      ? s.instruments.filter((i) => INSTRUMENTS.includes(i))
      : [],
    camera: typeof s.camera === "string" && CAMERA_PRESETS[s.camera] ? s.camera : null,
    filters: {
      era: s.filters?.era ?? null,
      category: s.filters?.category ?? null,
      status: s.filters?.status ?? null,
      korean: s.filters?.korean ?? null,
      month: s.filters?.month ?? null,
    },
    narration: typeof s.narration === "string" ? s.narration.slice(0, 200) : "",
    viz: s.viz && typeof s.viz === "object" ? s.viz : null,
  };
}

export const EMPTY_SPEC = normalizeSpec({});

export const hasFilters = (f) =>
  !!(f && (f.era || f.category || f.status || f.korean || f.month));

// does this project node survive the filter?
export function nodeMatches(node, f) {
  if (!hasFilters(f)) return true;
  if (f.era && node.era !== f.era) return false;
  if (f.category && node.category !== f.category) return false;
  if (f.status && node.status !== f.status) return false;
  if (f.korean || f.month) return false; // thoughts-only lenses: projects recede
  return true;
}

// does this thought-dot survive the filter?
export function thoughtMatches(t, f) {
  if (!hasFilters(f)) return true;
  if (f.korean && !t.k) return false;
  // month accepts a prefix: "2026-03" isolates a month, "2023" a whole year
  if (f.month && !t.m.startsWith(f.month)) return false;
  if (f.era) {
    const w = ERA_WINDOWS[f.era];
    if (!w || t.m < w[0] || t.m > w[1]) return false;
  }
  // category/status are project lenses; dots pass unless era/korean/month cut them
  return true;
}

// Local command grammar — the first spec generator a visitor can drive.
// No model, no network: plain word-matching over the things the spec
// language already knows. The LLM layer (Phase 5) replaces this parser,
// not the plumbing.
import { NODES, TOPOLOGIES } from "./data/nodes.js";
import { CAMERA_PRESETS } from "./spec.js";

const PANEL_ALIASES = {
  timeline: "timeline", time: "timeline",
  eras: "eras",
  provenance: "provenance", roots: "provenance",
  comparison: "comparison", compare: "comparison",
  mirror: "mirror", mirrors: "mirror",
  seeds: "seeds", seed: "seeds",
  creed: "creed", quotes: "creed", wisdom: "creed",
  hub: "hub", desk: "hub",
  becoming: "becoming", future: "becoming", trajectory: "becoming",
  skills: "skills", skill: "skills", stack: "skills",
  voice: "voice", writing: "voice",
  value: "value", worth: "value",
};
const INSTRUMENT_TOKENS = {
  metaperception: "metaperception",
  rarity: "rarity", shore: "rarity", rarest: "rarity",
};
const CATEGORY_TOKENS = {
  voice: "voice & speech", speech: "voice & speech",
  agents: "agents & automation", automation: "agents & automation",
  creative: "creative & play", play: "creative & play",
  infra: "infra & tools", tools: "infra & tools",
  products: "ai products",
};
const STATUSES = ["live", "soon", "building", "archived"];
const ERAS = ["2025a", "2025b", "2026"];

export const COMMAND_HINT =
  "era 2026 · korean · live · timeline · a project name · story · clear";

export function parseCommand(input) {
  const raw = (input || "").trim().toLowerCase();
  if (!raw) return { spec: { narration: "" } };
  const words = raw.split(/\s+/);

  if (["clear", "reset", "all"].includes(raw))
    return {
      spec: { panels: [], filters: {}, narration: "cleared — the whole field returns" },
      focus: null,
    };
  if (raw === "story" || raw === "tour") return { story: true };

  const spec = {};
  const filters = {};
  const panels = [];
  const instruments = [];
  const echo = [];
  let focus;
  let topology;

  // a project name wins whole-input matching first (titles contain spaces)
  const proj =
    NODES.find((n) => n.title.toLowerCase() === raw || n.id === raw) ||
    NODES.find(
      (n) => raw.length >= 3 && (n.title.toLowerCase().includes(raw) || n.id.includes(raw))
    );
  if (proj) {
    focus = proj.id;
    panels.push("provenance");
    echo.push(`focused ${proj.title.toLowerCase()}`);
  }

  for (const w of words) {
    if (ERAS.includes(w)) { filters.era = w; echo.push(`era ${w}`); }
    else if (w === "korean" || w === "hangul" || w === "한국어") { filters.korean = 1; echo.push("korean thoughts"); }
    else if (STATUSES.includes(w) && !proj) { filters.status = w; echo.push(w); }
    else if (CATEGORY_TOKENS[w] && !proj) { filters.category = CATEGORY_TOKENS[w]; echo.push(CATEGORY_TOKENS[w]); }
    else if (PANEL_ALIASES[w] && !proj) {
      panels.push(PANEL_ALIASES[w]);
      echo.push(`${PANEL_ALIASES[w]} panel`);
      if (PANEL_ALIASES[w] === "becoming") { topology = "strata"; spec.camera = "future"; }
    }
    else if (INSTRUMENT_TOKENS[w] && !proj) {
      instruments.push(INSTRUMENT_TOKENS[w]);
      echo.push(`${INSTRUMENT_TOKENS[w]} raised`);
    }
    else if (CAMERA_PRESETS[w]) { spec.camera = w; echo.push(`camera ${w}`); }
    else if (TOPOLOGIES.some((t) => t.key === w)) { topology = w; echo.push(`topology ${w}`); }
  }
  if (raw.includes("ai products")) { filters.category = "ai products"; echo.push("ai products"); }

  if (!echo.length) return { nomatch: true };

  if (Object.keys(filters).length) spec.filters = filters;
  if (panels.length) spec.panels = [...new Set(panels)].slice(0, 3);
  if (instruments.length) spec.instruments = [...new Set(instruments)];
  spec.narration = echo.join(" · ");
  return { spec, focus, topology };
}

// Detect probable person-names and seed .data/private-terms.json — which is
// GITIGNORED: names never enter the repo, the shipped data, or any commit.
// Heuristic: capitalized tokens in titles/openings that aren't tech, common
// english, places, or her products — weighted up when they co-occur with
// relationship/intimacy vocabulary. Over-detects on purpose (Directive 8:
// over-scrub by default; she prunes the list, not the reverse).
//
// Usage: node scripts/detect-private.mjs   (then review .data/private-terms.json)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, ".data", "gpt-export");
const OUT = path.join(ROOT, ".data", "private-terms.json");

// word-boundary regexes — "dating" must never match "updating"
export const SENS_EN = [
  /\bmy ex\b/, /\bex[- ](boyfriend|girlfriend|bf|gf)\b/, /\bboyfriend\b/, /\bgirlfriend\b/,
  /\bbreak(ing)? ?up\b/, /\bbroke up\b/, /\bheartbr(eak|oken)/, /\bcrush on\b/,
  /\bsituationship/, /\bdating\b/, /\bdate night\b/, /\bfirst date\b/,
  /\bkiss(ed|ing)?\b/, /\bmarriage\b/, /\bmarry(ing)?\b/, /\bdivorce/,
  /\bunavailable partner\b/, /\brelationship (advice|problem|issue)/, /\blove letter\b/,
  /\btherap(y|ist)\b/, /\bdiagnosed with\b/, /\bmedication\b/, /\bantidepressant/,
  /\badhd\b/, /\bbipolar\b/, /\bpanic attack/, /\bpcos\b/, /\bperiod pain/,
  /\bscoliosis/, /\bself[- ]harm/, /\bsuicid/, /\bdepress(ion|ed)\b/,
];
export const SENS_KO = [
  "남자친구", "여자친구", "남친", "여친", "전남친", "전여친", "연애", "이별",
  "헤어지", "사랑해", "짝사랑", "결혼", "데이트", "고백", "우울증", "정신과", "공황장애",
];
export const isSensitiveText = (lower) =>
  SENS_EN.some((re) => re.test(lower)) || SENS_KO.some((k) => lower.includes(k));

const WHITELIST = new Set(
  ("January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday Sydney Korea Korean Australia Australian English Japan Japanese China Chinese America American Seoul Busan Melbourne Brisbane UNSW USyd Amazon Google Microsoft Apple Meta OpenAI Anthropic ChatGPT Claude GPT Python React Unity Docker GitHub YouTube Chrome Firebase Supabase Flask Django Node Rust Flutter Blender Godot Whisper Kickstarter Notion Figma Discord Slack Reddit Twitter Instagram TikTok LinkedIn Etsy Amazon Overwolf Audacity Vulkan KeepR GitSum ELYATT UpdAPI Consilium Steward Twinscript Huntboard Analyser SSMT Blake Wilcox Bezos Hoffman Cruyff Hebb Shatz Exupery Ava Kim The This That What When Where How Why And But For Not With From Into Over Under About After Before Between Their There Then Than They Them" )
    .split(/\s+/)
);

const nameHits = new Map(); // name -> { count, sensitiveCo }

for (const f of fs.readdirSync(SRC).sort()) {
  if (!/^conversations-\d+\.json$/.test(f)) continue;
  for (const c of JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8"))) {
    const title = (c.title || "").trim();
    if (!title) continue;
    let opening = "";
    for (const k in c.mapping || {}) {
      const m = c.mapping[k]?.message;
      if (!m || m.author?.role !== "user") continue;
      const txt = (m.content?.parts || []).filter((p) => typeof p === "string").join(" ");
      opening += " " + txt;
      if (opening.length > 3000) break;
    }
    const hay = (title + " " + opening.slice(0, 3000)).toLowerCase();
    const sensitive = isSensitiveText(hay);
    // titles are Title-Cased (every word capitalized — useless as a name
    // signal). only MID-SENTENCE capitals in her sentence-cased message text
    // look like names: preceded by a lowercase word, not sentence-initial.
    const body = opening.slice(0, 2500);
    const seen = new Set();
    for (const m of body.matchAll(/([a-z,;:'"()] )([A-Z][a-z]{2,10})\b/g)) {
      const name = m[2];
      if (WHITELIST.has(name) || seen.has(name)) continue;
      seen.add(name);
      const e = nameHits.get(name) || { count: 0, sensitiveCo: 0 };
      e.count++; // once per conversation
      if (sensitive) e.sensitiveCo++;
      nameHits.set(name, e);
    }
  }
}

// candidates: the discriminating signal for a PERSON (vs a library or
// product) is that the name lives mostly in personal contexts — a high
// sensitive-association ratio, not mere co-occurrence
const candidates = [...nameHits.entries()]
  .filter(([, e]) => e.sensitiveCo >= 3 && e.sensitiveCo / e.count >= 0.5 && e.count <= 40)
  .sort((a, b) => b[1].sensitiveCo / b[1].count - a[1].sensitiveCo / a[1].count)
  .slice(0, 40)
  .map(([name, e]) => ({ name, count: e.count, sensitiveCo: e.sensitiveCo }));

const existing = fs.existsSync(OUT)
  ? JSON.parse(fs.readFileSync(OUT, "utf8"))
  : { _readme: "", terms: [], keep: [] };

// her verdict on auto-detection: garbage ("not a name I recognize").
// candidates are REPORT-ONLY — nothing is scrubbed unless she puts it in
// manualTerms herself. the conservative layer is the deep read's per-
// conversation `personal` score, not keyword guessing.
const merged = {
  _readme:
    "GITIGNORED — never committed. manualTerms: names/keywords YOU add by hand — every occurrence in shipped titles/quotes becomes ◌ after rerunning build-corpus.mjs. candidates: auto-detected suggestions, REPORT-ONLY, never applied.",
  terms: [...new Set(existing.manualTerms || [])],
  manualTerms: existing.manualTerms || [],
  candidates,
};
fs.writeFileSync(OUT, JSON.stringify(merged, null, 1));
console.log(`private terms: ${merged.terms.length} scrubbed, ${candidates.length} candidates detected (top co-sensitive: ${candidates.slice(0, 5).map((c) => "•".repeat(String(c.name).length > 0 ? 1 : 0)).join(" ")})`);
console.log(`review ${OUT}`);

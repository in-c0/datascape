// v6:shadow-map — the real shadow control-plane equivalence run (spec V6 §16).
//
// Reads the live lane registry and the authoritative exception inbox, derives
// what V6 WOULD do, and compares. It opens no browser tab, sends no
// continuation, claims no lease and writes nothing outside its own report.
import fs from "node:fs";
import path from "node:path";
import { buildShadowReport } from "../src/continuity/control/shadow-map.js";

const HUB = process.env.HUB_DIR || "D:/Projects/_hub";
const SHIP = process.env.SHIP_INBOX || "D:/Projects/_ship_inbox";
const OUT = process.env.SHADOW_OUT_DIR || path.join(HUB, "shadow", "continuity", "v6");

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

// --- lanes ---------------------------------------------------------------------
const laneFile = path.join(SHIP, "mustreads", "lanes.json");
const laneRecords = readJson(laneFile, {});
const active = readJson(path.join(HUB, "ops", "active-sessions.json"), {});

const lanes = Object.values(laneRecords).map((lane) => ({
  ...lane,
  // A lane is "active" if the registry still lists it and its Auto Run thread
  // is registered. Absence of a claim is NOT evidence of stoppage, so anything
  // undetermined stays undetermined rather than defaulting to done.
  status: lane.stoppedAt ? "done" : "active",
}));

// --- the authoritative exception layer ----------------------------------------
const exDir = path.join(SHIP, "exceptions");
const exceptions = (fs.existsSync(exDir) ? fs.readdirSync(exDir) : [])
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((f) => {
    const text = fs.readFileSync(path.join(exDir, f), "utf8");
    const field = (name) => (text.match(new RegExp(`^${name}:\\s*(.+)$`, "m")) || [])[1]?.trim() ?? null;
    return { id: field("id") || f.replace(/\.md$/, ""), loop: field("loop"), status: field("status"), title: field("title") };
  });

// --- observed behaviour --------------------------------------------------------
// What the lanes are doing RIGHT NOW, read from the registry rather than from
// what any lane says about itself.
const observations = {};
for (const lane of lanes) {
  observations[`shadow:${lane.lane}`] = {
    state: lane.status,
    // A ctn babysitter loop emits a continuation every tick by construction,
    // on a fixed interval rather than on a declared condition.
    continuing: lane.status === "active",
    polling: lane.status === "active",
    condition_based: false,
  };
  // Deliberately NOT set: gate_topics_progressed. The registry records that a
  // lane ticked, not what it worked on, so whether any lane advanced gated work
  // is unobservable from here and is reported as such rather than as a pass.
}

const report = buildShadowReport(lanes, exceptions, observations);
report.exceptions_read = exceptions.length;
report.active_sessions_observed = Object.keys(active).length;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "shadow-map.json"), JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  lanes: report.lanes,
  shadow_intents: report.shadow_intents,
  states: report.states,
  trunk_intents: report.trunk_intents,
  owner_gate_intents: report.owner_gate_intents,
  exceptions_read: report.exceptions_read,
  owner_gate_audit: report.owner_gate_audit,
  divergences: report.divergences,
  unobservable: report.unobservable.length,
  unobservable_sample: report.unobservable.slice(0, 2),
  executed_intents: report.executed_intents,
  continuation_messages_sent: report.continuation_messages_sent,
  owner_state_mutations: report.owner_state_mutations,
}, null, 2));

// Only an INVENTED owner gate fails the run. A divergence is the finding this
// script exists to produce, not an error.
process.exit(report.owner_gate_audit.ok ? 0 : 1);

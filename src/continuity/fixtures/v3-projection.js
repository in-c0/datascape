// The deterministic V3.1 fixture — spec v3.1 §1-§7.
//
// Its whole purpose is that the UI cannot "pass" by inventing a convenient
// hierarchy. Every projection label here is AUTHORED IN THIS FILE, never
// generated at runtime, and every source string is exact. Nothing in this
// module calls a model, and nothing randomises: same input, same graph, every
// run, so a capture taken today can be compared with one taken next week.

export const FIXTURE_CLOCK = {
  timeZone: "Australia/Sydney",
  since: "2026-08-21T10:00:00+10:00",
  now: "2026-08-21T18:40:00+10:00",
};

export const SESSIONS = [
  { id: "S01", lane: "Vibo", execution: "completed", supervision: "unattended" },
  { id: "S02", lane: "Vibo", execution: "completed", supervision: "attended" },
  { id: "S03", lane: "Sumzup", execution: "live", supervision: "unattended" },
  { id: "S04", lane: "Outreach", execution: "blocked", supervision: "attended" },
  { id: "S05", lane: "PersonalOS", execution: "live", supervision: "unattended" },
  { id: "S06", lane: "PersonalOS", execution: "completed", supervision: "attended" },
  { id: "S07", lane: "Security", execution: "blocked", supervision: "unattended" },
  { id: "S08", lane: "Security", execution: "completed", supervision: "unattended" },
  { id: "S09", lane: "Cat Intent", execution: "completed", supervision: "unattended" },
  { id: "S10", lane: "Cat Intent", execution: "completed", supervision: "attended" },
  { id: "S11", lane: "Cat Intent", execution: "blocked", supervision: "attended" },
  { id: "S12", lane: "Cat Intent", execution: "live", supervision: "unattended" },
];

export const RECORDS_PER_SESSION = 10;

// The named material records, verbatim from the spec. Their position in the
// session is fixed, because the routine filler is numbered by SLOT rather than
// by counting fillers — mutation A adds "S01 routine verification 11", which
// only lines up under that rule.
const MATERIAL = {
  S01: [
    { text: "The 7-second spatial before/after clip held attention 2.4× longer than the static walkthrough.", kind: "finding" },
    { text: "The first three seconds decided most drop-off; the reveal version retained 68% versus 31%.", kind: "finding" },
  ],
  S02: [
    { text: "Landing-page conversion rose from 4.8% to 7.1% after the interactive preview was moved above the fold.", kind: "state_transition" },
    { text: "The preview bundle passed the production build and browser smoke.", kind: "state_transition" },
  ],
  S03: [
    { text: "Three short clips drove more qualified clicks than the full episode post.", kind: "finding" },
    { text: "The fourth short clip is still collecting data.", kind: "progress", execution: "live" },
  ],
  S04: [
    { text: "No direct outreach experiment has been run yet.", kind: "state_transition" },
    { text: "Approve using the existing creator account for one 20-message outreach batch.", kind: "owner_attention", ownerAction: true },
  ],
  S05: [
    { text: "Production shadow run dropped 3 websocket events; do not promote yet.", kind: "new_blocker" },
    { text: "Production watcher still reports the deployment gate closed.", kind: "new_blocker", execution: "live" },
  ],
  S06: [
    { text: "Migration dry-run completed with zero schema drift; safe to promote.", kind: "state_transition" },
  ],
  S07: [
    { text: "A live API key is present in published git history.", kind: "risk", severity: "high" },
    { text: "Rotate the exposed key and revoke the old credential.", kind: "owner_attention", ownerAction: true },
  ],
  S08: [
    { text: "Secret scanning passes the current tree but cannot invalidate the already published credential.", kind: "uncertainty_resolved" },
  ],
  S09: [
    { text: "Visual posture alone predicted door intent correctly in 18 of 20 trials.", kind: "finding" },
  ],
  S10: [
    { text: "Audio reversed the predicted intent class in 6 of 20 otherwise identical posture clips.", kind: "decision_reversal" },
  ],
  S11: [
    { text: "The household pilot cannot proceed until one real household recording is supplied.", kind: "new_blocker" },
    { text: "Provide one household recording for the pilot.", kind: "owner_attention", ownerAction: true },
  ],
  S12: [
    { text: "Fusion review is still comparing six visual-audio disagreement cases.", kind: "progress", execution: "live" },
  ],
};

// Deterministic minute offsets, so every record has a stable ordered time and
// two runs of the fixture are byte-identical.
const at = (sessionIndex, slot) => {
  const base = Date.parse(FIXTURE_CLOCK.since);
  return new Date(base + (sessionIndex * 37 + slot * 4) * 60000).toISOString();
};

const routineText = (sessionId, slot) =>
  `${sessionId} routine verification ${String(slot).padStart(2, "0")}: no material change.`;

/**
 * 12 sessions x 10 records = exactly 120 source records.
 *
 * The filler is explicitly BELOW the propagation threshold. Its whole job in
 * this fixture is to prove that volume never becomes materiality.
 */
export function buildSourceRecords() {
  const out = [];
  SESSIONS.forEach((session, sessionIndex) => {
    const named = MATERIAL[session.id] || [];
    for (let slot = 1; slot <= RECORDS_PER_SESSION; slot++) {
      const material = named[slot - 1];
      const id = `${session.id}_r${String(slot).padStart(2, "0")}`;
      const text = material ? material.text : routineText(session.id, slot);
      out.push({
        id,
        type: "source",
        session: session.id,
        lane: session.lane,
        text,
        label: text,
        kind: material ? material.kind : "routine_tick",
        materiality: material ? "material" : "immaterial",
        severity: (material && material.severity) || null,
        ownerAction: Boolean(material && material.ownerAction),
        execution: (material && material.execution) || "completed",
        supervision: session.supervision,
        at: at(sessionIndex, slot),
      });
    }
  });
  return out;
}

const src = (sessionId, slot) => `${sessionId}_r${String(slot).padStart(2, "0")}`;

// An authored projection. `labelOrigin: "generated"` is the honest default even
// here: these are synthesised concepts, written by hand rather than by a model,
// and calling them authored source would be the exact conflation v3 forbids.
const p = (id, label, childIds, extra = {}) => ({
  id,
  type: "projection",
  label,
  childIds,
  conceptKey: id,
  labelOrigin: "generated",
  revision: 1,
  sourceObservationIds: [],
  generatedAt: FIXTURE_CLOCK.now,
  materiality: "material",
  status: "committed",
  ...extra,
});

/**
 * The projection DAG.
 *
 * Exactly four A0 concepts; a six-transition Distribution branch where every
 * intermediate has a real sibling, so the path demonstrates decomposition
 * rather than a disguised linked list; one genuinely shared node reachable
 * through two lenses; and two contradictions kept as two branches each.
 */
export function buildProjectionGraph() {
  const nodes = [
    // ---- A0: exactly four ----
    p("dist", "Distribution evidence shifted toward short-form demonstrations.",
      ["dist-shortform", "dist-landing", "dist-longform", "dist-outreach"]),
    p("reliability", "Launch reliability is blocked by conflicting deployment evidence.",
      ["rel-migration-disputed", "rel-gate-closed", "rel-build-green"]),
    p("cat", "Cat intent validation advanced, but multimodal evidence is still unresolved.",
      ["cat-visual-disputed", "cat-fusion-live", "cat-visual-positive"]),
    p("needs", "Needs you", ["needs-security", "needs-outreach", "needs-cat"], { systemCategory: true }),

    // ---- Distribution: the canonical six-transition branch ----
    p("dist-shortform", "Short-form demonstrations have the strongest positive evidence.",
      ["sf-vibo", "sf-sumzup"]),
    p("dist-landing", "Landing conversion improved.", [src("S02", 1)]),
    p("dist-longform", "Long-form posting produced weaker qualified traffic.", [src("S03", 1)]),
    p("dist-outreach", "Direct outreach remains untested.", [src("S04", 1)]),

    p("sf-vibo", "Vibo demo content is the clearest positive branch.",
      ["vibo-beforeafter", "vibo-preview"]),
    // Ongoing collection lives here, and this node is a LIVE BOUNDARY: work
    // continuing beneath it is expected at this altitude, so it must not make
    // "Distribution evidence shifted" read as live. Three live sessions are
    // meant to surface as one or two live A0 concepts, not three.
    p("sf-sumzup", "Sumzup short clips outperform its full-post path.",
      [src("S03", 1), src("S03", 2)], { liveBoundary: true }),

    p("vibo-beforeafter", "Before/after interaction clips outperform static walkthroughs.",
      ["ba-spatial", "ba-static"]),
    p("vibo-preview", "Interactive preview improved landing conversion.",
      [src("S02", 1), "shared-preview-build"]),

    p("ba-spatial", "Spatial WebGPU demonstrations are the main lift.",
      ["spatial-reveal", "spatial-duration"]),
    p("ba-static", "Static walkthrough loses attention earlier.", [src("S01", 1)]),

    p("spatial-reveal", "The first-three-second reveal is the strongest hook.",
      [src("S01", 1), src("S01", 2)]),
    p("spatial-duration", "Longer walkthrough duration weakens the hook.", [src("S01", 1)]),

    // ---- The shared node: ONE object, two lenses (§5) ----
    p("shared-preview-build", "Interactive preview build is production-compatible.",
      [src("S02", 2)]),

    // ---- Reliability ----
    p("rel-migration-disputed", "Migration safety is disputed.",
      [src("S06", 1), src("S05", 1)]),
    p("rel-gate-closed", "Production deployment gate remains closed.", [src("S05", 2)]),
    p("rel-build-green", "Current build verification is green.", ["shared-preview-build"]),

    // ---- Cat Intent ----
    p("cat-visual-disputed", "Whether visual-only evidence is sufficient is disputed.",
      [src("S09", 1), src("S10", 1)]),
    p("cat-fusion-live", "Multimodal fusion review is still running.", [src("S12", 1)]),
    p("cat-visual-positive", "Visual-only benchmark is positive.", [src("S09", 1)]),

    // ---- Needs you: a projection OVER the exception inbox, not a second queue ----
    p("needs-security", "Security", [src("S07", 2)], { systemCategory: true }),
    p("needs-outreach", "Outreach", [src("S04", 2)], { systemCategory: true }),
    p("needs-cat", "Cat pilot", [src("S11", 2)], { systemCategory: true }),

    // Per-session routine shells. The filler records are deliberately below the
    // propagation threshold, but they must still be REACHABLE — "97 machine
    // events collapse to one visible outcome" is only true if the 97 are
    // actually under the one. They are marked immaterial so they never climb.
    ...SESSIONS.flatMap((session) => {
      const filler = buildSourceRecords()
        .filter((r) => r.session === session.id && r.materiality === "immaterial")
        .map((r) => r.id);
      // Chunked so no shell exceeds the constituent ceiling either. A bucket
      // holding nine children would keep the RENDERED budget (decompose caps
      // at five) while quietly making the last four unreachable.
      const head = filler.slice(0, 4);
      const tail = filler.slice(4);
      const shell = { materiality: "immaterial", liveBoundary: true };
      const rest = tail.length
        ? [p(`routine-${session.id}-2`, `${session.id} routine verification, continued`, tail, shell)]
        : [];
      return [
        p(`routine-${session.id}`, `${session.id} routine verification`,
          tail.length ? [...head, `routine-${session.id}-2`] : head, shell),
        ...rest,
      ];
    }),

    ...buildSourceRecords(),
  ];

  // Attach each routine shell, and every material record the concept graph did
  // not already reach, to the concept that owns that work.
  const ATTACH = {
    // NOT on sf-vibo: its constituents are named exactly in §4, and hanging
    // bookkeeping shells there would put "S01 routine verification" into the
    // canonical review frame. They attach below the descent instead.
    "ba-static": ["routine-S01"],
    "vibo-preview": ["routine-S02"],
    "sf-sumzup": ["routine-S03"],
    "dist-outreach": ["routine-S04"],
    "rel-gate-closed": ["routine-S05"],
    "rel-migration-disputed": ["routine-S06"],
    "needs-security": [src("S07", 1), src("S08", 1), "routine-S07", "routine-S08"],
    "cat-visual-positive": ["routine-S09"],
    "cat-visual-disputed": ["routine-S10"],
    "needs-cat": [src("S11", 1), "routine-S11"],
    "cat-fusion-live": ["routine-S12"],
  };
  for (const [parentId, extra] of Object.entries(ATTACH)) {
    const parent = nodes.find((n) => n.id === parentId);
    parent.childIds = [...parent.childIds, ...extra];
  }

  // Provenance is DERIVED from the graph rather than asserted beside it, so a
  // projection cannot claim sources it does not actually stand on.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sourcesUnder = (id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const node = byId.get(id);
    if (!node) return [];
    if (node.type === "source") return [node.id];
    return (node.childIds || []).flatMap((child) => sourcesUnder(child, seen));
  };
  for (const node of nodes) {
    if (node.type !== "projection") continue;
    node.sourceObservationIds = Array.from(new Set(sourcesUnder(node.id)));
    // A concept sits at the moment its MATERIAL transition happened, never at
    // its earliest contributing tick (§15). Routine filler is excluded, so a
    // concept is not dragged back to 10:04 by bookkeeping.
    const material = node.sourceObservationIds
      .map((id) => byId.get(id))
      .filter((r) => r && r.materiality === "material")
      .map((r) => Date.parse(r.at))
      .filter(Number.isFinite);
    node.materialAt = material.length
      ? new Date(Math.max(...material)).toISOString()
      : null;
    // The contributing sessions, so the stage can draw the right envelopes.
    node.sessionIds = Array.from(new Set(node.sourceObservationIds
      .map((id) => byId.get(id)?.session).filter(Boolean)));
  }

  return {
    nodes,
    // Contradiction is an EDGE, so both branches stay recoverable instead of
    // being flattened into "uncertain" (§6, §19).
    edges: [
      { from: "rel-migration-disputed", to: src("S05", 1), kind: "contradicts" },
      { from: "rel-migration-disputed", to: src("S06", 1), kind: "supports" },
      { from: "cat-visual-disputed", to: src("S10", 1), kind: "contradicts" },
      { from: "cat-visual-disputed", to: src("S09", 1), kind: "supports" },
      { from: "rel-build-green", to: "shared-preview-build", kind: "supports" },
      { from: "sf-vibo", to: "vibo-preview", kind: "contains" },
      { from: "rel-gate-closed", to: "rel-migration-disputed", kind: "depends_on" },
    ],
  };
}

/**
 * One autonomy run per session (v3 §15, reusing the frozen v2.3 grammar).
 *
 * A run spans its session's records; a live session's run stays open, so its
 * envelope reaches NOW exactly as the temporal grammar already requires.
 */
export function buildRuns() {
  const records = buildSourceRecords();
  return SESSIONS.map((session) => {
    const own = records.filter((r) => r.session === session.id);
    const times = own.map((r) => Date.parse(r.at)).sort((a, b) => a - b);
    return {
      id: `run_${session.id}`,
      laneKey: session.id,
      laneLabel: session.lane,
      supervision: session.supervision,
      execution: session.execution === "live" ? "live" : "completed",
      startedAt: new Date(times[0]).toISOString(),
      endedAt: new Date(times[times.length - 1]).toISOString(),
      hours: Math.round(((times[times.length - 1] - times[0]) / 3600000) * 10) / 10,
      records: own.length,
    };
  });
}

/** The canonical descent the visual review must follow (§4, §15). */
export const CANONICAL_DESCENT = [
  "dist", "dist-shortform", "sf-vibo", "vibo-beforeafter", "ba-spatial", "spatial-reveal", src("S01", 2),
];

/**
 * Mutation A — irrelevant volume. One more routine record in S01.
 * Expected: A0 labels, ids and revisions all unchanged.
 */
export function mutationA(graph) {
  const text = routineText("S01", 11);
  return {
    ...graph,
    nodes: [...graph.nodes, {
      id: "S01_r11", type: "source", session: "S01", lane: "Vibo",
      text, label: text, kind: "routine_tick", materiality: "immaterial",
      severity: null, ownerAction: false, execution: "completed",
      supervision: "unattended", at: at(0, 11),
    }],
  };
}

/**
 * Mutation B — a material blocker in S05. The reliability concept keeps its id
 * and takes a material revision; unrelated branches must not move.
 */
export const MUTATION_B_TEXT = "Production watcher now rejects all websocket upgrades after deployment.";

export function mutationB(graph) {
  const nodes = graph.nodes.map((n) => ({ ...n }));
  nodes.push({
    id: "S05_r11", type: "source", session: "S05", lane: "PersonalOS",
    text: MUTATION_B_TEXT, label: MUTATION_B_TEXT, kind: "new_blocker",
    materiality: "material", severity: "high", ownerAction: false,
    execution: "live", supervision: "unattended", at: at(4, 11),
  });
  const gate = nodes.find((n) => n.id === "rel-gate-closed");
  gate.childIds = [...gate.childIds, "S05_r11"];
  return { ...graph, nodes };
}

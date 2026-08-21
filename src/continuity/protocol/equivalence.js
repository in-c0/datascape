// Real shadow equivalence — spec V5.1.
//
// The adapters exist; the question now is whether, applied to the ACTUAL feeds,
// the protocol preserves everything Continuity already knows. Both paths run in
// parallel and nothing switches over until the structural gate passes.
//
// The central design decision is that a difference is not automatically a
// failure. If the old path asserted provenance it had no evidence for and the
// protocol refuses to guess, that is a correction, not drift. So every mismatch
// is CLASSIFIED rather than counted, and the comparator is explicitly forbidden
// from declaring the new path correct merely because it is newer.

export const CLASSIFICATIONS = [
  "exact_match",
  "representation_only",
  "truthfulness_improvement",
  "protocol_loss",
  "adapter_error",
  "legacy_error",
  "ambiguous",
];

/** Only these block cutover automatically; `ambiguous` blocks until ruled on. */
export const BLOCKING = ["protocol_loss", "adapter_error", "ambiguous"];

const DIMENSIONS = [
  "native_identity", "text", "occurred_at", "observed_at", "kind",
  "trigger", "supervision", "owner_action_ref", "relations", "execution",
];

/** Provenance the old path could assert without evidence. */
const INFERRED_SUPERVISION = new Set(["unattended", "attended"]);

/**
 * Classify one field mismatch.
 *
 * The rules encode which direction of disagreement is defensible. Old asserting
 * a provenance value where the protocol says `unknown` is a truthfulness
 * improvement ONLY when the old value could not have been evidenced; the
 * reverse — protocol claiming more than the source supports — is an adapter
 * error, never a "better guess".
 */
export function classifyDifference({ dimension, oldValue, next, evidenced = false }) {
  if (JSON.stringify(oldValue ?? null) === JSON.stringify(next ?? null)) return "exact_match";

  // Authored text must be byte-identical. Any difference at all is a defect,
  // and which side is wrong is not something a comparator may assume.
  if (dimension === "text") return "adapter_error";

  if (dimension === "native_identity" || dimension === "owner_action_ref") {
    return next == null ? "protocol_loss" : "adapter_error";
  }

  if (dimension === "trigger" || dimension === "supervision") {
    const oldAsserted = dimension === "supervision"
      ? INFERRED_SUPERVISION.has(oldValue)
      : oldValue && oldValue !== "unknown";
    const nextUnknown = next === "unknown";
    if (oldAsserted && nextUnknown) {
      // The protocol declined to guess. That is an improvement unless the old
      // value was genuinely evidenced, in which case the adapter dropped it.
      return evidenced ? "adapter_error" : "truthfulness_improvement";
    }
    if (!oldAsserted && next && next !== "unknown") {
      // The protocol claims MORE than the old path did. Only defensible when
      // the source actually carries it.
      return evidenced ? "legacy_error" : "adapter_error";
    }
    return "ambiguous";
  }

  if (dimension === "observed_at") {
    // The old store frequently had no separate observation time at all.
    return oldValue == null ? "representation_only" : "ambiguous";
  }

  if (dimension === "relations") {
    const oldCount = (oldValue || []).length;
    const nextCount = (next || []).length;
    if (nextCount < oldCount) return "protocol_loss";
    if (nextCount > oldCount) return "ambiguous";
    return "representation_only";
  }

  if (next == null) return "protocol_loss";
  return "ambiguous";
}

/**
 * Byte-exact round trip.
 *
 * Deliberately checks length, a content hash and codepoints rather than `===`
 * alone, so a report can say HOW text differs when it does. Nothing is
 * normalised for convenience: not curly quotes, not Markdown, not whitespace,
 * not Unicode form, not line endings.
 */
export function auditText(source, recovered) {
  const exact = source === recovered;
  return {
    exact,
    source_length: source.length,
    recovered_length: recovered?.length ?? 0,
    source_hash: hash(source),
    recovered_hash: hash(recovered ?? ""),
    codepoints_equal: [...String(source)].length === [...String(recovered ?? "")].length,
    line_endings_preserved: countCRLF(source) === countCRLF(recovered ?? ""),
  };
}

const countCRLF = (s) => (String(s).match(/\r\n/g) || []).length;

function hash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Compare one old-path record against its protocol event across every
 * dimension, returning per-dimension classifications.
 */
export function compareEvent(oldRecord, event, { evidenced = {} } = {}) {
  const values = {
    native_identity: [oldRecord.native_id ?? oldRecord.id ?? null, event?.native_id ?? null],
    text: [oldRecord.text ?? null, event?.text ?? null],
    occurred_at: [oldRecord.occurred_at ?? oldRecord.at ?? null, event?.occurred_at ?? null],
    observed_at: [oldRecord.observed_at ?? null, event?.observed_at ?? null],
    kind: [oldRecord.canonical_kind ?? null, event?.kind ?? null],
    trigger: [oldRecord.trigger ?? null, event?.trigger ?? null],
    supervision: [oldRecord.supervision ?? null, event?.supervision ?? null],
    owner_action_ref: [oldRecord.owner_action_ref ?? null, event?.owner_action_ref ?? null],
    relations: [oldRecord.relations ?? [], event?.relations ?? []],
    execution: [oldRecord.execution ?? null, event?.execution ?? null],
  };

  const findings = [];
  for (const dimension of DIMENSIONS) {
    const [oldValue, next] = values[dimension];
    // A dimension the old path never had is not a loss; it is a field the old
    // representation simply did not model.
    if (oldValue == null && dimension === "observed_at" && next != null) {
      findings.push({ dimension, classification: "representation_only", old: null, protocol: next,
        reason: "the old store did not model a separate observation time" });
      continue;
    }
    if (oldValue == null && next == null) continue;
    const classification = classifyDifference({
      dimension, oldValue, next, evidenced: Boolean(evidenced[dimension]),
    });
    if (classification === "exact_match") continue;
    findings.push({
      dimension, classification, old: oldValue, protocol: next,
      reason: REASONS[classification],
    });
  }
  return { native_id: values.native_identity[0], findings };
}

const REASONS = {
  representation_only: "same meaning, different encoding",
  truthfulness_improvement: "the old path asserted provenance without evidence; the protocol refuses to guess",
  protocol_loss: "the old path knew something the protocol dropped",
  adapter_error: "the contract could represent this; the adapter mapped it incorrectly",
  legacy_error: "the comparison indicates the old ingestion was wrong",
  ambiguous: "requires human review",
};

/**
 * The shadow equivalence report.
 *
 * Lists only non-exact cases. A report that dumps hundreds of successful
 * events buries the handful that matter, and the handful that matter are the
 * entire reason for running it.
 */
export function buildEquivalenceReport(sections) {
  const summary = {};
  const details = {};
  let blocking = 0;

  for (const [name, comparisons] of Object.entries(sections)) {
    const counts = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0]));
    const nonExact = [];
    for (const comparison of comparisons) {
      if (!comparison.findings.length) { counts.exact_match += 1; continue; }
      for (const finding of comparison.findings) {
        counts[finding.classification] += 1;
        if (BLOCKING.includes(finding.classification)) blocking += 1;
        nonExact.push({ native_id: comparison.native_id, ...finding });
      }
    }
    summary[name] = { compared: comparisons.length, ...counts };
    details[name] = nonExact;
  }

  return {
    report: "V5.1 REAL EQUIVALENCE",
    summary,
    // Bounded and only what needs a decision.
    non_exact: details,
    // Structural, never a percentage. "99% equivalent" hides which 1%.
    cutover_gate: {
      protocol_loss: total(summary, "protocol_loss"),
      adapter_error: total(summary, "adapter_error"),
      ambiguous: total(summary, "ambiguous"),
      passes: blocking === 0,
      note: "truthfulness_improvement may be nonzero and does not block.",
    },
  };
}

const total = (summary, key) => Object.values(summary).reduce((n, s) => n + (s[key] || 0), 0);

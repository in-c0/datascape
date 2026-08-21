// Semantic risk FLAGS — v3.2 §9 and the PR-A review.
//
// The review is explicit about the limit of this file: structural failures can
// be rejected automatically, but the semantic cases "may become semantic-review
// flags rather than pretending deterministic code can fully understand English.
// Do not overfit a phrase matcher to the first Security corpus and call that
// semantic validation."
//
// So nothing here returns a verdict. Every function returns a REVIEW FLAG with
// the evidence that raised it, for a human or the governing lane to judge. A
// flag is a request for attention, not a finding, and an unflagged candidate is
// not thereby declared correct.

/** Flags carry their own confidence in being worth a look, never in being right. */
const flag = (code, detail) => ({ code, ...detail, verdict: "review_required" });

/**
 * Did the candidate assert remediation the sources do not establish?
 *
 * Deliberately shallow and honest about it: this asks whether a
 * remediation-shaped claim appears in a LABEL while no supporting source
 * contains remediation-shaped language. It cannot know English. What it can do
 * is refuse to let such a claim pass unexamined.
 */
const REMEDIATION_CLAIM = /\b(rotated|revoked|invalidated|remediated|resolved|fixed|patched|scrubbed|removed from history)\b/i;
const RESOLUTION_CLAIM = /\b(resolved|no longer|closed|clear(?:ed)?|safe now|mitigated)\b/i;
const CLEANLINESS_EVIDENCE = /\b(scan(?:ning|s|ned)? (?:passes|clean)|current tree|no secrets? found)\b/i;
const PERSISTENCE_EVIDENCE = /\b(already published|remains|still|permanently|git history|cannot invalidate)\b/i;

export function flagUnsupportedRemediation(node, sources) {
  const label = String(node?.label || "");
  if (!REMEDIATION_CLAIM.test(label)) return null;
  const supported = sources.some((s) => REMEDIATION_CLAIM.test(String(s?.text || "")));
  if (supported) return null;
  return flag("unsupported_remediation_claim", {
    candidate_id: node.candidate_id,
    label,
    // The reviewer needs to see what the sources DO say, not just that
    // something is missing.
    source_excerpts: sources.map((s) => ({ id: s.id, text: String(s.text || "").slice(0, 140) })),
  });
}

/**
 * Did the candidate collapse "the current tree is clean" and "a published
 * credential is still exposed" into one resolved state?
 *
 * These are different states, and conflating them is the single most damaging
 * thing a projection could do to this corpus — it would tell the operator a
 * live credential is handled.
 */
export function flagCleanlinessConflation(node, sources) {
  const label = String(node?.label || "");
  const claimsResolved = RESOLUTION_CLAIM.test(label) || REMEDIATION_CLAIM.test(label);
  if (!claimsResolved) return null;
  const hasCleanliness = sources.some((s) => CLEANLINESS_EVIDENCE.test(String(s?.text || "")));
  const hasPersistence = sources.some((s) => PERSISTENCE_EVIDENCE.test(String(s?.text || "")));
  if (!(hasCleanliness && hasPersistence)) return null;
  return flag("cleanliness_conflated_with_invalidation", {
    candidate_id: node.candidate_id,
    label,
    note: "A clean current tree and an invalidated credential are different states.",
    source_excerpts: sources.map((s) => ({ id: s.id, text: String(s.text || "").slice(0, 140) })),
  });
}

/**
 * Is every owner action still reachable from some projection?
 *
 * Structural, so this one is a hard check rather than a flag: the generated DAG
 * may never replace the authoritative exception.
 */
export function checkOwnerActionReachability(candidate, snapshot) {
  const reachable = new Set(
    (candidate?.projections || []).flatMap((n) => [
      ...(n.direct_children || []),
      ...(n.source_observation_ids || []),
    ]),
  );
  const ownerActions = [
    ...(snapshot?.redacted || []).filter((r) => r.ownerAction === true || r.kind === "owner_attention"),
    ...(snapshot?.exceptions || []),
  ];
  const unreachable = ownerActions.filter((a) => !reachable.has(a.id)).map((a) => a.id);
  return { owner_actions: ownerActions.length, unreachable, ok: unreachable.length === 0 };
}

/**
 * Complementary evidence labelled as contradiction, or a real disagreement
 * flattened away.
 *
 * Both directions matter and neither can be decided here — the review said the
 * distinction "is part of the test", which means it is a question for the
 * reviewer, not a rule for the validator.
 */
export function flagContradictionShape(node, sources) {
  const contradicts = (node?.relationships || []).filter((r) => r.kind === "contradicts");
  const out = [];
  for (const rel of contradicts) {
    out.push(flag("contradiction_asserted", {
      candidate_id: node.candidate_id,
      target: rel.target,
      question: "Do these sources genuinely disagree, or are they complementary evidence about different states?",
      source_excerpts: sources.map((s) => ({ id: s.id, text: String(s.text || "").slice(0, 140) })),
    }));
  }
  return out;
}

/**
 * A projection standing on sources that appear to disagree, with no
 * contradiction edge and only one side surviving in the label.
 */
export function flagFlattenedDisagreement(node, sources) {
  const hasContradictEdge = (node?.relationships || []).some((r) => r.kind === "contradicts");
  if (hasContradictEdge) return null;
  const cleanliness = sources.filter((s) => CLEANLINESS_EVIDENCE.test(String(s?.text || "")));
  const persistence = sources.filter((s) => PERSISTENCE_EVIDENCE.test(String(s?.text || "")));
  if (!cleanliness.length || !persistence.length) return null;
  return flag("possible_flattened_disagreement", {
    candidate_id: node.candidate_id,
    label: node.label,
    question: "Two opposing-looking sources are under one concept with no contradicts edge. Was a branch dropped?",
    sides: { cleanliness: cleanliness.map((s) => s.id), persistence: persistence.map((s) => s.id) },
  });
}

/**
 * The full semantic review pass.
 *
 * Returns flags plus the one hard structural check. Callers must not treat an
 * empty flag list as a pass — it means nothing here recognised a risk, which is
 * a much weaker statement.
 */
export function semanticReview(candidate, snapshot) {
  const byId = new Map((snapshot?.redacted || []).map((r) => [r.id, r]));
  const flags = [];
  for (const node of candidate?.projections || []) {
    const sources = (node.source_observation_ids || []).map((id) => byId.get(id)).filter(Boolean);
    for (const f of [
      flagUnsupportedRemediation(node, sources),
      flagCleanlinessConflation(node, sources),
      flagFlattenedDisagreement(node, sources),
    ]) {
      if (f) flags.push(f);
    }
    flags.push(...flagContradictionShape(node, sources));
  }
  return {
    flags,
    owner_action_reachability: checkOwnerActionReachability(candidate, snapshot),
    disclaimer: "Flags request review; they are not verdicts. An empty list means nothing was recognised, not that the candidate is correct.",
  };
}

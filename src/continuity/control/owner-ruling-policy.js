// Which exception transitions are OWNER RULINGS, and which are ordinary lane
// work (spec V6.1.6-A.2 PR B, "the CLI cannot remain an owner-authentication
// bypass").
//
// The browser route is now verified. A supported CLI that can still run
//
//   exception.mjs set <blocked-on-owner-id> resolved
//
// would preserve the same impersonation route under a different transport — the
// item leaves her queue, and the record reads as though she decided.
//
// The fix is NOT "require Windows Hello for every exception mutation". Agents
// legitimately update ordinary workflow state all day, and a control that
// prompts her for that would be turned off within a week. The line is drawn at
// owner judgement instead:
//
//   a transition that records HER decision        → verified ruling_ref
//   a lane withdrawing its own question           → lane authority, recorded as
//                                                    a withdrawal, never as her
//   anything not involving `blocked-on-owner`     → lane authority
//
// Raw file editing by an arbitrary same-user process is outside this phase's
// threat model. What is inside it is that no SUPPORTED interface produces an
// owner-ruling record without her.

export const OWNER_GATED_STATUS = "blocked-on-owner";

/**
 * Statuses a lane may move a blocked-on-owner item to on its own authority.
 *
 * `investigating` only: the lane is taking its question back, so the item
 * returns to lane ownership and remains open. Closing it outright is a claim
 * that the question was ANSWERED, and only she answers it.
 */
export const LANE_WITHDRAWAL_STATUS = "investigating";

/**
 * Classify a proposed transition.
 *
 * `claims_owner_decision` is an explicit input, never inferred from the note.
 * Recovering intent from prose is the same mistake as classifying her reply by
 * searching it for "done".
 */
export function classifyTransition({ from, to, claims_owner_decision = false }) {
  if (claims_owner_decision) {
    return {
      class: "owner_ruling",
      requires_owner_presence: true,
      reason: "this transition records the owner's decision",
    };
  }
  if (from !== OWNER_GATED_STATUS) {
    return { class: "lane_transition", requires_owner_presence: false, reason: "not an owner-gated item" };
  }
  if (to === LANE_WITHDRAWAL_STATUS) {
    return {
      class: "lane_withdrawal",
      requires_owner_presence: false,
      reason: "the lane is withdrawing its own question, not answering it",
      // Recorded so a reader can tell the two apart in the file itself.
      record_as: "LANE WITHDREW — no owner ruling",
    };
  }
  return {
    class: "owner_ruling",
    requires_owner_presence: true,
    reason: `moving an owner-gated item to ${to} asserts that she decided`,
  };
}

/**
 * The gate itself.
 *
 * A `ruling_ref` is only accepted when this process produced it through
 * verified presence — a ref supplied on the command line is a string, and a
 * string has never been evidence of anything.
 */
export function authorizeTransition({ from, to, claims_owner_decision = false, ruling_ref = null, verifiedRefs = null }) {
  const verdict = classifyTransition({ from, to, claims_owner_decision });
  if (!verdict.requires_owner_presence) return { ok: true, ...verdict };

  if (!ruling_ref) {
    return {
      ok: false, ...verdict,
      failure: "owner_ruling_ref_required",
      remedy: `Rule on it as her: node ops/owner-rule.mjs <id> <approve|reply_done|reply_no|reply_need_context|defer|dismiss>. `
        + `To take the question back instead, set it to ${LANE_WITHDRAWAL_STATUS}.`,
    };
  }
  if (!verifiedRefs || !verifiedRefs.has(ruling_ref)) {
    return {
      ok: false, ...verdict,
      failure: "unverified_ruling_ref",
      remedy: "a ruling ref is only meaningful in the process that produced it through verified owner presence",
    };
  }
  return { ok: true, ...verdict };
}

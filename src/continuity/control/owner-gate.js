// The owner gate on the exception store itself.
//
// Closing the HTTP bypass and adding a safe CLI does not remove the unsafe one.
// The original impersonation route is still supported:
//
//   node _ship_inbox/ops/exception.mjs set <blocked-on-owner-id> resolved
//
// That command moves an item out of her queue and leaves a record that reads
// like she answered. No amount of new interface closes it, because it does not
// go through any new interface.
//
// So the gate lives at the store's own mutation point. It is deliberately
// narrow: agents update ordinary workflow state constantly, and a control that
// prompted for that would be switched off within a week.
//
//   leaving `blocked-on-owner`   -> requires a ruling this process verified
//   everything else              -> lane authority, untouched
//
// Raw file editing by an arbitrary same-user process is outside this phase's
// threat model. What is inside it is that no SUPPORTED interface — HTTP or CLI
// — can produce an owner ruling without her.

export const OWNER_GATED_STATUS = "blocked-on-owner";

/**
 * Rulings this process performed through verified owner presence.
 *
 * Process-local and non-serializable in effect: a ref from another process, or
 * one typed on a command line, is just a string and is not in this set. It is
 * only ever populated by the orchestrator, immediately after a real
 * verification consumed for that exact operation.
 */
const verifiedRulings = new Set();

export function registerVerifiedRuling(rulingRef) {
  if (rulingRef) verifiedRulings.add(rulingRef);
  return rulingRef;
}

/** For assertions only. */
export function verifiedRulingCount() {
  return verifiedRulings.size;
}

export function isOwnerGatedTransition(from, to) {
  return from === OWNER_GATED_STATUS && to !== OWNER_GATED_STATUS;
}

/**
 * May this status transition proceed?
 *
 * Called by the store before it writes. Returns a reason rather than throwing
 * so the caller can decide how loudly to fail; the CLI turns it into a refusal
 * with the supported route named.
 */
export function checkTransition({ from, to, ownerRuling = null }) {
  if (!isOwnerGatedTransition(from, to)) {
    return { ok: true, class: "lane_transition" };
  }
  if (ownerRuling && verifiedRulings.has(ownerRuling)) {
    return { ok: true, class: "owner_ruling" };
  }
  return {
    ok: false,
    class: "owner_ruling",
    failure: ownerRuling ? "unverified_ruling_ref" : "owner_ruling_required",
    reason: `${from} -> ${to} records an owner decision, which needs the owner`,
    remedy: "Rule on it as her from the briefing surface, or run:\n"
      + "  node ops/owner-rule.mjs <exception-id> <approve|reply_done|reply_no|reply_need_context|defer|dismiss>\n"
      + "If the lane no longer needs an answer, say so in a note and leave the item where it is;\n"
      + "withdrawing an owner-gated question is not available from an unauthenticated process.",
  };
}

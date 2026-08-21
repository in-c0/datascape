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
//   leaving `blocked-on-owner`   -> always refused, here
//   everything else              -> lane authority, untouched
//
// WHY THERE IS NO ESCAPE HATCH
//
// The first version let a caller pass a `ruling_ref` that this process had
// registered after a verified ruling. That was the verification-handle bug
// again in a new place: a serializable string, held in a process-local Set,
// never bound to an exception or a transition and never consumed — which is a
// reusable authorization capability for anything running in the host.
//
// It was also unnecessary. The verified orchestrator performs its own atomic
// exception replacement and never calls `setStatus`, so nothing legitimate ever
// needed the override. Removing it costs nothing and deletes a capability.
//
// The division is now absolute:
//
//   legacy store               -> lane workflow only
//   verified owner orchestrator -> owner rulings only
//
// Raw file editing by an arbitrary same-user process is outside this phase's
// threat model. What is inside it is that no SUPPORTED interface produces an
// owner ruling without her.

export const OWNER_GATED_STATUS = "blocked-on-owner";

export function isOwnerGatedTransition(from, to) {
  return from === OWNER_GATED_STATUS && to !== OWNER_GATED_STATUS;
}

/**
 * May this status transition proceed?
 *
 * Called by the store before it writes. Takes no credential of any kind: there
 * is no argument a caller could supply that would turn a refusal into an
 * approval, which is the entire point.
 */
export function checkTransition({ from, to }) {
  if (!isOwnerGatedTransition(from, to)) {
    return { ok: true, class: "lane_transition" };
  }
  return {
    ok: false,
    class: "owner_ruling",
    failure: "owner_ruling_required",
    reason: `${from} -> ${to} records an owner decision, which needs the owner`,
    remedy: "Rule on it as her from the briefing surface, or run:\n"
      + "  node ops/owner-rule.mjs <exception-id> <approve|reply_done|reply_no|reply_need_context|defer|dismiss>\n"
      + "If the lane no longer needs an answer, say so in a note and leave the item where it is;\n"
      + "withdrawing an owner-gated question is not available from an unauthenticated process.",
  };
}

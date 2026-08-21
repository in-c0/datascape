// The owner-presence boundary — spec V6.1.6-A.2.
//
// The discovery finding this answers: the host that serves this UI authenticates
// nobody. It validates loopback and Origin, which is a network-origin boundary,
// and treats every local process identically. Anything on the machine — an
// agent, this session — could act as the owner.
//
// The governing model:
//
//   local process        != owner
//   browser page         != owner
//   valid local Origin   != owner
//   Windows account + FRESH OS user verification
//                        = owner presence for ONE specific privileged action
//
// The last line is the load-bearing one. An ordinary unlocked Windows session
// must never be sufficient to create authority, because an agent driving an
// already-open browser inherits exactly that. Every owner ruling gets a prompt.
//
// Nothing here registers a route, touches authority, or reaches an executor.

export const AVAILABILITY = ["available", "not_configured", "unavailable", "disabled", "error"];
export const VERIFICATION = ["verified", "cancelled", "failed", "unavailable"];

/**
 * Result fields a browser might send that must NEVER be believed.
 *
 * The host asks Windows and observes the answer itself. A verification result
 * that could travel through the browser would just be another transferable
 * credential — which is the thing we are replacing, not reproducing.
 */
export const UNTRUSTED_VERIFICATION_FIELDS = [
  "verified", "owner", "windowsHelloPassed", "verificationResult",
  "verification_token", "windows_verified_token", "presence",
];

/** Operations that require a FRESH verification immediately before mutating. */
export const OWNER_MUTATIONS = [
  "authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority",
  "approve", "reply_done", "reply_no", "reply_need_context", "defer", "dismiss",
];

export function requiresOwnerPresence(operation) {
  return OWNER_MUTATIONS.includes(operation);
}

/**
 * Strip any claimed verification from an inbound payload.
 *
 * Removed rather than rejected, for the same reason identity fields are: a
 * rejected claim still reached the decision, and a stripped one cannot be read
 * by code written later that forgets why the check existed.
 */
export function stripClaimedVerification(payload = {}) {
  const clean = { ...payload };
  const stripped = [];
  for (const field of UNTRUSTED_VERIFICATION_FIELDS) {
    if (clean[field] !== undefined) { delete clean[field]; stripped.push(field); }
  }
  return { request: clean, stripped_verification_fields: stripped };
}

/**
 * The verifier.
 *
 * `broker` performs ONE job: given a host challenge, open the Windows
 * verification UI and return what Windows said. It is spawned by the privileged
 * parent and holds no authority store, no exception store, no listener and no
 * network capability — and the browser never invokes it.
 *
 * The challenge exists because a standalone process invoking the broker for its
 * OWN challenge proves nothing to this host. The result is only meaningful when
 * it echoes a challenge this process generated moments earlier.
 */
export function createOwnerPresenceVerifier({
  broker,
  now,
  randomChallenge,
  cooldownMs = 3000,
  challengeTtlMs = 60000,
}) {
  if (typeof broker?.verify !== "function") throw new Error("an owner-presence broker is required");

  let outstanding = null;
  let cooldownUntil = 0;
  const consumed = new Set();
  /**
   * Handles issued and not yet spent.
   *
   * Membership here IS the authorization. Nothing outside this process can add
   * to it, so a serialized verification object is a name for something that is
   * no longer there.
   */
  const unspent = new Set();

  return {
    availability: () => broker.availability(),

    /**
     * Verify owner presence for ONE described operation.
     *
     * `purpose` is derived host-side from the prepared operation, never from
     * browser prose — the prompt must describe what the host is about to do.
     */
    async verify({ purpose, operationRef }) {
      const at = now();

      // Prompt-bomb protection. Any local process can try to make Windows show
      // a prompt; it cannot produce authority that way, but it can produce
      // dozens of dialogs, which is its own denial of service.
      if (outstanding) {
        return { outcome: "failed", reason: "a verification is already outstanding", collapsed: true };
      }
      if (at < cooldownUntil) {
        return { outcome: "failed", reason: "verification is cooling down after a recent cancellation", cooldown: true };
      }

      // The slot is claimed SYNCHRONOUSLY, before the first await. Claiming it
      // after the availability probe left a window in which two concurrent
      // callers both passed the guard and both opened a dialog — which is the
      // exact prompt-bomb this control exists to prevent.
      const challenge = randomChallenge();
      outstanding = challenge;

      try {
        const availability = await broker.availability();
        if (availability !== "available") {
          // Device absent, not configured, disabled by policy, busy. None of
          // these is a reason to fall back to trusting localhost.
          return { outcome: "unavailable", reason: `owner verification is ${availability}`, availability };
        }
        const result = await broker.verify({ challenge, purpose });

        // The result must echo the challenge THIS process generated, and each
        // challenge may be answered once.
        if (result?.challenge !== challenge) {
          return { outcome: "failed", reason: "the verification result did not echo this host's challenge" };
        }
        if (consumed.has(challenge)) {
          return { outcome: "failed", reason: "this verification was already consumed" };
        }
        if (now() - at > challengeTtlMs) {
          return { outcome: "failed", reason: "the verification took too long to be considered fresh" };
        }

        if (result.outcome !== "verified") {
          // Every non-verified outcome is boring and identical in effect:
          // nothing happens.
          cooldownUntil = now() + cooldownMs;
          return { outcome: result.outcome ?? "failed", reason: result.reason ?? "not verified" };
        }

        consumed.add(challenge);
        // A one-shot HANDLE, not a reusable capability. The verified object
        // itself is inert: `authorizes` looks the handle up in this process and
        // burns it, so a copied or serialized result proves nothing. Previously
        // the same verified object could authorize the same operation
        // repeatedly, which made it exactly the transferable proof this design
        // exists to avoid.
        const handle = randomChallenge();
        unspent.add(handle);
        return {
          outcome: "verified",
          // Bound to the exact operation. A verification for one ruling can
          // never be carried to another.
          operation_ref: operationRef,
          verification_handle: handle,
          verified_at: now(),
        };
      } finally {
        outstanding = null;
      }
    },

    /**
     * Is this verification good for THIS operation, ONCE?
     *
     * Consuming rather than merely checking. A verified result must not be a
     * reusable authorization capability: the shape the spec asks for is
     * prepare → verify → consume exactly once → perform immediately, and a
     * second consumption of the same verification for the same operation has to
     * fail. Cross-operation use remains impossible.
     *
     * A committed operation may still be replayed later from durable mutation
     * state without another prompt. That is replay of a ruling, not reuse of
     * presence, and it happens elsewhere — never through this function.
     */
    authorizes(verification, operationRef) {
      if (verification?.outcome !== "verified") return { ok: false, reason: "no verified owner presence" };
      if (verification.operation_ref !== operationRef) {
        return { ok: false, reason: "this verification was for a different operation" };
      }
      const handle = verification.verification_handle;
      if (!handle || !unspent.has(handle)) {
        // Either already spent, or a copy fabricated outside this process.
        return { ok: false, reason: "this owner verification has already been used or did not originate here" };
      }
      unspent.delete(handle);
      return { ok: true };
    },

    /** For assertions only. */
    unspentCount: () => unspent.size,

    // Structural: this object issues nothing a browser could hold.
    issues_transferable_token: false,
  };
}

/**
 * The prompt text, derived from the prepared operation.
 *
 * Host-side, and never browser prose. It does not reproduce the whole policy —
 * that is already on the reviewed screen — but it must distinguish WHAT CLASS
 * of owner action is being approved, so a person reading only the OS dialog is
 * not consenting blind.
 */
export function describePurpose(operation, detail = {}) {
  switch (operation) {
    case "authorize_goal":
      return [
        "Authorize DataScape autonomous work",
        detail.scope_label ? `Scope: ${detail.scope_label}` : null,
        detail.max_wall_time_ms ? `Maximum iteration: ${Math.round(detail.max_wall_time_ms / 60000)} minutes` : null,
        `Paid usage: $${detail.max_cost ?? 0}`,
      ].filter(Boolean).join("\n");
    case "authorize_bounded_task":
      return [
        "Authorize one bounded DataScape task",
        detail.scope_label ? `Scope: ${detail.scope_label}` : null,
        detail.done_when ? `Done when: ${detail.done_when}` : null,
      ].filter(Boolean).join("\n");
    case "narrow_authority":
      return "Narrow autonomous work under this DataScape goal";
    case "revoke_authority":
      return "Stop autonomous work under this DataScape goal";
    case "approve":
      return `Approve the proposed action on ${detail.exception_id ?? "this exception"}`;
    case "reply_done":
      return `Mark exception ${detail.exception_id ?? ""} as Done`.trim();
    case "reply_no":
      return `Decline exception ${detail.exception_id ?? ""}`.trim();
    case "reply_need_context":
      return `Ask for more context on exception ${detail.exception_id ?? ""}`.trim();
    case "defer":
      return `Defer exception ${detail.exception_id ?? ""}`.trim();
    case "dismiss":
      return `Dismiss exception ${detail.exception_id ?? ""}`.trim();
    default:
      return `Approve a DataScape owner action (${operation})`;
  }
}

/**
 * A short-lived READ unlock (§ "Optional read unlock").
 *
 * It may permit reading private authority context and preparing a preview. It
 * may NEVER satisfy a mutation — every owner ruling still invokes Windows
 * verification. That is the protection against an agent driving an already-open
 * browser, so the distinction is enforced here rather than described.
 */
export function createReadUnlock({ now, ttlMs = 5 * 60 * 1000 }) {
  let until = 0;
  return {
    grant() { until = now() + ttlMs; return { unlocked_until: until }; },
    mayRead() { return now() < until; },
    /** Structural, and asserted in tests. */
    mayMutate() { return false; },
    // Process memory only: never persisted, lost on host restart.
    persisted: false,
  };
}

// Lease-based execution — spec V6 §3, §4.
//
// Invariant: one intent has at most one ACTIVE execution lease. Many executors
// may observe an intent; only the lease holder may mutate its working state.
//
// This is the concrete answer to the overnight failure where two agents both
// independently conclude "I should continue this" and do the same work twice —
// or worse, do contradictory halves of it. Ownership is decided by
// compare-and-swap against the lease record, never by "last writer wins".
//
// Time is injected. A control plane that reads the wall clock cannot be tested
// for expiry without sleeping, and a test that sleeps is a test people delete.

export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

export function createLeaseManager({ now }) {
  if (typeof now !== "function") throw new Error("a clock function is required");
  /** intent_id -> lease */
  const leases = new Map();
  let counter = 0;

  const isActive = (lease, at) => lease && lease.released_at === null && lease.expires_at > at;

  return {
    /**
     * Claim an intent.
     *
     * Compare-and-swap: the claim succeeds only if the observed lease state is
     * still what the caller saw. A second executor arriving with the same
     * expectation loses deterministically rather than racing.
     */
    claim(intentId, executorId, { ttlMs = DEFAULT_LEASE_MS, attempt = 1 } = {}) {
      const at = now();
      const existing = leases.get(intentId);
      if (isActive(existing, at)) {
        return {
          ok: false,
          reason: existing.executor_id === executorId
            ? "this executor already holds the lease"
            : `intent is held by ${existing.executor_id} until ${new Date(existing.expires_at).toISOString()}`,
          lease: null,
          holder: existing.executor_id,
        };
      }
      const lease = {
        lease_id: `lease-${++counter}`,
        intent_id: intentId,
        executor_id: executorId,
        claimed_at: at,
        expires_at: at + ttlMs,
        heartbeat_at: at,
        // A recovered lease is a later ATTEMPT at the same work, not a new
        // piece of work and not a failure of the old one.
        attempt: existing ? existing.attempt + 1 : attempt,
        released_at: null,
        ttl_ms: ttlMs,
      };
      leases.set(intentId, lease);
      return { ok: true, lease, recovered: Boolean(existing) };
    },

    /**
     * Renew. A heartbeat is working state and nothing else: it extends the
     * lease and never produces semantic history. Same principle as a session
     * heartbeat in V5 — a machine proving it is alive is not an event in the
     * owner's understanding of her work.
     */
    heartbeat(leaseId) {
      const at = now();
      const lease = [...leases.values()].find((l) => l.lease_id === leaseId);
      if (!isActive(lease, at)) return { ok: false, reason: "no active lease with that id", emits_history: false };
      lease.heartbeat_at = at;
      lease.expires_at = at + lease.ttl_ms;
      return { ok: true, lease, emits_history: false };
    },

    /** Voluntary release, which is the well-behaved path and pairs with a checkpoint. */
    release(leaseId) {
      const lease = [...leases.values()].find((l) => l.lease_id === leaseId);
      if (!lease || lease.released_at !== null) return { ok: false, reason: "no such held lease" };
      lease.released_at = now();
      return { ok: true, lease };
    },

    /**
     * Expiry is NOT failure.
     *
     * A closed browser, a killed session, a laptop lid — none of these are
     * semantic facts about the work, and manufacturing a failure event for them
     * would push machine noise all the way up to A0 where the owner reads it as
     * "something went wrong with my research". The intent simply becomes
     * claimable again by the next executor.
     */
    expired(at = now()) {
      return [...leases.values()]
        .filter((l) => l.released_at === null && l.expires_at <= at)
        .map((l) => ({ intent_id: l.intent_id, lease_id: l.lease_id, executor_id: l.executor_id, attempt: l.attempt }));
    },

    holder(intentId) {
      const lease = leases.get(intentId);
      return isActive(lease, now()) ? lease : null;
    },

    /** Only the lease holder may mutate working state. Everyone else may read. */
    mayMutate(intentId, executorId) {
      const lease = this.holder(intentId);
      if (!lease) return { allowed: false, reason: "no active lease; working state is read-only" };
      if (lease.executor_id !== executorId) {
        return { allowed: false, reason: `working state is owned by ${lease.executor_id}` };
      }
      return { allowed: true, lease_id: lease.lease_id };
    },

    all() {
      return [...leases.values()].map((l) => ({ ...l }));
    },
  };
}

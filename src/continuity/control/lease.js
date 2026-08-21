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
  /**
   * intent_id -> monotonically increasing generation (spec V6.1 section 9).
   *
   * Compare-and-swap at claim time is not sufficient on its own. It stops two
   * executors claiming at once; it does NOT stop an executor whose result was
   * already in flight when its lease turned over. That late writer must keep
   * its evidence and lose its authority, and only a fencing token can tell the
   * difference between "this arrived late" and "this is current".
   */
  const generations = new Map();
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
        // Never reused and never decreasing, including across release and
        // re-claim by the same executor.
        generation: (generations.get(intentId) ?? 0) + 1,
        released_at: null,
        ttl_ms: ttlMs,
      };
      generations.set(intentId, lease.generation);
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

    /** The current fencing generation for an intent; 0 if never claimed. */
    generation(intentId) {
      return generations.get(intentId) ?? 0;
    },

    /**
     * Is a write from this generation still authoritative?
     *
     * A stale generation may still carry valid evidence — that is the caller's
     * business — but it may not mutate control-plane state.
     */
    fence(intentId, generation) {
      const current = generations.get(intentId) ?? 0;
      if (!Number.isFinite(generation)) return { ok: false, current, reason: "no fencing token" };
      if (generation < current) {
        return { ok: false, current, stale: true, reason: `generation ${generation} was superseded by ${current}` };
      }
      return { ok: true, current };
    },

    holder(intentId) {
      const lease = leases.get(intentId);
      return isActive(lease, now()) ? lease : null;
    },

    /**
     * Only the lease holder may mutate working state. Everyone else may read.
     *
     * When a generation is supplied it is fenced too, so an executor that still
     * holds a lease object from an earlier generation is refused even though
     * its executor id matches.
     */
    mayMutate(intentId, executorId, generation = null) {
      const lease = this.holder(intentId);
      if (!lease) return { allowed: false, reason: "no active lease; working state is read-only" };
      if (lease.executor_id !== executorId) {
        return { allowed: false, reason: `working state is owned by ${lease.executor_id}` };
      }
      if (generation !== null) {
        const fenced = this.fence(intentId, generation);
        if (!fenced.ok) return { allowed: false, reason: fenced.reason, stale: true };
      }
      return { allowed: true, lease_id: lease.lease_id, generation: lease.generation };
    },

    all() {
      return [...leases.values()].map((l) => ({ ...l }));
    },
  };
}

// The exception-adapter contract — spec V6.1.6 §6.
//
// The durable journal's recovery correctness DEPENDS on this contract. Recovery
// calls `resolve()` a second time after a crash, and that is only safe if the
// real exception layer is idempotent for the same ruling and refuses a
// different one.
//
// So the contract is executable, and it runs against the REAL implementation —
// in a temporary exception namespace, never by resolving her actual blocker.
// A contract that is only ever run against a fixture proves that the fixture
// agrees with itself.

export const CONTRACT_CASES = [
  "unresolved_resolves_by_ruling",
  "same_ruling_is_idempotent",
  "different_ruling_is_refused",
  "resolution_reports_who_resolved_it",
];

/**
 * Run the contract against an exception implementation.
 *
 * `adapter.resolve(id, { ruling_ref })` is the surface under test. `namespace`
 * must be a test/temporary exception id — the caller supplies it, so this
 * module can never be pointed at the real blocker by default.
 */
export function runExceptionContract({ adapter, namespace, rulingA = "owner-ruling:test-a:rev1", rulingB = "owner-ruling:test-b:rev1" }) {
  if (!namespace || !/test|tmp|fixture|contract/i.test(namespace)) {
    // Refusing rather than trusting the caller: this contract writes
    // resolutions, and pointing it at a real exception would resolve a real
    // blocker as a side effect of testing.
    throw new Error("the exception contract must run in a temporary or test exception namespace");
  }

  const results = {};
  const record = (name, pass, detail) => { results[name] = { pass, detail }; };

  // 1. An unresolved exception resolves.
  const first = adapter.resolve(namespace, { ruling_ref: rulingA });
  record("unresolved_resolves_by_ruling", Boolean(first?.ok), first?.reason);

  // 2. The SAME ruling again is an idempotent success. This is the case
  //    recovery depends on: it retries a resolve it cannot know succeeded.
  const replay = adapter.resolve(namespace, { ruling_ref: rulingA });
  record("same_ruling_is_idempotent", Boolean(replay?.ok), replay?.reason);

  // 3. A DIFFERENT ruling is refused, and says who holds it. Silently
  //    accepting would let one authority be stacked on another's resolution.
  const collision = adapter.resolve(namespace, { ruling_ref: rulingB });
  record("different_ruling_is_refused", collision?.ok === false, collision?.reason);
  record("resolution_reports_who_resolved_it", collision?.resolved_by === rulingA,
    `resolved_by=${collision?.resolved_by}`);

  const failed = CONTRACT_CASES.filter((c) => !results[c]?.pass);
  return {
    namespace,
    cases: results,
    failed,
    // The journal may only be trusted against an implementation that passes.
    satisfies_contract: failed.length === 0,
  };
}

/**
 * A reference implementation of the contract.
 *
 * Not a stand-in for the real layer — a demonstration that the contract is
 * satisfiable, so a failure against the real one means the real one is wrong
 * rather than the contract being impossible.
 */
export function createContractExceptionStore() {
  const resolvedBy = new Map();
  return {
    resolve(id, meta) {
      const existing = resolvedBy.get(id);
      const ruling = meta?.ruling_ref ?? null;
      if (!ruling) return { ok: false, reason: "a resolution must name its ruling" };
      if (existing && existing !== ruling) {
        return { ok: false, resolved_by: existing, reason: "already resolved by a different ruling" };
      }
      resolvedBy.set(id, ruling);
      return { ok: true, resolved_by: ruling };
    },
    isResolved: (id) => resolvedBy.has(id),
    resolvedBy,
  };
}

// Real authority persistence — spec V6.1.5 §1–§8, made durable per the PR B
// governance review (P0-3).
//
// The missing link between "the owner deliberately authorized something" and
// "V6 can re-run admission against it". Still NO transport and NO executor:
// persisting an envelope grants zero execution.
//
// Everything here prevents one class of failure — authority that is
// half-written, over-wide, duplicated, stale, or granted by something that only
// claimed to be the owner. Each is a way the system could end up believing it
// was told something it was never told.
//
// State lives in the journal, not in this closure. An earlier version kept
// revisions and idempotency in two in-process Maps, which meant authority
// vanished on restart and "all-or-nothing" was a description rather than a
// property.

import { verifyGoalAuthority } from "./goal.js";
import { authorize, authorCanary, policyIdentityOf as policyIdentity } from "./authority-draft.js";
import { createAuthorityJournal, createMemoryStorage } from "./authority-journal.js";

export const AUTH_ACTIONS = ["authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority"];

// The policy identity lives in the pure authoring module so the presentational
// shell can compute it without importing this file. Re-exported here because
// every existing caller reaches for it through the store.
export { policyIdentityOf as policyIdentity } from "./authority-draft.js";

/**
 * The authenticated-owner boundary (§2).
 *
 * NO API reachable by an agent may accept `actor: "owner"` as proof. Identity
 * comes from the application boundary — a verifier the caller cannot supply for
 * itself — because a string an agent can type is a string an agent can type.
 */
export function createOwnerBoundary({ authenticate }) {
  if (typeof authenticate !== "function") throw new Error("an authenticated owner boundary is required");
  return {
    verify(request) {
      const principal = authenticate(request.credentials ?? null);
      if (!principal || principal.role !== "owner") {
        return { ok: false, reason: "the request does not carry authenticated owner provenance" };
      }
      if (!AUTH_ACTIONS.includes(request.action)) {
        return { ok: false, reason: `${request.action ?? "no action"} is not an authorization action` };
      }
      return { ok: true, principal };
    },
    trusts_claimed_actor: false,
  };
}

/**
 * The durable authority store.
 *
 * `storage` is injected, so a test can build two stores over one backing store
 * and that is exactly what a restart is.
 */
export function createAuthorityStore({ boundary, exceptions, now, verifier = verifyGoalAuthority, storage = null, faultInjector = null }) {
  const journal = createAuthorityJournal({
    storage: storage ?? createMemoryStorage(),
    exceptions,
    now,
    // A CONSTRUCTION-time test capability. It was previously read off the
    // request body, which made an internal fault switch reachable by anything
    // that could reach the endpoint — including an authenticated owner's
    // browser. Fault injection is not a feature.
    faultInjector,
  });
  /**
   * Material events are DERIVED from committed revisions rather than
   * accumulated in a process-local array. An in-memory list meant that after a
   * restart the authority existed but the semantic evidence of the owner's
   * ruling did not — which contradicts the invariant that authority changes are
   * historically meaningful.
   */
  function materialMutations() {
    const seen = new Map();
    for (const entry of journal.allCommitted()) {
      const record = entry.record;
      if (!record?.goal) continue;
      const key = `${record.goal.goal_id}:rev${record.revision}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        type: "operation_completed",
        intent_id: record.goal.goal_id,
        operation_id: `${record.ruling.ref}:rev${record.revision}`,
        at: new Date(record.authorized_at).toISOString(),
        trigger: "owner",
        text: record.state === "revoked" ? "Autonomy revoked by the owner."
          : record.state === "narrowed" ? "Autonomy narrowed by the owner."
            : `Autonomy authorized for ${record.scope_label || record.scope_refs.join(", ")}.`,
      });
    }
    return [...seen.values()];
  }

  function buildGrant(request, at) {
    const { draft } = request;
    if (!draft) return { ok: false, reason: "no draft supplied", outcome: "transaction_failed" };

    const identity = policyIdentity(draft);
    if (request.policy_identity !== identity) {
      return { ok: false, outcome: "stale_preview", reason: "the draft changed after the preview; review is required again" };
    }

    const authored = request.action === "authorize_bounded_task"
      ? authorCanary(draft, { actor: "owner", at })
      : authorize(draft, { actor: "owner", action: request.action, at, revision: 1 });
    if (!authored.ok) return { ok: false, outcome: "invalid_draft", reason: authored.reason };

    // §7: the blocker resolves only for an object the Goal verifier accepts.
    const verified = verifier(authored.goal, [{ ref: authored.ruling.ref, kind: authored.ruling.kind }]);
    if (verified.authority !== "found") {
      return { ok: false, outcome: "not_admissible", reason: `the authored goal does not satisfy the goal verifier (${verified.authority})` };
    }

    return {
      ok: true,
      value: {
        revision: 1,
        state: "authorized",
        authorized_at: at,
        ruling: authored.ruling,
        goal: authored.goal,
        // §5: the REFS are the authority. The label is display metadata.
        scope_refs: [...draft.scope_refs],
        scope_label: draft.scope_label ?? null,
        capability_envelope: authored.envelope,
        budget: { max_cost: draft.max_cost, max_wall_time_ms: draft.max_wall_time_ms },
        stop_conditions: [...draft.stop_conditions],
        source_exception_id: request.source_exception_id ?? null,
        policy_identity: identity,
        declaration: authored.declaration ?? null,
        kind: draft.kind,
      },
    };
  }

  function buildAmend(request, at) {
    // `request.existing` is the CURRENT RECORD FROM THE OUTER JOURNAL, supplied
    // by the caller that owns the transaction.
    //
    // This store is constructed over its own journal, and in the deployed
    // composition that journal is a dummy — the durable one lives outside, held
    // by the commit path so there is exactly one transaction per mutation. So
    // `journal.current()` here always saw nothing, and narrow and revoke could
    // never build at all: they would refuse with "no authority to amend" for an
    // authority that plainly existed.
    //
    // Falling back to the internal journal keeps the older in-process path
    // working unchanged.
    const existing = request.existing !== undefined
      ? request.existing
      : journal.current(request.goal_id);
    if (!existing) return { ok: false, outcome: "transaction_failed", reason: "no authority to amend" };

    // §6: compare-and-swap against the CURRENT committed revision.
    if (request.expected_revision !== existing.revision) {
      return {
        ok: false, outcome: "stale_revision",
        reason: `expected revision ${request.expected_revision}, current is ${existing.revision}`,
      };
    }

    const revoking = request.action === "revoke_authority";
    const scopeRefs = revoking ? [] : [...(request.scope_refs || [])];
    if (!revoking && scopeRefs.some((r) => !existing.scope_refs.includes(r))) {
      return { ok: false, outcome: "not_a_narrowing", reason: "narrowing may not add scope; that is a new authorization" };
    }

    return {
      ok: true,
      value: {
        ...existing,
        revision: existing.revision + 1,
        state: revoking ? "revoked" : "narrowed",
        authorized_at: at,
        scope_refs: scopeRefs,
        goal: {
          ...existing.goal,
          allowed_scope_refs: scopeRefs,
          autonomy_policy: revoking ? null : existing.goal.autonomy_policy,
        },
      },
    };
  }

  return {
    /**
     * Authorize, narrow or revoke. One entry point, one durable transaction.
     *
     * Crash behaviour is MEASURED by the governance harness rather than
     * asserted, via a fault injector supplied when this store is constructed —
     * never by anything in a request.
     */
    /**
     * Build the authority record WITHOUT transacting.
     *
     * The V6.1.6 commit path owns its own durable transaction — the pre-prompt
     * claim, the presence consume and the final CAS all have to sit inside one
     * `transact`, and calling `commit()` from within it would nest a
     * transaction inside a transaction. This exposes the record construction on
     * its own so there is still exactly ONE way a record is built, and exactly
     * one journal it lands in.
     *
     * It writes nothing. The caller supplies the transaction.
     */
    buildFor(request, at = now()) {
      const amending = request.action === "narrow_authority" || request.action === "revoke_authority";
      return amending ? buildAmend(request, at) : buildGrant(request, at);
    },

    commit(request) {
      if (!request.operation_id) return { ok: false, reason: "an authorization requires an operation_id" };

      const done = journal.completed(request.operation_id);
      if (done) {
        return {
          ok: true, replayed: true, outcome: done.record.state,
          goal_id: done.record.goal.goal_id, revision: done.record.revision, record: done.record,
          exception_resolved: Boolean(done.source_exception_id),
        };
      }

      const auth = boundary.verify(request);
      if (!auth.ok) return { ok: false, reason: auth.reason };

      const at = now();
      const amending = request.action === "narrow_authority" || request.action === "revoke_authority";
      const result = journal.transact({
        operation_id: request.operation_id,
        // An amendment resolves no exception; only the original grant does.
        source_exception_id: amending ? null : request.source_exception_id ?? null,
        build: () => (amending ? buildAmend(request, at) : buildGrant(request, at)),
      });
      if (!result.ok) return result;

      const record = result.record;

      return {
        ok: true,
        outcome: record.state,
        goal_id: record.goal.goal_id,
        revision: record.revision,
        record,
        exception_resolved: Boolean(!amending && request.source_exception_id),
        replayed: result.replayed,
      };
    },

    current: (goalId) => journal.current(goalId),
    /**
     * Has this operation already committed durably?
     *
     * Exposed so the endpoint can replay a committed operation BEFORE it
     * verifies a receipt — a short-lived preview receipt must not be able to
     * undo durable idempotency.
     */
    completedOperation: (operationId) => journal.completed(operationId),
    currentForDomain: (exceptionId) => journal.currentForDomain(exceptionId),

    history(goalId) {
      return journal.revisions(goalId).map((r) => ({
        revision: r.revision, state: r.state, authorized_at: r.authorized_at, scope_refs: [...r.scope_refs],
      }));
    },

    observableState: (goalId, exceptionId) => journal.observableState(goalId, exceptionId),
    recoveredOnOpen: () => journal.recovered_on_open,

    /**
     * The V5 bridge (§8). Granting, narrowing and revoking are history; draft
     * edits and preview navigation emit nothing at all.
     */
    /**
     * The material mutations, as DATA (V5 §8).
     *
     * The `bridge()` projection used to happen here. That put `bridge.js` — and
     * through it the event schema outside `control/` — into the deployed
     * authority subsystem's import closure, which the runtime gate refuses.
     * It is right to refuse: a reviewed security set should not span the tree
     * for a history projection the authority host never calls.
     *
     * So the store still produces the mutations and `authority-events.js` does
     * the projection. Nothing is lost and the boundary stays where it belongs.
     */
    materialMutations,
  };
}

/** Draft edits and preview navigation are not events (§8). */
export function draftActivityIsEphemeral(kind) {
  return ["draft_edited", "preview_rendered", "form_opened", "navigated_away"].includes(kind);
}

/**
 * The shadow re-audit trigger (§10).
 *
 * After a real authorization, V6 does NOT execute. It re-runs its own audit
 * against the newly granted envelope.
 */
export function shadowReauditRequest(record) {
  return {
    reason: "authority_changed",
    goal_id: record.goal.goal_id,
    revision: record.revision,
    scope_refs: [...record.scope_refs],
    executes: false,
    dispatches: false,
  };
}

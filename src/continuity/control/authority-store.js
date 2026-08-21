// Real authority persistence — spec V6.1.5 §1–§8.
//
// The missing link between "the owner deliberately authorized something" and
// "V6 can re-run admission against it". Still NO transport and NO executor:
// persisting an envelope grants zero execution.
//
// Everything here exists to prevent one class of failure — authority that is
// half-written, over-wide, duplicated, stale, or granted by something that only
// claimed to be the owner. Each is a way the system could end up believing it
// was told something it was never told.

import { verifyGoalAuthority } from "./goal.js";
import { authorize, authorCanary } from "./authority-draft.js";
import { bridge } from "./bridge.js";

export const AUTH_ACTIONS = ["authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority"];

/**
 * A deterministic identity over everything the owner is agreeing to (§3).
 *
 * The authorization request references this exact value, so a draft edited
 * after the preview was rendered cannot be authorized against the older,
 * narrower-looking preview. That is the TOCTOU widening the spec forbids: she
 * reads one envelope and a different one gets written.
 */
export function policyIdentity(draft) {
  const canonical = JSON.stringify({
    statement: draft.statement,
    scope_refs: [...draft.scope_refs].sort(),
    allowed: [...draft.allowed_capabilities].sort(),
    max_cost: draft.max_cost,
    max_wall_time_ms: draft.max_wall_time_ms,
    stop_conditions: [...draft.stop_conditions].sort(),
    kind: draft.kind,
    credential_policy: draft.credential_policy,
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `pol_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

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
    /** Returns `{ ok, principal }`. A claimed actor field is never consulted. */
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
    // Structural: there is no path here that trusts request.actor.
    trusts_claimed_actor: false,
  };
}

/**
 * The transactional authority store.
 *
 * `commit` is all-or-nothing across the ruling, the goal, the revision and the
 * exception resolution. There is no "saved the goal but failed to write the
 * ruling" intermediate state, because that state is indistinguishable from a
 * goal nobody authorized.
 */
export function createAuthorityStore({ boundary, exceptions, now, verifier = verifyGoalAuthority }) {
  /** goal_id -> revisions[] */
  const revisions = new Map();
  /** operation_id -> completed result */
  const operations = new Map();
  const events = [];

  const current = (goalId) => {
    const list = revisions.get(goalId) || [];
    return list.length ? list[list.length - 1] : null;
  };

  function grant(request, at) {
    const { draft } = request;
    if (!draft) return { ok: false, reason: "no draft supplied" };

    // §3: the structure previewed must be the structure persisted.
    const identity = policyIdentity(draft);
    if (request.policy_identity !== identity) {
      return {
        ok: false,
        outcome: "stale_preview",
        reason: "the draft changed after the preview; review is required again",
      };
    }

    const authored = request.action === "authorize_bounded_task"
      ? authorCanary(draft, { actor: "owner", at })
      : authorize(draft, { actor: "owner", action: request.action, at, revision: 1 });
    if (!authored.ok) return { ok: false, outcome: "invalid_draft", reason: authored.reason };

    // §7: the blocker resolves only for an object the Goal verifier accepts. A
    // malformed task does not resolve it merely because Authorize was clicked,
    // and a goal that fails verification never silently becomes usable
    // authority.
    const verified = verifier(authored.goal, [{ ref: authored.ruling.ref, kind: authored.ruling.kind }]);
    if (verified.authority !== "found") {
      return {
        ok: false,
        outcome: "not_admissible",
        reason: `the authored goal does not satisfy the goal verifier (${verified.authority})`,
      };
    }

    const record = {
      revision: 1,
      state: "authorized",
      authorized_at: at,
      ruling: authored.ruling,
      goal: authored.goal,
      // §5: the REFS are the authority. The label is display metadata, stored
      // beside them and never instead of them.
      scope_refs: [...draft.scope_refs],
      scope_label: draft.scope_label ?? null,
      capability_envelope: authored.envelope,
      budget: { max_cost: draft.max_cost, max_wall_time_ms: draft.max_wall_time_ms },
      stop_conditions: [...draft.stop_conditions],
      source_exception_id: request.source_exception_id ?? null,
      policy_identity: identity,
      declaration: authored.declaration ?? null,
    };

    // The transaction. Resolving the exception is the LAST step, so a failure
    // anywhere above leaves the blocker open and no partial goal behind.
    let resolution = null;
    if (record.source_exception_id) {
      resolution = exceptions.resolve(record.source_exception_id, { ruling_ref: record.ruling.ref, at });
      if (!resolution?.ok) {
        return {
          ok: false,
          outcome: "resolution_failed",
          reason: resolution?.reason || "the exception could not be resolved",
        };
      }
    }

    revisions.set(record.goal.goal_id, [record]);
    events.push({
      type: "operation_completed",
      intent_id: record.goal.goal_id,
      operation_id: record.ruling.ref,
      // The V5 envelope wants an ISO instant; the injected clock speaks ms,
      // like every other clock in the control plane.
      at: new Date(at).toISOString(),
      trigger: "owner",
      text: `Autonomy authorized for ${record.scope_label || record.scope_refs.join(", ")}.`,
    });

    return {
      ok: true,
      outcome: "authorized",
      goal_id: record.goal.goal_id,
      revision: 1,
      record,
      exception_resolved: Boolean(resolution?.ok),
      replayed: false,
    };
  }

  function amend(request, at) {
    const existing = current(request.goal_id);
    if (!existing) return { ok: false, reason: "no authority to amend" };

    // §6: compare-and-swap against the CURRENT revision. A screen opened at
    // rev 2 cannot save over a rev 3 created elsewhere — no last-writer-wins
    // for authority.
    if (request.expected_revision !== existing.revision) {
      return {
        ok: false,
        outcome: "stale_revision",
        reason: `expected revision ${request.expected_revision}, current is ${existing.revision}`,
      };
    }

    const revoking = request.action === "revoke_authority";
    const scopeRefs = revoking ? [] : [...(request.scope_refs || [])];
    if (!revoking && scopeRefs.some((r) => !existing.scope_refs.includes(r))) {
      // Narrowing may only remove. Widening is a new grant, and a new grant is
      // a fresh authorization with its own preview.
      return { ok: false, outcome: "not_a_narrowing", reason: "narrowing may not add scope; that is a new authorization" };
    }

    const record = {
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
    };
    revisions.get(request.goal_id).push(record);
    events.push({
      type: "operation_completed",
      intent_id: request.goal_id,
      operation_id: `${record.ruling.ref}:rev${record.revision}`,
      at: new Date(at).toISOString(),
      trigger: "owner",
      text: revoking ? "Autonomy revoked by the owner." : "Autonomy narrowed by the owner.",
    });
    return { ok: true, outcome: record.state, goal_id: request.goal_id, revision: record.revision, record, replayed: false };
  }

  return {
    /**
     * Authorize, narrow or revoke. One entry point, one transaction.
     *
     * `operation_id` makes it idempotent (§4): a write that succeeded but whose
     * response was lost is replayed as the SAME result rather than creating a
     * second ruling. Double-clicking Authorize is the ordinary case, not the
     * exotic one.
     */
    commit(request) {
      if (!request.operation_id) return { ok: false, reason: "an authorization requires an operation_id" };
      if (operations.has(request.operation_id)) {
        // Replayed, not repeated.
        return { ...operations.get(request.operation_id), replayed: true };
      }

      const auth = boundary.verify(request);
      if (!auth.ok) return { ok: false, reason: auth.reason };

      const at = now();
      const outcome = request.action === "narrow_authority" || request.action === "revoke_authority"
        ? amend(request, at)
        : grant(request, at);

      if (!outcome.ok) return outcome;

      // Only a COMPLETED transaction is remembered as an operation, so a failed
      // attempt can be retried rather than replayed as a false success.
      operations.set(request.operation_id, outcome);
      return outcome;
    },

    current,

    history(goalId) {
      return (revisions.get(goalId) || []).map((r) => ({
        revision: r.revision,
        state: r.state,
        authorized_at: r.authorized_at,
        scope_refs: [...r.scope_refs],
      }));
    },

    /**
     * The V5 bridge (§8).
     *
     * Granting, narrowing and revoking authority are historically meaningful.
     * Draft edits and preview navigation emit nothing at all — they are not
     * "minor" events, they are not events.
     */
    materialEvents() {
      return bridge(events, { source_system: "continuity.authority" });
    },
  };
}

/**
 * Draft edits and preview navigation are not events (§8).
 *
 * Exported so the claim is testable rather than merely true today.
 */
export function draftActivityIsEphemeral(kind) {
  return ["draft_edited", "preview_rendered", "form_opened", "navigated_away"].includes(kind);
}

/**
 * The shadow re-audit trigger (§10).
 *
 * After a real authorization, V6 does NOT execute. It re-runs its own audit
 * against the newly granted envelope, so the next decision rests on evidence
 * generated from what she actually authorized.
 */
export function shadowReauditRequest(record) {
  return {
    reason: "authority_changed",
    goal_id: record.goal.goal_id,
    revision: record.revision,
    scope_refs: [...record.scope_refs],
    // Explicit, so nobody has to infer it from the absence of a field.
    executes: false,
    dispatches: false,
  };
}

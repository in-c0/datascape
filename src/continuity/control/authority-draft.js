// The authority authoring contract — spec V6.1.4 §1, §3–§10, §12.
//
// NOT another control-plane abstraction. Goal, WorkDeclaration, admission,
// leases, gates and dispatch are frozen. This is the authoring contract behind
// a human interface for an object V6.1.3 already requires and nothing in the
// portfolio currently supplies.
//
// The design question it answers: how does the owner authorize meaningful
// autonomous work in 20-60 seconds without accidentally granting "do whatever
// you want"?
//
// The answer is deny-by-default composition. Broad natural language establishes
// DIRECTION; explicit capabilities establish AUTONOMY. Those two must stay
// visibly separate, because "you can work on DataScape" must never be read as
// "you can deploy, spend money, publish, and use credentials".

import { createAutonomyPolicy, createGoal } from "./goal.js";
import { createWorkDeclaration } from "./declaration.js";

/**
 * The stable capability vocabulary.
 *
 * Owner-facing checkboxes map to THESE, never to free-text interpretation. A
 * capability outside this list is owner-required — silence in a vocabulary is
 * not a grant, and a natural-language phrase is not a capability.
 */
export const CAPABILITIES = {
  inspect_repository: { label: "Inspect repository", operations: ["inspect_repository"], reversible: true },
  run_tests: { label: "Run local tests", operations: ["run_tests"], reversible: true },
  modify_code: { label: "Modify code", operations: ["prepare_patch"], reversible: true },
  run_verification: { label: "Run local/browser verification", operations: ["run_verification"], reversible: true },
  prepare_pull_requests: { label: "Prepare branches / PRs", operations: ["open_internal_pr"], reversible: true },
  use_credentials: { label: "Use credentials", operations: ["supply_credential"], reversible: false },
  spend_money: { label: "Spend money", operations: ["spend_money"], reversible: false },
  publish_publicly: { label: "Publish publicly", operations: ["approve_external_post"], reversible: false },
  production_destructive: { label: "Production / destructive actions", operations: ["production_destructive"], reversible: false },
  expand_goal: { label: "Expand the goal", operations: ["strategic_ruling"], reversible: false },
};

/** Capabilities that may never be granted through this surface at all. */
export const NEVER_AUTONOMOUS = ["use_credentials", "spend_money", "publish_publicly", "production_destructive", "expand_goal"];

export const DRAFT_STATES = ["draft", "authorized", "narrowed", "revoked"];

/**
 * An authority draft.
 *
 * A draft has ZERO authoritative effect. Opening the form, editing text and
 * navigating away all leave the world exactly as it was — only an explicit
 * owner authorization creates a ruling (§9).
 */
export function createAuthorityDraft({
  draft_id,
  kind = "persistent_goal",
  statement = "",
  scope_refs = [],
  allowed_capabilities = [],
  stop_conditions = [],
  max_cost = 0,
  max_wall_time_ms = 15 * 60 * 1000,
  credential_policy = "none",
}) {
  if (!draft_id) throw new Error("an authority draft requires draft_id");
  if (!["persistent_goal", "bounded_canary"].includes(kind)) throw new Error(`unknown draft kind: ${kind}`);
  return {
    draft_id,
    kind,
    statement,
    scope_refs: [...scope_refs],
    allowed_capabilities: [...allowed_capabilities],
    stop_conditions: [...stop_conditions],
    // Defaults are the restrictive end of every axis, and none of them is
    // inferred from historical usage (§6).
    max_cost,
    max_wall_time_ms,
    credential_policy,
    state: "draft",
    // Structural, not a promise: a draft grants nothing.
    grants_authority: false,
  };
}

/**
 * Compose an envelope from selected capabilities. Deny-by-default (§5).
 *
 * A capability the owner did not select is owner-required, not merely absent.
 * An unrecognised capability is owner-required too. Selections are NEVER
 * auto-expanded: ticking "modify code" does not imply "open a PR".
 */
export function composeEnvelope(selected) {
  const allowed = [];
  const ownerRequired = [];
  const prohibited = [];

  for (const [name, capability] of Object.entries(CAPABILITIES)) {
    if (NEVER_AUTONOMOUS.includes(name)) {
      // Selectable in the "still ask me" column only. Selecting one here is a
      // no-op rather than an error: the surface refuses to grant it.
      ownerRequired.push(...capability.operations);
      continue;
    }
    if (selected.includes(name)) allowed.push(...capability.operations);
    else ownerRequired.push(...capability.operations);
  }

  const unknown = selected.filter((s) => !Object.hasOwn(CAPABILITIES, s));
  for (const name of unknown) prohibited.push(name);

  return {
    allowed_capabilities: allowed,
    owner_required_capabilities: ownerRequired,
    // An unknown capability is refused outright rather than silently ignored,
    // so a typo cannot quietly become a grant OR a silent denial nobody sees.
    prohibited_capabilities: prohibited,
    unknown_capabilities: unknown,
  };
}

/**
 * A candidate suggestion drawn from owner-authored evidence (§3).
 *
 * Copy-into-draft, never pre-authorized. And never derived from behaviour:
 * "you usually let agents merge PRs" is not a grant, it is a description of
 * what happened.
 */
export function suggestFromEvidence(records) {
  return records
    .filter((r) => r.authored_by === "owner" && r.text)
    .map((r) => ({
      starting_text: r.text,
      source_ref: r.ref,
      // The two properties that make a suggestion safe.
      pre_authorized: false,
      capabilities_prechecked: [],
    }));
}

/**
 * Resolve owner-facing scope words to explicit references (§7).
 *
 * When a description cannot resolve uniquely the answer is `needs_clarification`
 * — never a broad scope manufactured to make the form submittable.
 */
export function resolveScopeSelection(selection, catalogue) {
  const matches = catalogue.filter((entry) =>
    entry.labels.some((l) => l.toLowerCase() === String(selection).toLowerCase()));
  if (matches.length === 1) return { resolved: true, scope_refs: [...matches[0].refs] };
  if (matches.length === 0) {
    return { resolved: false, outcome: "needs_clarification", reason: `no known project or area matches "${selection}"` };
  }
  return {
    resolved: false,
    outcome: "needs_clarification",
    reason: `"${selection}" matches ${matches.length} areas`,
    candidates: matches.map((m) => m.labels[0]),
  };
}

/**
 * The deterministic preview (§8).
 *
 * A rendering of the structured policy, not an AI summary. The owner authorizes
 * the envelope this preview represents, so it must be derivable from the policy
 * alone and identical every time for identical input.
 */
export function renderPreview(draft, envelope) {
  const may = envelope.allowed_capabilities
    .map((op) => Object.values(CAPABILITIES).find((c) => c.operations.includes(op))?.label)
    .filter(Boolean);
  const mustAsk = [...new Set(envelope.owner_required_capabilities
    .map((op) => Object.values(CAPABILITIES).find((c) => c.operations.includes(op))?.label)
    .filter(Boolean))];

  return {
    statement: draft.statement,
    may_autonomously: may,
    must_stop_and_ask: mustAsk,
    scope_refs: [...draft.scope_refs],
    max_cost: draft.max_cost,
    max_iteration_minutes: Math.round(draft.max_wall_time_ms / 60000),
    stop_conditions: [...draft.stop_conditions],
    credential_policy: draft.credential_policy,
    deterministic: true,
  };
}

/**
 * Authorize. THE authority event (§9).
 *
 * Only an explicit owner action reaches here. Navigating away, opening the
 * form, editing draft text, a generic `ctn`, an agent submitting the form, and
 * a machine message claiming the owner approved are all refused — the last two
 * explicitly, because they are the ones an unattended system could actually
 * produce.
 */
export function authorize(draft, { actor, action, at, revision = 1 }) {
  if (actor !== "owner") {
    return { ok: false, reason: "only the owner may authorize an autonomy envelope", ruling: null };
  }
  if (!["authorize_goal", "authorize_bounded_task"].includes(action)) {
    return { ok: false, reason: `${action} is not an authorization action`, ruling: null };
  }
  const problems = validateDraft(draft);
  if (problems.length) return { ok: false, reason: problems.join("; "), ruling: null };

  const envelope = composeEnvelope(draft.allowed_capabilities);
  const goal = createGoal({
    goal_id: `goal:${draft.draft_id}`,
    statement: draft.statement,
    // The authority source IS this owner ruling. Nothing else.
    authority_source_refs: [`owner-ruling:${draft.draft_id}:rev${revision}`],
    allowed_scope_refs: draft.scope_refs,
    prohibited_scope_refs: [],
    autonomy_policy: createAutonomyPolicy({
      autonomous_operations: envelope.allowed_capabilities,
      owner_required_operations: envelope.owner_required_capabilities,
      max_cost: draft.max_cost,
      max_wall_time_ms: draft.max_wall_time_ms,
    }),
    stop_conditions: draft.stop_conditions,
    created_at: at,
  });

  return {
    ok: true,
    ruling: {
      ref: `owner-ruling:${draft.draft_id}:rev${revision}`,
      kind: "owner_authored_objective",
      revision,
      authorized_at: at,
      state: "authorized",
    },
    goal,
    envelope,
  };
}

function validateDraft(draft) {
  const problems = [];
  if (!draft.statement || draft.statement.trim().length < 8) problems.push("the goal statement is empty or too vague to be testable");
  if (draft.scope_refs.length === 0) problems.push("no scope references were resolved");
  if (draft.allowed_capabilities.length === 0) problems.push("no autonomous capability was selected");
  for (const name of draft.allowed_capabilities) {
    if (NEVER_AUTONOMOUS.includes(name)) problems.push(`${name} may not be granted autonomously through this surface`);
    if (!Object.hasOwn(CAPABILITIES, name)) problems.push(`unknown capability: ${name}`);
  }
  if (draft.max_cost > 0 && draft.credential_policy === "none" && draft.allowed_capabilities.includes("spend_money")) {
    problems.push("a spend budget cannot be granted without an explicit credential policy");
  }
  return problems;
}

// ---- Revision, narrowing and revocation (§10) ---------------------------------

export function createAuthorityLedger() {
  /** goal_id -> revisions[] */
  const revisions = new Map();

  return {
    record(goalId, ruling, goal) {
      const list = revisions.get(goalId) || [];
      list.push({ ...ruling, goal });
      revisions.set(goalId, list);
      return list.length;
    },

    /** The CURRENT revision. New dispatches use only this. */
    current(goalId) {
      const list = revisions.get(goalId) || [];
      return list.length ? list[list.length - 1] : null;
    },

    narrow(goalId, narrower, { at }) {
      const current = this.current(goalId);
      if (!current) return { ok: false, reason: "no authority to narrow" };
      const goal = { ...current.goal, allowed_scope_refs: [...narrower.scope_refs] };
      return { ok: true, revision: this.record(goalId, { ...current, revision: current.revision + 1, authorized_at: at, state: "narrowed" }, goal) };
    },

    revoke(goalId, { at }) {
      const current = this.current(goalId);
      if (!current) return { ok: false, reason: "no authority to revoke" };
      return { ok: true, revision: this.record(goalId, { ...current, revision: current.revision + 1, authorized_at: at, state: "revoked" }, { ...current.goal, autonomy_policy: null, allowed_scope_refs: [] }) };
    },

    /**
     * Is a running lease still inside the CURRENT envelope?
     *
     * An old lease must never become a grandfathered authority token: authority
     * narrowed while work is in flight is re-checked at the next safe
     * checkpoint, and work now outside scope stops there.
     */
    checkRunningLease(goalId, leaseScopeRefs) {
      const current = this.current(goalId);
      if (!current || current.state === "revoked") {
        return { within: false, action: "stop_and_checkpoint", reason: "authority was revoked" };
      }
      const allowed = current.goal.allowed_scope_refs || [];
      const outside = leaseScopeRefs.filter((r) => !allowed.includes(r));
      return outside.length
        ? { within: false, action: "stop_and_checkpoint", outside, reason: "authority was narrowed below this lease's scope" }
        : { within: true, action: "continue" };
    },

    history(goalId) {
      return (revisions.get(goalId) || []).map((r) => ({ revision: r.revision, state: r.state, authorized_at: r.authorized_at }));
    },
  };
}

// ---- Pause (§11) --------------------------------------------------------------

/**
 * Pause means NO NEW DISPATCHES. It does not delete history, resolve
 * exceptions, or fabricate failures — a pause is not an incident.
 */
export function createPauseState() {
  const paused = new Set();
  let global = false;
  return {
    pauseAll() { global = true; return { paused: true, scope: "global" }; },
    resumeAll() { global = false; return { paused: false, scope: "global" }; },
    pause(goalId) { paused.add(goalId); return { paused: true, scope: goalId }; },
    resume(goalId) { paused.delete(goalId); return { paused: false, scope: goalId }; },
    mayDispatch(goalId) {
      if (global) return { allowed: false, reason: "autonomous work is globally paused" };
      if (paused.has(goalId)) return { allowed: false, reason: `${goalId} is paused` };
      return { allowed: true };
    },
    effects() {
      return { deletes_history: false, resolves_exceptions: false, creates_failures: false };
    },
  };
}

// ---- Bounded canary authoring (§12) -------------------------------------------

/**
 * The bounded-task path.
 *
 * Produces an owner-authored goal AND an owner-authored work declaration, both
 * of which then go through the SAME V6.1.3 admission. Owner authorship is not a
 * bypass: a malformed or unresolvable scope is still rejected.
 */
export function authorCanary(draft, { actor, at }) {
  if (actor !== "owner") return { ok: false, reason: "only the owner may authorize a bounded task" };
  if (!draft.success_condition || draft.success_condition.trim().length < 8) {
    return { ok: false, reason: "the bounded task needs a testable success condition" };
  }
  const authorized = authorize(
    { ...draft, kind: "bounded_canary" },
    { actor, action: "authorize_bounded_task", at },
  );
  if (!authorized.ok) return authorized;

  const declaration = createWorkDeclaration({
    declaration_id: `decl:${draft.draft_id}`,
    goal_id: authorized.goal.goal_id,
    authored_by: "owner",
    operation: draft.operation,
    success_condition: draft.success_condition,
    scope_refs: draft.scope_refs,
    scope_provenance_refs: [authorized.ruling.ref],
    semantic_centre_refs: draft.scope_refs,
    estimated_budget: { max_cost: draft.max_cost, max_wall_time_ms: draft.max_wall_time_ms },
    created_at: at,
  });
  return { ...authorized, declaration, bypasses_admission: false };
}

// The connected authority session — PR B governance review, second pass.
//
// The live adapter is ASYNCHRONOUS and the shell was consuming it
// synchronously: `seedDraft()`, `readCurrentAuthority()` and `scopeCatalogue()`
// were called during render, so against a real endpoint they would have been
// Promise objects. Worse, the transaction payload did
//
//   adapter.readBlocker()?.id
//
// which against a real endpoint resolves to `undefined` — meaning a live
// authorization could have been constructed WITHOUT the exact aggregate
// exception linkage the whole design depends on.
//
// The disconnected screenshot could never expose that, because the shell was
// never mounted with the endpoint client. So the orchestration lives here, in a
// module that can be driven end to end by a test with a fake transport.

/**
 * Hydrate everything the surface needs, once, before rendering.
 *
 * Explicitly NOT opportunistic reads from render. The blocker id in particular
 * is resolved here and then USED from the resolved context, never re-fetched
 * inside a payload expression.
 */
export async function loadAuthorityContext(adapter) {
  // Prefer ONE atomic contextual read. Asking for the current authority with no
  // goal id returned null on the live route, so a refresh made durable
  // authority disappear from the owner-facing screen while it sat safely in
  // storage — the worst possible failure for an authority UI.
  if (typeof adapter.authorityContext === "function") {
    const ctx = await adapter.authorityContext();
    // Every owner-facing read authenticates now, so a refusal here is the
    // honest answer — degrading it into "no originating exception" would tell
    // the surface the wrong thing about why it cannot proceed.
    if (ctx && ctx.ok === false) {
      return { ready: false, failure: ctx.failure, reason: ctx.reason, blocker: null, currentAuthority: null, catalogue: [], suggestions: [], seedDraft: null };
    }
    return {
      ready: true,
      blocker: ctx?.blocker ?? null,
      currentAuthority: ctx?.record ?? null,
      seedDraft: ctx?.draft ?? null,
      catalogue: ctx?.catalogue ?? [],
      suggestions: ctx?.suggestions ?? [],
    };
  }
  const [blocker, currentAuthority, seedDraft, catalogue, suggestions] = await Promise.all([
    Promise.resolve(adapter.readBlocker?.()).then(unwrap("blocker")),
    Promise.resolve(adapter.readCurrentAuthority?.()).then(unwrap("record")),
    Promise.resolve(adapter.seedDraft?.()).then(unwrap("draft")),
    Promise.resolve(adapter.scopeCatalogue?.()).then(unwrap("catalogue")),
    Promise.resolve(adapter.suggestions?.()).then(unwrap("suggestions")),
  ]);
  return {
    ready: true,
    blocker: blocker ?? null,
    currentAuthority: currentAuthority ?? null,
    seedDraft: seedDraft ?? null,
    catalogue: catalogue ?? [],
    suggestions: suggestions ?? [],
  };
}

/**
 * The endpoint replies `{ ok, blocker }` / `{ ok, catalogue }`; the fixture
 * adapter returns the bare value. Both shapes resolve here so the shell sees
 * one shape.
 */
function unwrap(key) {
  return (value) => {
    if (value && typeof value === "object" && "ok" in value && key in value) return value[key];
    return value;
  };
}

/**
 * Authorize, using the ALREADY-RESOLVED blocker id.
 *
 * `context` comes from `loadAuthorityContext`. Passing it in rather than
 * reaching for the adapter again is the point: there is no await inside the
 * payload, so there is no way for the exception linkage to be a pending
 * Promise at the moment the request is built.
 */
/**
 * A unique id for ONE attempt.
 *
 * It carries no authority — the host binds every authoritative field into the
 * receipt — so its only job is to be unique per attempt and stable across a
 * retry of that same attempt.
 *
 * `Date.now()` was not good enough, and the failure was live rather than
 * theoretical: two grants prepared inside the same millisecond produced the
 * same id, and the second REPLAYED the first instead of being evaluated. The
 * test that caught it did so intermittently, which is exactly how a
 * clock-derived identifier fails — it works until the machine is fast enough.
 *
 * Randomness, not time. `randomUUID` where the browser has it, and a
 * random-plus-counter fallback that cannot repeat within a page either.
 */
let attemptCounter = 0;
export function attemptId(prefix) {
  attemptCounter += 1;
  const random = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${attemptCounter}`;
  return `${prefix}:${random}`;
}

export async function authorizeFromContext({ adapter, context, draft, policyIdentity, action }) {
  if (!context?.ready) {
    return {
      ok: false,
      failure: context?.failure ?? "not_hydrated",
      reason: context?.reason ?? "the authority context was never loaded",
    };
  }
  return prepareThenCommit({
    adapter,
    request: { authorization_action: action, draft },
    operationId: attemptId("auth"),
  });
}

/**
 * Narrow or revoke through the privileged transaction.
 *
 * Same two steps as a grant. The lineage is NOT sent: the host knows which
 * authority the domain is on, and a browser that could name a goal id could
 * name someone else's.
 */
export async function amendAuthority({ adapter, goalId, expectedRevision, action, scopeRefs = null }) {
  return prepareThenCommit({
    adapter,
    request: {
      authorization_action: action,
      ...(scopeRefs ? { scope_refs: scopeRefs } : {}),
    },
    operationId: attemptId(`amend:${action}`),
  });
}

/**
 * PREPARE, then COMMIT. One shape for every mutation.
 *
 * The old orchestration sent the draft, the policy identity, the goal id, the
 * expected revision and the resulting scope in a single `authorize` call — the
 * exact fields the host now refuses by name. So the visible Authorize, Narrow
 * and Revoke controls could not have used the secured transaction at all.
 *
 * Returning the PREPARED review rather than committing immediately is the other
 * half: she has to see what the host normalized before anything asks her to
 * verify. `commitPrepared` is what the confirm button calls.
 */
export async function prepareThenCommit({ adapter, request, operationId }) {
  const prepared = await adapter.prepareAuthority(request);
  if (!prepared?.ok) {
    return prepared ?? { ok: false, failure: "transaction_failed", reason: "no response" };
  }
  if (!prepared.prompt_preview) {
    // The surface refuses to draw a review without the host's own prompt text,
    // and refusing here too means the failure is named at the boundary that
    // produced it rather than surfacing as a blank panel.
    return {
      ok: false, failure: "no_prompt_preview",
      reason: "the host prepared a review but did not say what Windows will ask",
    };
  }
  return { ok: true, prepared: { ...prepared, operation_id: operationId } };
}

/** The confirm button. Two opaque strings, and a fresh verification. */
export async function commitPrepared({ adapter, prepared }) {
  if (!prepared?.preview_receipt || !prepared?.operation_id) {
    return { ok: false, failure: "not_prepared", reason: "there is no prepared review to confirm" };
  }
  const result = await adapter.commitAuthority({
    operationId: prepared.operation_id,
    previewReceipt: prepared.preview_receipt,
  });
  if (!result?.ok) return result ?? { ok: false, failure: "transaction_failed", reason: "no response" };

  // Read the PERSISTED state back rather than assuming the commit succeeded.
  //
  // The goal id comes from the COMMIT RESULT, never from the browser: the
  // domain-derived host needs no argument at all, while the in-process endpoint
  // is indexed by goal. Passing back what the host just told us keeps one call
  // correct for both without the page ever choosing a lineage.
  const readback = await adapter.readCurrentAuthority(result.goal_id);
  const persisted = unwrap("record")(unwrap("current")(readback));
  return { ...result, persisted };
}

/**
 * Does an edit invalidate a prepared review?
 *
 * ANY authoritative input. Not "the ones we think matter" — the host decides
 * what is authoritative, and a browser guessing at that list will guess wrong
 * exactly once.
 *
 * This exists so the UI drops the prepared state itself rather than letting her
 * press confirm on a review that no longer matches what is on screen and
 * waiting for the host to reject the stale receipt. The host WILL reject it;
 * that is a safety net, not an interaction.
 */
export const AUTHORITATIVE_INPUTS = [
  "statement", "kind", "scope_refs", "scope_label", "allowed_capabilities",
  "stop_conditions", "max_cost", "max_wall_time_ms", "success_condition",
  // A bounded canary IS its operation. Leaving this out meant swapping
  // run_verification for prepare_patch kept a prepared review live.
  "operation",
  "authorization_action",
];

export function invalidatesPreparedReview(before, after) {
  if (!before || !after) return true;
  for (const field of AUTHORITATIVE_INPUTS) {
    const a = before[field];
    const b = after[field];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a ?? []) !== JSON.stringify(b ?? [])) return true;
    } else if ((a ?? null) !== (b ?? null)) {
      return true;
    }
  }
  return false;
}

/**
 * Which management controls may the live route show?
 *
 * Pause has no persistence in V6.1.5, so the live route HIDES it rather than
 * offering a control that would only pretend. The fixture route may simulate
 * all three, because everything there is openly a simulation.
 */
export function availableControls({ canWrite, pausePersisted = false, widenSupported = false }) {
  return {
    pause: canWrite ? pausePersisted : true,
    // "Change what it may do" re-enters the authoring flow and ends in
    // authorize_goal, whose grant path creates revision 1 — a second rev1 on
    // the same lineage, not an edit of it. Until an explicit widen transaction
    // exists it is hidden on the live route rather than shipped broken.
    widen: canWrite ? widenSupported : true,
    // Narrowing is safer than widening and is still an authority revision, so
    // it goes through a preview and an explicit confirmation.
    narrow: true,
    narrow_requires_preview: true,
    revoke: true,
    revoke_requires_confirmation: true,
    simulated: !canWrite,
  };
}

/** The copy shown before a revoke. Stated once, so both routes say the same thing. */
export const REVOKE_CONFIRMATION = {
  question: "Stop autonomous work under this goal?",
  detail: "No new work will start, and running work stops at its next safe checkpoint.",
};

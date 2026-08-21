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
export async function authorizeFromContext({ adapter, context, draft, policyIdentity, action }) {
  if (!context?.ready) return { ok: false, failure: "not_hydrated", reason: "the authority context was never loaded" };
  const request = {
    operation_id: `auth:${draft.draft_id}:${policyIdentity}`,
    authorization_action: action,
    draft,
    policy_identity: policyIdentity,
    // The exact aggregate exception, resolved during hydration.
    source_exception_id: context.blocker?.id ?? null,
  };
  if (!request.source_exception_id) {
    // Better to refuse than to authorize without the linkage the design
    // depends on — a grant that resolves nothing leaves her blocker open
    // forever with authority sitting silently behind it.
    return { ok: false, failure: "transaction_failed", reason: "no originating exception was resolved during hydration" };
  }
  const result = await adapter.authorize(request);
  if (!result?.ok) return result ?? { ok: false, failure: "transaction_failed", reason: "no response" };

  // Read the PERSISTED state back rather than assuming the draft succeeded.
  const persisted = unwrap("record")(await adapter.readCurrentAuthority(result.goal_id));
  return { ...result, persisted };
}

/**
 * Narrow or revoke through the privileged transaction.
 *
 * The management screen previously bound these to `setNarrowed(true)` /
 * `setRevoked(true)`, which on a live route would have shown an authority
 * change that never happened. A displayed live control cannot be a simulation.
 */
export async function amendAuthority({ adapter, goalId, expectedRevision, action, scopeRefs = null }) {
  const result = await adapter.authorize({
    operation_id: `amend:${goalId}:${action}:${expectedRevision}`,
    authorization_action: action,
    goal_id: goalId,
    expected_authority_revision: expectedRevision,
    ...(scopeRefs ? { scope_refs: scopeRefs } : {}),
  });
  if (!result?.ok) return result ?? { ok: false, failure: "transaction_failed", reason: "no response" };
  const persisted = unwrap("record")(await adapter.readCurrentAuthority(goalId));
  return { ...result, persisted };
}

/**
 * Which management controls may the live route show?
 *
 * Pause has no persistence in V6.1.5, so the live route HIDES it rather than
 * offering a control that would only pretend. The fixture route may simulate
 * all three, because everything there is openly a simulation.
 */
export function availableControls({ canWrite, pausePersisted = false }) {
  return {
    pause: canWrite ? pausePersisted : true,
    narrow: true,
    revoke: true,
    simulated: !canWrite,
  };
}

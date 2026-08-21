import test from "node:test";
import assert from "node:assert/strict";
import {
  amendAuthority, authorizeFromContext, availableControls, loadAuthorityContext,
} from "../src/continuity/control/authority-session.js";
import { createAuthorityEndpointClient } from "../src/continuity/control/authority-endpoint-client.js";
import { createAuthorityEndpoint } from "../src/continuity/control/authority-endpoint.js";
import { createFixtureAuthorityAdapter } from "../src/continuity/control/authority-fixture-adapter.js";
import { createAuthorityDraft, policyIdentityOf } from "../src/continuity/control/authority-draft.js";
import { SCOPE_CATALOGUE, fixtureStates } from "../src/continuity/control/authority-fixture.js";

const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";
const AT = Date.parse("2026-08-22T09:00:00+10:00");
const DRAFT = fixtureStates().F3_authorized_goal.draft;

/**
 * A CONNECTED world: the real browser client talking to the real privileged
 * endpoint over a fake transport.
 *
 * This is the path a static import check cannot prove. The previous build read
 * the async adapter synchronously during render and pulled the blocker id out
 * of a pending Promise inside the transaction payload — a defect no screenshot
 * could expose, because the shell was never mounted against an endpoint.
 */
function connected({ role = "owner" } = {}) {
  const resolvedBy = new Map();
  const audits = [];
  const endpoint = createAuthorityEndpoint({
    authenticateCaller: () => (role ? { role, id: "fake-owner" } : null),
    exceptions: {
      resolve(id, meta) {
        if (id !== BLOCKER) return { ok: false, reason: "refusing a different exception" };
        const existing = resolvedBy.get(id);
        if (existing && existing !== meta?.ruling_ref) return { ok: false, resolved_by: existing };
        resolvedBy.set(id, meta?.ruling_ref ?? "unknown");
        return { ok: true, resolved_by: meta?.ruling_ref ?? "unknown" };
      },
      isResolved: (id) => resolvedBy.has(id),
    },
    now: () => AT,
    shadowAudit: (req) => { audits.push(req); return { ok: true, audit_ref: "shadow-1" }; },
    readContext: {
      blocker: () => ({ id: BLOCKER, title: "V6 execution authority" }),
      catalogue: () => SCOPE_CATALOGUE,
      suggestions: () => [{ starting_text: "Keep the surfaces working.", source_ref: "brief-1", pre_authorized: false, capabilities_prechecked: [] }],
      draft: () => null,
    },
  });

  const seen = [];
  // A fake HTTP transport. Async on purpose — that asynchrony is the thing
  // under test.
  const transport = async (url, init) => {
    const op = url.split("/").pop();
    const parsed = JSON.parse(init.body);
    seen.push({ op, body: parsed });
    const result = endpoint.handle(op, parsed);
    return { ok: true, json: async () => result };
  };

  return { client: createAuthorityEndpointClient({ endpoint: "/x", transport }), endpoint, resolvedBy, audits, seen };
}

// ---- the connected shell hydrates before it can be used ------------------------

test("V6.1.5B connected: hydration resolves every async read", async () => {
  const { client } = connected();
  const context = await loadAuthorityContext(client);

  assert.equal(context.ready, true);
  // Each of these was a Promise object in the previous build.
  assert.equal(context.blocker.id, BLOCKER);
  assert.equal(Array.isArray(context.catalogue), true);
  assert.ok(context.catalogue.length > 0);
  assert.equal(Array.isArray(context.suggestions), true);
  assert.equal(context.currentAuthority, null, "no authority exists yet");

  // The fixture adapter is synchronous and must hydrate through the same path.
  const fixture = await loadAuthorityContext(createFixtureAuthorityAdapter({ state: "F3" }));
  assert.equal(fixture.ready, true);
  assert.ok(fixture.catalogue.length > 0);
  assert.equal(fixture.currentAuthority.state, "authorized");
});

test("V6.1.5B connected: the exact blocker id reaches the grant transaction", async () => {
  const { client, resolvedBy, seen } = connected();
  const context = await loadAuthorityContext(client);

  const result = await authorizeFromContext({
    adapter: client, context, draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });

  assert.equal(result.ok, true);
  const sent = seen.find((s) => s.op === "authorize");
  assert.equal(sent.body.source_exception_id, BLOCKER,
    "the previous build sent undefined here, from a pending Promise");
  assert.equal(resolvedBy.get(BLOCKER), result.persisted.ruling.ref);
  // And the management state comes from the backend, not the draft.
  assert.equal(result.persisted.revision, 1);
  assert.deepEqual(result.persisted.scope_refs, DRAFT.scope_refs);
});

test("V6.1.5B connected: an unhydrated context refuses to authorize", async () => {
  const { client, resolvedBy } = connected();
  const result = await authorizeFromContext({
    adapter: client, context: null, draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "not_hydrated");
  assert.equal(resolvedBy.size, 0);

  // And a hydrated context with no blocker refuses too, rather than granting
  // authority that resolves nothing.
  const noBlocker = await authorizeFromContext({
    adapter: client, context: { ready: true, blocker: null }, draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });
  assert.equal(noBlocker.ok, false);
  assert.match(noBlocker.reason, /no originating exception/);
  assert.equal(resolvedBy.size, 0);
});

// ---- live management controls are real transactions ---------------------------

test("V6.1.5B connected: narrow and revoke are persisted, not simulated", async () => {
  const { client, endpoint } = connected();
  const context = await loadAuthorityContext(client);
  const granted = await authorizeFromContext({
    adapter: client, context, draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });

  const narrowed = await amendAuthority({
    adapter: client, goalId: granted.goal_id, expectedRevision: 1,
    action: "narrow_authority", scopeRefs: ["semantic-centre:continuity"],
  });
  assert.equal(narrowed.ok, true);
  assert.equal(narrowed.persisted.revision, 2);
  assert.equal(endpoint.handle("current", { goal_id: granted.goal_id }).state, "narrowed",
    "the backend must agree with the screen");

  const revoked = await amendAuthority({
    adapter: client, goalId: granted.goal_id, expectedRevision: 2, action: "revoke_authority",
  });
  assert.equal(revoked.persisted.revision, 3);
  assert.equal(endpoint.handle("current", { goal_id: granted.goal_id }).state, "revoked");
});

test("V6.1.5B connected: a stale management revision is refused, not applied", async () => {
  const { client, endpoint } = connected();
  const context = await loadAuthorityContext(client);
  const granted = await authorizeFromContext({
    adapter: client, context, draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });
  await amendAuthority({
    adapter: client, goalId: granted.goal_id, expectedRevision: 1,
    action: "narrow_authority", scopeRefs: ["semantic-centre:continuity"],
  });

  const staleTab = await amendAuthority({
    adapter: client, goalId: granted.goal_id, expectedRevision: 1, action: "revoke_authority",
  });
  assert.equal(staleTab.ok, false);
  assert.equal(staleTab.failure, "stale_revision");
  assert.equal(endpoint.handle("current", { goal_id: granted.goal_id }).state, "narrowed",
    "the stale intent must not land on the newer revision");
});

test("V6.1.5B connected: the live route hides pause until it is genuinely backed", () => {
  assert.equal(availableControls({ canWrite: true, pausePersisted: false }).pause, false,
    "a displayed live control cannot be a simulation");
  assert.equal(availableControls({ canWrite: true, pausePersisted: true }).pause, true);
  // The fixture route may simulate all three, because everything there is
  // openly a simulation.
  const review = availableControls({ canWrite: false });
  assert.equal(review.pause, true);
  assert.equal(review.simulated, true);
});

// ---- the canary path, from a blank editor -------------------------------------

test("V6.1.5B connected: a blank-editor canary authorizes end to end", async () => {
  const { client, audits, resolvedBy } = connected();
  const context = await loadAuthorityContext(client);

  // Built from what the owner typed, not from fixture F5.
  const typed = {
    ...createAuthorityDraft({
      draft_id: "typed-canary", kind: "bounded_canary",
      statement: "Verify the deployed briefing surface at the current head",
      scope_refs: ["repo:in-c0/datascape", "semantic-centre:continuity"],
      scope_label: "DataScape / Continuity",
      allowed_capabilities: ["inspect_repository", "run_verification"],
    }),
    operation: "run_verification",
    success_condition: "the briefing surface renders with zero console errors",
  };

  const result = await authorizeFromContext({
    adapter: client, context, draft: typed,
    policyIdentity: policyIdentityOf(typed), action: "authorize_bounded_task",
  });

  assert.equal(result.ok, true);
  assert.ok(result.persisted.declaration, "a bounded task must produce a work declaration");
  assert.equal(result.persisted.declaration.operation, "run_verification");
  assert.equal(result.persisted.declaration.success_condition, typed.success_condition);
  assert.equal(resolvedBy.get(BLOCKER), result.persisted.ruling.ref);
  // It enters the shadow audit and explicitly does not execute.
  assert.equal(audits.length, 1);
  assert.equal(audits[0].executes, false);
  assert.equal(audits[0].dispatches, false);
});

// ---- the canary consent fields are covered by the policy identity -------------

test("V6.1.5B connected: changing only the success condition invalidates the preview", async () => {
  const { client, resolvedBy } = connected();
  const context = await loadAuthorityContext(client);
  const canary = {
    ...createAuthorityDraft({
      draft_id: "c", kind: "bounded_canary", statement: "Verify the deployed surface",
      scope_refs: ["repo:in-c0/datascape", "semantic-centre:continuity"],
      allowed_capabilities: ["run_verification"],
    }),
    operation: "run_verification",
    success_condition: "the briefing surface renders with zero console errors",
  };
  const reviewed = policyIdentityOf(canary);

  // The exact substitution the review named: a weaker success condition,
  // authorized against the identity the owner actually read.
  const weakened = { ...canary, success_condition: "the page opened once" };
  const result = await authorizeFromContext({
    adapter: client, context, draft: weakened, policyIdentity: reviewed, action: "authorize_bounded_task",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "stale_preview");
  assert.equal(resolvedBy.size, 0);

  // And the operation alone.
  const swapped = { ...canary, operation: "prepare_patch" };
  const opResult = await authorizeFromContext({
    adapter: client, context, draft: swapped, policyIdentity: reviewed, action: "authorize_bounded_task",
  });
  assert.equal(opResult.failure, "stale_preview");

  // The positive control: the reviewed draft still authorizes.
  assert.equal((await authorizeFromContext({
    adapter: client, context, draft: canary, policyIdentity: reviewed, action: "authorize_bounded_task",
  })).ok, true);
});

// ---- an unauthenticated connected caller ---------------------------------------

test("V6.1.5B connected: an agent session cannot authorize through the transport", async () => {
  const { client, resolvedBy } = connected({ role: "agent" });
  const context = await loadAuthorityContext(client);
  const result = await authorizeFromContext({
    adapter: client, context, draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "not_owner");
  assert.equal(resolvedBy.size, 0);
});

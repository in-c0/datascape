import test from "node:test";
import assert from "node:assert/strict";
import { REVOKE_CONFIRMATION, amendAuthority, authorizeFromContext, availableControls, loadAuthorityContext } from "../src/continuity/control/authority-session.js";
import { createAuthorityEndpointClient } from "../src/continuity/control/authority-endpoint-client.js";
import { createAuthorityEndpoint } from "../src/continuity/control/authority-endpoint.js";
import { createMemoryStorage } from "../src/continuity/control/authority-journal.js";
import { composeEnvelope, createAuthorityDraft, normalizeDraft, policyIdentityOf, renderPreview } from "../src/continuity/control/authority-draft.js";
import { SCOPE_CATALOGUE, fixtureStates } from "../src/continuity/control/authority-fixture.js";

const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";
const AT = Date.parse("2026-08-22T09:00:00+10:00");
const DRAFT = fixtureStates().F3_authorized_goal.draft;

/**
 * A world that can restart the BACKEND and reload the BROWSER independently.
 *
 * The reload is what matters here: a fresh client with no goal id, hydrating
 * from scratch, exactly as a refresh would.
 */
function world() {
  const storage = createMemoryStorage();
  const resolvedBy = new Map();
  const exceptions = {
    resolve(id, meta) {
      if (id !== BLOCKER) return { ok: false, reason: "refusing a different exception" };
      const existing = resolvedBy.get(id);
      if (existing && existing !== meta?.ruling_ref) return { ok: false, resolved_by: existing };
      resolvedBy.set(id, meta?.ruling_ref ?? "unknown");
      return { ok: true, resolved_by: meta?.ruling_ref ?? "unknown" };
    },
    isResolved: (id) => resolvedBy.has(id),
  };
  const buildEndpoint = () => createAuthorityEndpoint({
    authenticateCaller: () => ({ role: "owner", id: "fake-owner" }),
    exceptions, now: () => AT, storage,
    readContext: {
      // The blocker DISAPPEARS from the open list once resolved — which is why
      // "find the open blocker, then find its goal" cannot work, and why the
      // domain is carried separately.
      blocker: () => (resolvedBy.has(BLOCKER) ? null : { id: BLOCKER, title: "V6 execution authority" }),
      domain: () => BLOCKER,
      catalogue: () => SCOPE_CATALOGUE,
      suggestions: () => [],
      draft: () => null,
    },
  });
  let endpoint = buildEndpoint();
  const newBrowser = () => createAuthorityEndpointClient({
    endpoint: "/x",
    transport: async (url, init) => {
      const op = url.split("/").pop();
      return { ok: true, json: async () => endpoint.handle(op, JSON.parse(init.body)) };
    },
  });
  return {
    newBrowser,
    restartBackend() { endpoint = buildEndpoint(); },
    get endpoint() { return endpoint; },
    resolvedBy,
  };
}

// ---- P0-1: authority must be rediscoverable after a reload --------------------

test("V6.1.5B rediscovery: authority survives a browser reload", async () => {
  const w = world();
  const first = w.newBrowser();
  const granted = await authorizeFromContext({
    adapter: first, context: await loadAuthorityContext(first), draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });
  assert.equal(granted.ok, true);

  // A refresh: brand-new client, no goal id anywhere, and the blocker it came
  // from is now resolved and gone from the open list.
  const reloaded = await loadAuthorityContext(w.newBrowser());
  assert.equal(reloaded.blocker, null, "the originating blocker is resolved");
  assert.ok(reloaded.currentAuthority, "durable authority must not vanish from the owner-facing route");
  assert.equal(reloaded.currentAuthority.revision, 1);
  assert.deepEqual(reloaded.currentAuthority.scope_refs, DRAFT.scope_refs);
});

test("V6.1.5B rediscovery: narrowed and revoked revisions survive reload and restart", async () => {
  const w = world();
  const browser = w.newBrowser();
  const granted = await authorizeFromContext({
    adapter: browser, context: await loadAuthorityContext(browser), draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });

  await amendAuthority({
    adapter: browser, goalId: granted.goal_id, expectedRevision: 1,
    action: "narrow_authority", scopeRefs: ["semantic-centre:continuity"],
  });
  w.restartBackend();
  const afterNarrow = await loadAuthorityContext(w.newBrowser());
  assert.equal(afterNarrow.currentAuthority.revision, 2);
  assert.equal(afterNarrow.currentAuthority.state, "narrowed");
  assert.deepEqual(afterNarrow.currentAuthority.scope_refs, ["semantic-centre:continuity"]);

  await amendAuthority({
    adapter: w.newBrowser(), goalId: granted.goal_id, expectedRevision: 2, action: "revoke_authority",
  });
  w.restartBackend();
  const afterRevoke = await loadAuthorityContext(w.newBrowser());
  assert.equal(afterRevoke.currentAuthority.revision, 3);
  assert.equal(afterRevoke.currentAuthority.state, "revoked");
});

test("V6.1.5B rediscovery: the browser is never taught a goal id", async () => {
  const w = world();
  const sent = [];
  const client = createAuthorityEndpointClient({
    endpoint: "/x",
    transport: async (url, init) => {
      sent.push({ op: url.split("/").pop(), body: JSON.parse(init.body) });
      return { ok: true, json: async () => w.endpoint.handle(url.split("/").pop(), JSON.parse(init.body)) };
    },
  });
  await loadAuthorityContext(client);
  assert.deepEqual(sent.map((s) => s.op), ["context"], "one atomic contextual read");
  assert.deepEqual(sent[0].body, {}, "and it carries no identifiers at all");
});

// ---- P0-2: the preview and the identity are one object -----------------------

test("V6.1.5B preview: the rendered preview is derived from the hashed object", () => {
  const canary = {
    ...createAuthorityDraft({
      draft_id: "c", kind: "bounded_canary", statement: "Verify the deployed surface",
      scope_refs: ["repo:in-c0/datascape", "semantic-centre:continuity"],
      scope_label: "DataScape / Continuity",
      allowed_capabilities: ["run_verification"],
    }),
    operation: "run_verification",
    success_condition: "the briefing surface renders with zero console errors",
  };
  const preview = renderPreview(canary, composeEnvelope(canary.allowed_capabilities));

  // The canary consent fields are legible on the screen that authorizes them.
  assert.equal(preview.is_bounded_task, true);
  assert.equal(preview.done_when, canary.success_condition);
  assert.equal(preview.operation, "run_verification");
  // And the preview carries the exact value the identity is computed over.
  assert.deepEqual(preview.normalized, normalizeDraft(canary));
});

test("V6.1.5B preview: changing a hashed field changes the preview too", () => {
  const base = {
    ...createAuthorityDraft({
      draft_id: "c", kind: "bounded_canary", statement: "Verify the deployed surface",
      scope_refs: ["repo:in-c0/datascape"], allowed_capabilities: ["run_verification"],
    }),
    operation: "run_verification",
    success_condition: "the briefing surface renders with zero console errors",
  };
  const envelope = composeEnvelope(base.allowed_capabilities);
  const render = (d) => renderPreview(d, envelope);

  // No divergence is permitted in either direction: a field that changes the
  // hash must change what she reads, and vice versa.
  const weakened = { ...base, success_condition: "the page opened once" };
  assert.notEqual(policyIdentityOf(weakened), policyIdentityOf(base));
  assert.notEqual(render(weakened).done_when, render(base).done_when);

  const swapped = { ...base, operation: "prepare_patch" };
  assert.notEqual(policyIdentityOf(swapped), policyIdentityOf(base));
  assert.notEqual(render(swapped).operation, render(base).operation);

  // A field that changes NEITHER leaves both alone.
  const relabelled = { ...base, draft_id: "different-id" };
  assert.equal(policyIdentityOf(relabelled), policyIdentityOf(base));
  assert.deepEqual(render(relabelled).normalized, render(base).normalized);
});

// ---- P0-3: management semantics ------------------------------------------------

test("V6.1.5B management: widening is hidden live until it has a real transaction", () => {
  const live = availableControls({ canWrite: true });
  assert.equal(live.widen, false, "a grant would start a second revision 1 on the same lineage");
  assert.equal(live.pause, false, "pause has no persistence yet");
  assert.equal(live.narrow_requires_preview, true);
  assert.equal(live.revoke_requires_confirmation, true);

  // The fixture route may keep demonstrating all of it.
  const review = availableControls({ canWrite: false });
  assert.equal(review.widen, true);
  assert.equal(review.pause, true);
  assert.equal(review.simulated, true);

  // And widening becomes available once a real transaction backs it.
  assert.equal(availableControls({ canWrite: true, widenSupported: true }).widen, true);
});

test("V6.1.5B management: the revoke confirmation says what stopping means", () => {
  assert.match(REVOKE_CONFIRMATION.question, /Stop autonomous work under this goal\?/);
  assert.match(REVOKE_CONFIRMATION.detail, /No new work will start/);
  // Checkpoint-bound, not "will finish the job".
  assert.match(REVOKE_CONFIRMATION.detail, /next safe checkpoint/);
});

test("V6.1.5B management: a grant on an existing lineage is not an edit", async () => {
  // The defect behind hiding "Change what it may do": re-entering the authoring
  // flow ends in authorize_goal, whose grant path builds revision 1 again.
  const w = world();
  const browser = w.newBrowser();
  const context = await loadAuthorityContext(browser);
  const granted = await authorizeFromContext({
    adapter: browser, context, draft: DRAFT,
    policyIdentity: policyIdentityOf(DRAFT), action: "authorize_goal",
  });
  assert.equal(granted.revision, 1);

  const widened = { ...DRAFT, allowed_capabilities: [...DRAFT.allowed_capabilities] };
  const second = await authorizeFromContext({
    adapter: w.newBrowser(), context, draft: widened,
    policyIdentity: policyIdentityOf(widened), action: "authorize_goal",
  });
  // Replayed as the same operation rather than creating a rival revision 1 —
  // and either way it is not an edit of revision 1, which is why the control is
  // hidden rather than wired.
  assert.equal(second.revision, 1);
  assert.equal(w.endpoint.history(granted.goal_id).length, 1, "no second lineage may appear");
});

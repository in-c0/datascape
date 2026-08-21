import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  NON_AUTHORITATIVE_ACTIONS, createAuthorityEndpoint, isAuthorizationAction,
} from "../src/continuity/control/authority-endpoint.js";
import { SPOOFABLE_FIELDS, sanitizeClientRequest } from "../src/continuity/control/authority-request.js";
import { createAuthorityEndpointClient } from "../src/continuity/control/authority-endpoint-client.js";
import { createFixtureAuthorityAdapter } from "../src/continuity/control/authority-fixture-adapter.js";
import { importGraph, reachableModules, reachesAny } from "../src/continuity/control/import-audit.js";
import { policyIdentityOf } from "../src/continuity/control/authority-draft.js";
import { fixtureStates } from "../src/continuity/control/authority-fixture.js";

const SRC = path.resolve("src/continuity");
const DRAFT = fixtureStates().F3_authorized_goal.draft;
const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";
const WRITERS = ["control/authority-store.js", "control/authority-journal.js", "control/authority-endpoint.js"];

function harness({ role = "owner", shadowAudit } = {}) {
  let principal = role ? { role, id: "fake" } : null;
  const resolved = new Set();
  const endpoint = createAuthorityEndpoint({
    authenticateCaller: () => principal,
    exceptions: {
      resolve(id) {
        if (id !== BLOCKER) return { ok: false, reason: "refusing a different exception" };
        resolved.add(id);
        return { ok: true };
      },
      isResolved: (id) => resolved.has(id),
    },
    now: () => Date.parse("2026-08-22T09:00:00+10:00"),
    shadowAudit,
  });
  return { endpoint, resolved, setPrincipal: (p) => { principal = p; } };
}

const body = (over = {}) => ({
  operation_id: "op-1",
  authorization_action: "authorize_goal",
  draft: DRAFT,
  policy_identity: policyIdentityOf(DRAFT),
  source_exception_id: BLOCKER,
  ...over,
});

// ---- P0-1: the boundary is not browser-supplied --------------------------------

test("V6.1.5B: no browser route can reach an authority writer", () => {
  const review = importGraph(path.join(SRC, "ReviewAuthorityView.jsx"));
  const live = importGraph(path.join(SRC, "LiveAuthorityView.jsx"));
  const shell = importGraph(path.join(SRC, "AuthorityShell.jsx"));

  for (const [name, graph] of [["review", review], ["live", live], ["shell", shell]]) {
    assert.equal(reachesAny(graph, WRITERS), false,
      `${name} must reach no writer; found ${reachableModules(graph, WRITERS).join(", ")}`);
  }

  // The POSITIVE control for the audit itself: it must be able to SEE a writer,
  // or every assertion above would be passing over an empty question.
  const privileged = importGraph(path.join(SRC, "control/authority-endpoint.js"));
  assert.equal(reachesAny(privileged, ["control/authority-store.js"]), true,
    "the privileged endpoint must structurally contain the store");

  // And the live route reaches the transport, so it is bound to something.
  assert.equal(reachesAny(live, ["control/authority-endpoint-client.js"]), true);
  // The review route must not even reach the transport.
  assert.equal(reachesAny(review, ["control/authority-endpoint-client.js"]), false);
});

test("V6.1.5B: the page half of the boundary holds no authenticator", () => {
  const client = createAuthorityEndpointClient({ transport: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
  assert.equal(client.holdsAuthenticator, false);
  for (const forbidden of ["authenticate", "principal", "session", "store", "commit"]) {
    assert.equal(typeof client[forbidden], "undefined", `${forbidden} must not exist on the endpoint client`);
  }
  // It cannot be constructed without a transport, and a transport is not an
  // identity.
  assert.throws(() => createAuthorityEndpointClient({ transport: null }), /requires a transport/);
});

test("V6.1.5B: the review adapter has no mutation method at all", () => {
  const adapter = createFixtureAuthorityAdapter();
  assert.equal(adapter.canWriteAuthority, false);
  for (const forbidden of ["authorize", "narrow", "revoke", "commit", "write", "mutate"]) {
    assert.equal(typeof adapter[forbidden], "undefined", `${forbidden} must not exist on the review adapter`);
  }
  // `simulate` exists and is deliberately not named like a transaction.
  assert.equal(typeof adapter.simulate, "function");
});

// ---- P0-2: fixture controls belong to the review route only --------------------

test("V6.1.5B: the shell interprets no fixture URL controls", () => {
  const source = importGraph(path.join(SRC, "AuthorityShell.jsx"));
  assert.equal(reachesAny(source, ["control/authority-fixture.js"]), false,
    "the shell must not import fixtures");

  // The review adapter owns ?state, and produces different starting states.
  assert.equal(createFixtureAuthorityAdapter({ state: "F1" }).initialStep(), "choose");
  assert.equal(createFixtureAuthorityAdapter({ state: "F2" }).initialStep(), "goal");
  assert.equal(createFixtureAuthorityAdapter({ state: "F3" }).initialStep(), "authorized");
  assert.equal(createFixtureAuthorityAdapter({ state: "F4" }).initialPath(), "canary");
  assert.equal(createFixtureAuthorityAdapter({ state: "F1" }).readCurrentAuthority(), null);
});

// ---- §2: identity never comes from the payload --------------------------------

test("V6.1.5B: a payload claiming owner is refused when the caller is an agent", () => {
  const { endpoint } = harness({ role: "agent" });
  const result = endpoint.handle("authorize", {
    ...body(), actor: "owner", role: "admin", isOwner: true, authorizedBy: "agent",
    credentials: "forged", session: { currentPrincipal: () => ({ role: "owner" }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "not_owner");
  // A supplied session object is stripped like any other identity claim — this
  // is the exact hole the governance review found.
  assert.ok(result.stripped_identity_fields.includes("session"));
  assert.ok(result.stripped_identity_fields.includes("actor"));
});

test("V6.1.5B: every identity-shaped field is removed from a payload", () => {
  const dirty = Object.fromEntries(SPOOFABLE_FIELDS.map((f) => [f, "owner"]));
  const { request, stripped_identity_fields } = sanitizeClientRequest({ ...body(), ...dirty });
  for (const field of SPOOFABLE_FIELDS) {
    assert.equal(request[field], undefined, `${field} must not survive sanitization`);
  }
  assert.equal(stripped_identity_fields.length, SPOOFABLE_FIELDS.length);
  assert.equal(request.operation_id, "op-1");
});

test("V6.1.5B: an unauthenticated caller cannot authorize", () => {
  const { endpoint } = harness({ role: null });
  assert.equal(endpoint.handle("authorize", body()).failure, "not_authenticated");
});

// ---- §14: ordinary interaction is not authorization ---------------------------

test("V6.1.5B: an owner session does not make ordinary actions authoritative", () => {
  const { endpoint, resolved } = harness();
  for (const action of NON_AUTHORITATIVE_ACTIONS) {
    assert.equal(isAuthorizationAction(action), false, `${action} is not an authorization`);
    const result = endpoint.handle("authorize", body({ operation_id: `op-${action}`, authorization_action: action }));
    assert.equal(result.ok, false, `${action} must not create authority`);
  }
  assert.equal(resolved.size, 0);

  // The positive control.
  assert.equal(endpoint.handle("authorize", body()).ok, true);
  assert.equal(resolved.size, 1);
});

// ---- §4, §6, §7: preview, retry, exception linkage ----------------------------

test("V6.1.5B: a preview identity from before an edit is refused", () => {
  const { endpoint, resolved } = harness();
  const widened = { ...DRAFT, scope_refs: [...DRAFT.scope_refs, "repo:in-c0/sumzup"] };
  const result = endpoint.handle("authorize", body({ draft: widened, policy_identity: policyIdentityOf(DRAFT) }));

  assert.equal(result.ok, false);
  assert.equal(result.failure, "stale_preview");
  assert.equal(resolved.size, 0, "the blocker must remain open");
});

test("V6.1.5B: a lost response replays the original committed transaction", () => {
  const { endpoint, resolved } = harness();
  const first = endpoint.handle("authorize", body());
  assert.equal(first.replayed, false);

  const retry = endpoint.handle("authorize", body());
  assert.equal(retry.ok, true);
  assert.equal(retry.replayed, true);
  assert.equal(retry.goal_id, first.goal_id);
  assert.equal(endpoint.history(first.goal_id).length, 1, "one ruling");
  assert.equal(resolved.size, 1, "one exception resolution");
});

test("V6.1.5B: only the originating exception may be resolved", () => {
  const { endpoint, resolved } = harness();
  const wrong = endpoint.handle("authorize", body({ source_exception_id: "2026-08-17-sumzup-digest-budget-1747" }));
  assert.equal(wrong.ok, false);
  assert.equal(resolved.size, 0, "no fuzzy lookup by loop, title or prose");
});

// ---- §8, §11, §12: management reads persisted state ---------------------------

test("V6.1.5B: management reads the persisted record, not the draft", () => {
  const { endpoint } = harness();
  const granted = endpoint.handle("authorize", body());
  const read = endpoint.handle("current", { goal_id: granted.goal_id });

  assert.equal(read.fixture, false);
  assert.equal(read.revision, 1);
  assert.deepEqual(read.record.scope_refs, DRAFT.scope_refs, "scope refs round-trip exactly");
  assert.equal(read.record.scope_label, "DataScape / Continuity");
});

test("V6.1.5B: a stale management tab cannot reapply its intent onto a newer revision", () => {
  const { endpoint } = harness();
  const granted = endpoint.handle("authorize", body());

  assert.equal(endpoint.handle("authorize", {
    operation_id: "op-b", authorization_action: "narrow_authority",
    goal_id: granted.goal_id, expected_authority_revision: 1, scope_refs: ["semantic-centre:continuity"],
  }).ok, true);

  const staleTab = endpoint.handle("authorize", {
    operation_id: "op-a", authorization_action: "revoke_authority",
    goal_id: granted.goal_id, expected_authority_revision: 1,
  });
  assert.equal(staleTab.ok, false);
  assert.equal(staleTab.failure, "stale_revision");
  assert.equal(endpoint.handle("current", { goal_id: granted.goal_id }).state, "narrowed");
});

// ---- §16: a failed audit does not un-grant authority --------------------------

test("V6.1.5B: a shadow-audit failure never rolls back a committed ruling", () => {
  const { endpoint, resolved } = harness({ shadowAudit: () => { throw new Error("audit backend unavailable"); } });
  const result = endpoint.handle("authorize", body());

  assert.equal(result.ok, true, "the owner's ruling stands");
  assert.equal(result.shadow_audit_failed, true);
  assert.equal(resolved.size, 1, "the exception stays resolved");
  assert.equal(endpoint.handle("current", { goal_id: result.goal_id }).state, "authorized");

  const ok = harness({ shadowAudit: () => ({ ok: true, audit_ref: "shadow-1" }) });
  const good = ok.endpoint.handle("authorize", body());
  assert.equal(good.shadow_audit_failed, false);
  assert.equal(good.shadow_audit.audit_ref, "shadow-1");
});

// ---- §5: no execution surface -------------------------------------------------

test("V6.1.5B: the endpoint exposes no execution surface", () => {
  const { endpoint } = harness();
  for (const forbidden of ["dispatch", "execute", "send", "run", "launch"]) {
    assert.equal(typeof endpoint[forbidden], "undefined", `${forbidden} must not exist on the endpoint`);
  }
  const graph = importGraph(path.join(SRC, "control/authority-endpoint.js"));
  assert.equal(reachesAny(graph, ["control/dispatch.js", "control/simulate.js"]), false,
    "authorization must complete in a build with no execution subsystem");
});

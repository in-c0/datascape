import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  NON_AUTHORITATIVE_ACTIONS, SPOOFABLE_FIELDS, createAuthorityClient,
  isAuthorizationAction, sanitizeClientRequest,
} from "../src/continuity/control/authority-client.js";
import { createFixtureAuthorityAdapter } from "../src/continuity/control/authority-fixture-adapter.js";
import { importGraph, reachableModules, reachesAny } from "../src/continuity/control/import-audit.js";
import { policyIdentity } from "../src/continuity/control/authority-store.js";
import { fixtureStates } from "../src/continuity/control/authority-fixture.js";

const SRC = path.resolve("src/continuity");
const DRAFT = fixtureStates().F3_authorized_goal.draft;
const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";

function harness({ role = "owner", shadowAudit } = {}) {
  let principal = role ? { role, id: "fake" } : null;
  const resolved = [];
  const client = createAuthorityClient({
    session: { currentPrincipal: () => principal },
    exceptions: {
      resolve(id, meta) {
        if (id !== BLOCKER) return { ok: false, reason: "refusing a different exception" };
        resolved.push({ id, ...meta });
        return { ok: true };
      },
    },
    now: () => Date.parse("2026-08-22T09:00:00+10:00"),
    shadowAudit,
  });
  return { client, resolved, setPrincipal: (p) => { principal = p; } };
}

const payload = (over = {}) => ({
  operation_id: "op-1",
  authorization_action: "authorize_goal",
  draft: DRAFT,
  policy_identity: policyIdentity(DRAFT),
  source_exception_id: BLOCKER,
  ...over,
});

// ---- §1, §15: structural route separation -------------------------------------

test("V6.1.5B: the review route cannot import an authority writer", () => {
  const WRITERS = ["control/authority-store.js", "control/authority-client.js"];
  const review = importGraph(path.join(SRC, "ReviewAuthorityView.jsx"));
  const live = importGraph(path.join(SRC, "LiveAuthorityView.jsx"));

  assert.equal(reachesAny(review, WRITERS), false,
    `the review graph must contain no writer; found ${reachableModules(review, WRITERS).join(", ")}`);

  // The POSITIVE control for the audit itself: if the live route did not reach
  // a writer either, the check above would be passing over an empty question.
  assert.equal(reachesAny(live, WRITERS), true, "the live route must structurally contain the writer");

  // And neither route may reach an execution transport.
  assert.equal(reachesAny(live, ["control/dispatch.js", "control/simulate.js"]), false,
    "authorization must complete in a build with no execution subsystem");
});

test("V6.1.5B: the review adapter has no mutation method at all", () => {
  const adapter = createFixtureAuthorityAdapter();
  assert.equal(adapter.canWriteAuthority, false);
  for (const forbidden of ["authorize", "narrow", "revoke", "commit", "write", "mutate"]) {
    assert.equal(typeof adapter[forbidden], "undefined", `${forbidden} must not exist on the review adapter`);
  }
  // Nothing to disable, because nothing is there to be enabled.
  assert.deepEqual(
    Object.keys(adapter).filter((k) => typeof adapter[k] === "function").sort(),
    ["readBlocker", "readCurrentAuthority", "scopeCatalogue", "seedDraft", "suggestions"],
  );
});

// ---- §2: the browser never asserts identity -----------------------------------

test("V6.1.5B: a payload claiming owner is refused when the session is an agent", () => {
  const { client } = harness({ role: "agent" });
  const spoofed = client.authorize({
    ...payload(),
    actor: "owner", role: "admin", isOwner: true, authorizedBy: "agent", credentials: "forged",
  });
  assert.equal(spoofed.ok, false);
  assert.equal(spoofed.failure, "not_owner");
  // Stripped, not merely rejected: later code cannot read what is not there.
  assert.deepEqual(spoofed.stripped_identity_fields.sort(),
    ["actor", "authorizedBy", "credentials", "isOwner", "role"]);
});

test("V6.1.5B: every identity-shaped field is removed from a browser payload", () => {
  const dirty = Object.fromEntries(SPOOFABLE_FIELDS.map((f) => [f, "owner"]));
  const { request, stripped_identity_fields } = sanitizeClientRequest({ ...payload(), ...dirty });
  for (const field of SPOOFABLE_FIELDS) {
    assert.equal(request[field], undefined, `${field} must not survive sanitization`);
  }
  assert.equal(stripped_identity_fields.length, SPOOFABLE_FIELDS.length);
  // The legitimate fields do survive.
  assert.equal(request.policy_identity, payload().policy_identity);
  assert.equal(request.operation_id, "op-1");
});

test("V6.1.5B: an unauthenticated session cannot authorize", () => {
  const { client } = harness({ role: null });
  const result = client.authorize(payload());
  assert.equal(result.ok, false);
  assert.equal(result.failure, "not_authenticated");
});

// ---- §14: ordinary interaction is not authorization ---------------------------

test("V6.1.5B: an owner session does not make ordinary actions authoritative", () => {
  const { client, resolved } = harness();
  for (const action of NON_AUTHORITATIVE_ACTIONS) {
    assert.equal(isAuthorizationAction(action), false, `${action} is not an authorization`);
    const result = client.authorize(payload({ operation_id: `op-${action}`, authorization_action: action }));
    assert.equal(result.ok, false, `${action} must not create authority`);
  }
  assert.equal(resolved.length, 0, "no ordinary interaction may resolve the blocker");

  // The positive control.
  assert.equal(client.authorize(payload()).ok, true);
  assert.equal(resolved.length, 1);
});

// ---- §4, §6, §7: preview, retry, exception linkage ----------------------------

test("V6.1.5B: a preview identity from before an edit is refused", () => {
  const { client, resolved } = harness();
  const widened = { ...DRAFT, scope_refs: [...DRAFT.scope_refs, "repo:in-c0/sumzup"] };
  const result = client.authorize(payload({ draft: widened, policy_identity: policyIdentity(DRAFT) }));

  assert.equal(result.ok, false);
  assert.equal(result.failure, "stale_preview");
  assert.equal(resolved.length, 0, "the blocker must remain open");
});

test("V6.1.5B: a lost response replays the original committed transaction", () => {
  const { client, resolved } = harness();
  const first = client.authorize(payload());
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);

  const retry = client.authorize(payload());
  assert.equal(retry.ok, true);
  assert.equal(retry.replayed, true);
  assert.equal(retry.goal_id, first.goal_id);
  assert.equal(client.history(first.goal_id).length, 1, "one ruling");
  assert.equal(resolved.length, 1, "one exception resolution");
});

test("V6.1.5B: only the originating exception may be resolved", () => {
  const { client, resolved } = harness();
  const wrong = client.authorize(payload({ source_exception_id: "2026-08-17-sumzup-digest-budget-1747" }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.failure, "transaction_failed");
  assert.equal(resolved.length, 0, "no fuzzy lookup by loop, title or prose");
});

// ---- §8, §11, §12: management reads persisted state ---------------------------

test("V6.1.5B: management reads the persisted record, not the draft", () => {
  const { client } = harness();
  const granted = client.authorize(payload());
  const read = client.readCurrentAuthority(granted.goal_id);

  assert.equal(read.fixture, false);
  assert.equal(read.revision, 1);
  assert.deepEqual(read.record.scope_refs, DRAFT.scope_refs, "scope refs round-trip exactly");
  assert.equal(read.record.scope_label, "DataScape / Continuity");
});

test("V6.1.5B: a stale management tab cannot reapply its intent onto a newer revision", () => {
  const { client } = harness();
  const granted = client.authorize(payload());

  // Tab B narrows.
  assert.equal(client.authorize({
    operation_id: "op-b", authorization_action: "narrow_authority",
    goal_id: granted.goal_id, expected_authority_revision: 1, scope_refs: ["semantic-centre:continuity"],
  }).ok, true);

  // Tab A, still on rev 1, tries to revoke.
  const staleTab = client.authorize({
    operation_id: "op-a", authorization_action: "revoke_authority",
    goal_id: granted.goal_id, expected_authority_revision: 1,
  });
  assert.equal(staleTab.ok, false);
  assert.equal(staleTab.failure, "stale_revision");
  assert.equal(client.readCurrentAuthority(granted.goal_id).state, "narrowed",
    "tab A's intent must not land on rev 2");
});

// ---- §16: a failed audit does not un-grant authority --------------------------

test("V6.1.5B: a shadow-audit failure never rolls back a committed ruling", () => {
  const { client, resolved } = harness({
    shadowAudit: () => { throw new Error("audit backend unavailable"); },
  });
  const result = client.authorize(payload());

  assert.equal(result.ok, true, "the owner's ruling stands");
  assert.equal(result.shadow_audit_failed, true);
  assert.equal(resolved.length, 1, "the exception stays resolved");
  assert.equal(client.readCurrentAuthority(result.goal_id).state, "authorized");

  // The positive control: a working audit is reported as such.
  const ok = harness({ shadowAudit: () => ({ ok: true, audit_ref: "shadow-1" }) });
  const good = ok.client.authorize(payload());
  assert.equal(good.shadow_audit_failed, false);
  assert.equal(good.shadow_audit.audit_ref, "shadow-1");
});

// ---- §5: no execution surface on the client -----------------------------------

test("V6.1.5B: the client exposes no execution surface", () => {
  const { client } = harness();
  for (const forbidden of ["dispatch", "execute", "send", "run", "launch"]) {
    assert.equal(typeof client[forbidden], "undefined", `${forbidden} must not exist on the authority client`);
  }
  assert.equal(client.mode, "live");
  assert.equal(client.canWriteAuthority, true);
});

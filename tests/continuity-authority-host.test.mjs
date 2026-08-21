import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorityEndpoint, AUTHENTICATED_OPERATIONS } from "../src/continuity/control/authority-endpoint.js";
import { AUTHORITY_ENDPOINT, createAuthorityEndpointClient } from "../src/continuity/control/authority-endpoint-client.js";
import { createReceiptStore } from "../src/continuity/control/authority-receipt.js";
import {
  REFUSED_SESSION_MECHANISMS, authorityHostPreflight, createStartupGate,
  resolveOwnerSession, validateStorePath,
} from "../src/continuity/control/authority-host.js";
import { CONTRACT_CASES, createContractExceptionStore, runExceptionContract } from "../src/continuity/control/exception-contract.js";
import { createMemoryStorage } from "../src/continuity/control/authority-journal.js";
import { policyIdentityOf } from "../src/continuity/control/authority-draft.js";
import { SCOPE_CATALOGUE, fixtureStates } from "../src/continuity/control/authority-fixture.js";

const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";
const AT = Date.parse("2026-08-22T09:00:00+10:00");
const DRAFT = fixtureStates().F3_authorized_goal.draft;

function host({ role = "owner", at = AT, requireReceipt = true } = {}) {
  let clock = at;
  const exceptions = createContractExceptionStore();
  const receipts = createReceiptStore({ now: () => clock, ttlMs: 60000 });
  const endpoint = createAuthorityEndpoint({
    authenticateCaller: () => (role ? { role, id: "fake-owner" } : null),
    exceptions,
    now: () => clock,
    storage: createMemoryStorage(),
    receipts,
    requireReceipt,
    readContext: {
      blocker: () => (exceptions.isResolved(BLOCKER) ? null : { id: BLOCKER, title: "V6 execution authority" }),
      domain: () => BLOCKER,
      catalogue: () => SCOPE_CATALOGUE,
      suggestions: () => [],
      draft: () => null,
    },
  });
  return { endpoint, exceptions, receipts, advance: (ms) => { clock += ms; } };
}

// ---- §1: the browser may not choose the endpoint -------------------------------

test("V6.1.6: the authority endpoint is fixed, not page-supplied", () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    // A page-chosen endpoint could return fabricated authority state, or
    // receive her drafts.
    assert.throws(
      () => createAuthorityEndpointClient({ endpoint: "https://evil.example/authority" }),
      /the authority endpoint is fixed/,
    );
    // The fixed constant is accepted.
    assert.equal(createAuthorityEndpointClient({ endpoint: AUTHORITY_ENDPOINT }).mode, "live");
    assert.equal(createAuthorityEndpointClient().mode, "live");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- §2: every owner-facing read authenticates ---------------------------------

test("V6.1.6: an unauthenticated caller cannot READ the authority context", () => {
  const anon = host({ role: null });
  for (const op of AUTHENTICATED_OPERATIONS) {
    const result = anon.endpoint.handle(op, {});
    assert.equal(result.ok, false, `${op} must authenticate`);
    assert.equal(result.failure, "not_authenticated");
  }

  const agent = host({ role: "agent" });
  const ctx = agent.endpoint.handle("context", {});
  assert.equal(ctx.failure, "not_owner");
  assert.equal(ctx.record, undefined, "no authority state may leak to a non-owner");

  // The positive control: an owner reads it.
  const owner = host();
  const read = owner.endpoint.handle("context", {});
  assert.equal(read.ok, true);
  assert.equal(read.blocker.id, BLOCKER);
});

test("V6.1.6: a spoof attempt is reported even on an authentication refusal", () => {
  const agent = host({ role: "agent" });
  const result = agent.endpoint.handle("context", { actor: "owner", isOwner: true, session: {} });
  assert.equal(result.failure, "not_owner");
  assert.ok(result.stripped_identity_fields.includes("actor"));
  assert.ok(result.stripped_identity_fields.includes("session"));
});

// ---- §3: the server-issued preview receipt -------------------------------------

test("V6.1.6: authorization refers to what the HOST prepared, not to a browser draft", () => {
  const h = host();
  const prepared = h.endpoint.handle("prepare", { draft: DRAFT, authorization_action: "authorize_goal" });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.preview_receipt.startsWith("rcpt_"));
  // What she reads comes back from the host, bound to the receipt.
  assert.equal(prepared.preview.receipt_id, prepared.preview_receipt);
  assert.equal(prepared.preview.statement, DRAFT.statement);

  // Commit carries the receipt. A substituted draft in the same request is
  // ignored, because the policy is taken from the receipt.
  const substituted = { ...DRAFT, allowed_capabilities: [...DRAFT.allowed_capabilities, "publish_publicly"] };
  const result = h.endpoint.handle("authorize", {
    operation_id: "op-1",
    authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt,
    draft: substituted,
    policy_identity: policyIdentityOf(substituted),
    source_exception_id: BLOCKER,
  });
  assert.equal(result.ok, true);
  const stored = h.endpoint.handle("current", { goal_id: result.goal_id });
  assert.deepEqual(stored.record.capability_envelope.allowed_capabilities.includes("approve_external_post"), false,
    "the substituted capability must not have been authorized");
});

test("V6.1.6: authorizing without a valid receipt is refused", () => {
  const h = host();
  const base = {
    operation_id: "op-none", authorization_action: "authorize_goal",
    draft: DRAFT, policy_identity: policyIdentityOf(DRAFT), source_exception_id: BLOCKER,
  };
  assert.equal(h.endpoint.handle("authorize", base).failure, "no_receipt");
  assert.equal(h.endpoint.handle("authorize", { ...base, preview_receipt: "rcpt_forged" }).failure, "no_receipt");
  assert.equal(h.exceptions.isResolved(BLOCKER), false, "nothing may be resolved by a rejected authorization");
});

test("V6.1.6: an expired receipt is refused and the owner reviews again", () => {
  const h = host();
  const prepared = h.endpoint.handle("prepare", { draft: DRAFT, authorization_action: "authorize_goal" });
  h.advance(60001);
  const result = h.endpoint.handle("authorize", {
    operation_id: "op-exp", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt, source_exception_id: BLOCKER,
  });
  assert.equal(result.failure, "expired_receipt");
  assert.equal(h.exceptions.isResolved(BLOCKER), false);
});

test("V6.1.6: a receipt is single use", () => {
  const h = host();
  const prepared = h.endpoint.handle("prepare", { draft: DRAFT, authorization_action: "authorize_goal" });
  const body = {
    operation_id: "op-a", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt, source_exception_id: BLOCKER,
  };
  assert.equal(h.endpoint.handle("authorize", body).ok, true);
  // A second, DIFFERENT operation cannot ride the same review.
  assert.equal(h.endpoint.handle("authorize", { ...body, operation_id: "op-b" }).failure, "no_receipt");
});

test("V6.1.6: a receipt cannot be reused across authority domains", () => {
  const h = host();
  const prepared = h.endpoint.handle("prepare", { draft: DRAFT, authorization_action: "authorize_goal" });
  const result = h.endpoint.handle("authorize", {
    operation_id: "op-x", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt,
    source_exception_id: "2026-08-17-sumzup-digest-budget-1747",
  });
  assert.equal(result.failure, "receipt_domain_mismatch");
});

test("V6.1.6: an amendment receipt is bound to the revision it was prepared against", () => {
  const h = host();
  const prepared = h.endpoint.handle("prepare", { draft: DRAFT, authorization_action: "authorize_goal" });
  const granted = h.endpoint.handle("authorize", {
    operation_id: "op-grant", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt, source_exception_id: BLOCKER,
  });

  // Prepare a narrow against rev 1, then let rev 1 become rev 2 elsewhere.
  const narrowReceipt = h.endpoint.handle("prepare", {
    draft: DRAFT, authorization_action: "narrow_authority", goal_id: granted.goal_id,
  });
  const other = h.endpoint.handle("prepare", {
    draft: DRAFT, authorization_action: "narrow_authority", goal_id: granted.goal_id,
  });
  assert.equal(h.endpoint.handle("authorize", {
    operation_id: "op-n1", authorization_action: "narrow_authority",
    preview_receipt: other.preview_receipt, goal_id: granted.goal_id,
    expected_authority_revision: 1, scope_refs: ["semantic-centre:continuity"],
  }).ok, true);

  const stale = h.endpoint.handle("authorize", {
    operation_id: "op-n2", authorization_action: "narrow_authority",
    preview_receipt: narrowReceipt.preview_receipt, goal_id: granted.goal_id,
    expected_authority_revision: 2, scope_refs: ["semantic-centre:continuity"],
  });
  assert.equal(stale.failure, "stale_receipt_revision",
    "a review prepared against rev 1 may not authorize a change to rev 2");
});

// ---- §4: the owner session boundary --------------------------------------------

test("V6.1.6: localhost is not authentication, and neither is a browser claim", () => {
  for (const mechanism of REFUSED_SESSION_MECHANISMS) {
    const resolved = resolveOwnerSession({ mechanism, authenticateCaller: () => ({ role: "owner" }) });
    assert.equal(resolved.resolved, false, `${mechanism} must not authenticate`);
    assert.equal(resolved.must_stop, true);
  }
  // A mechanism with no authenticator is also unresolved.
  assert.equal(resolveOwnerSession({ sessionMechanism: "host_session" }).resolved, false);

  // The positive control.
  const good = resolveOwnerSession({ sessionMechanism: "host_session", authenticateCaller: () => ({ role: "owner" }) });
  assert.equal(good.resolved, true);
  assert.equal(good.must_stop, false);
});

// ---- §5: private durable storage and the startup gate --------------------------

test("V6.1.6: authority state may not live in shipped or review paths", () => {
  for (const bad of [
    "D:/Projects/datascape/dist/authority.json",
    "D:/Projects/datascape/public/data/authority.json",
    "D:/Projects/_hub/reviews/authority.json",
    "D:/Projects/_hub/shadow/continuity/authority.json",
  ]) {
    assert.equal(validateStorePath(bad).ok, false, bad);
  }
  // Inside the repo at all is refused: one stray `git add -A` publishes it.
  assert.equal(validateStorePath("D:/Projects/datascape/state/authority.json", { repoRoot: "D:/Projects/datascape" }).ok, false);

  const good = validateStorePath("D:/Projects/.private/continuity/authority.json", { repoRoot: "D:/Projects/datascape" });
  assert.equal(good.ok, true, JSON.stringify(good.problems));
});

test("V6.1.6: nothing is served until recovery completes", () => {
  const gate = createStartupGate();
  assert.equal(gate.mayServe().ok, false);
  assert.equal(gate.mayServe().failure, "recovering");

  gate.complete([{ operation_id: "op-1", outcome: "rolled_forward" }]);
  assert.equal(gate.mayServe().ok, true);
  assert.equal(gate.recoveryReport().length, 1);

  // And a failed recovery fails CLOSED rather than serving an empty authority.
  const broken = createStartupGate();
  broken.fail("journal unreadable");
  assert.equal(broken.mayServe().ok, false);
  assert.equal(broken.mayServe().failure, "authority_unavailable");
});

// ---- §6: the real exception adapter contract -----------------------------------

test("V6.1.6: the exception contract is satisfiable and refuses a real namespace", () => {
  const result = runExceptionContract({
    adapter: createContractExceptionStore(),
    namespace: "contract-test-exception",
  });
  assert.equal(result.satisfies_contract, true, JSON.stringify(result.failed));
  assert.deepEqual(Object.keys(result.cases).sort(), [...CONTRACT_CASES].sort());

  // It refuses to run against anything that is not obviously a test namespace,
  // because it WRITES resolutions.
  assert.throws(
    () => runExceptionContract({ adapter: createContractExceptionStore(), namespace: BLOCKER }),
    /temporary or test exception namespace/,
  );
});

test("V6.1.6: an implementation that is not idempotent fails the contract", () => {
  // Negative control: a plausible-looking store that resolves once and then
  // refuses everything, including its own ruling. Recovery would break on it.
  const naive = {
    resolved: new Set(),
    resolve(id) {
      if (this.resolved.has(id)) return { ok: false, reason: "already resolved" };
      this.resolved.add(id);
      return { ok: true };
    },
  };
  const result = runExceptionContract({ adapter: naive, namespace: "contract-test-naive" });
  assert.equal(result.satisfies_contract, false);
  assert.ok(result.failed.includes("same_ruling_is_idempotent"));
});

// ---- §8, and the preflight -----------------------------------------------------

test("V6.1.6: the preflight stops rather than weakening authentication", () => {
  const stopped = authorityHostPreflight({
    hostConfig: { sessionMechanism: "localhost_implies_owner", storePath: "D:/Projects/.private/a.json" },
    fs: { accessSync: () => {} },
    blocker: { id: BLOCKER },
    catalogue: SCOPE_CATALOGUE,
  });
  assert.equal(stopped.owner_session_resolved, false);
  assert.equal(stopped.must_stop, true);
  assert.equal(stopped.preview_can_be_prepared, false);
  assert.equal(stopped.write_performed, "NO");

  const ready = authorityHostPreflight({
    hostConfig: {
      sessionMechanism: "host_session",
      authenticateCaller: () => ({ role: "owner" }),
      storePath: "D:/Projects/.private/continuity/authority.json",
    },
    fs: { accessSync: () => {} },
    repoRoot: "D:/Projects/datascape",
    blocker: { id: BLOCKER },
    catalogue: SCOPE_CATALOGUE,
  });
  assert.equal(ready.owner_session_resolved, true);
  assert.equal(ready.storage_private, true);
  assert.equal(ready.preview_can_be_prepared, true);
  assert.equal(ready.must_stop, false);
  assert.equal(ready.write_performed, "NO", "a preflight never writes");
});

test("V6.1.6: the host reaches no execution transport", async () => {
  const path = await import("node:path");
  const { importGraph, reachesAny } = await import("../src/continuity/control/import-audit.js");
  const graph = importGraph(path.resolve("src/continuity/control/authority-endpoint.js"));
  assert.equal(reachesAny(graph, ["control/dispatch.js", "control/simulate.js", "control/lease.js"]), false,
    "an owner may grant authority in a build with no executable transport installed");
});

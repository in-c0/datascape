import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_MUTATIONS, UNTRUSTED_VERIFICATION_FIELDS, createOwnerPresenceVerifier,
  createReadUnlock, describePurpose, requiresOwnerPresence, stripClaimedVerification,
} from "../src/continuity/control/owner-presence.js";
import {
  createFakeOwnerPresenceBroker, createWindowsOwnerPresenceBroker, randomChallenge,
} from "../src/continuity/control/owner-presence-windows.js";

/** Every automated test drives the fake. Real Windows verification never runs in CI. */
function verifier({ availability = "available", outcome = "verified", echoChallenge = true, at = 0 } = {}) {
  let clock = at;
  const broker = createFakeOwnerPresenceBroker({ availability, outcome, echoChallenge });
  return {
    broker,
    advance: (ms) => { clock += ms; },
    verifier: createOwnerPresenceVerifier({
      broker, now: () => clock, randomChallenge, cooldownMs: 3000,
    }),
  };
}

// ---- the browser can never assert verification --------------------------------

test("A.2: a claimed verification in the payload is stripped, never believed", () => {
  const dirty = Object.fromEntries(UNTRUSTED_VERIFICATION_FIELDS.map((f) => [f, true]));
  const { request, stripped_verification_fields } = stripClaimedVerification({ operation_id: "op-1", ...dirty });

  for (const field of UNTRUSTED_VERIFICATION_FIELDS) {
    assert.equal(request[field], undefined, `${field} must not survive`);
  }
  assert.equal(stripped_verification_fields.length, UNTRUSTED_VERIFICATION_FIELDS.length);
  assert.equal(request.operation_id, "op-1", "legitimate fields survive");
});

test("A.2: the verifier issues nothing a browser could carry", async () => {
  const { verifier: v } = verifier();
  const result = await v.verify({ purpose: "Authorize", operationRef: "op-1" });

  assert.equal(v.issues_transferable_token, false);
  assert.equal(result.outcome, "verified");
  for (const forbidden of ["token", "windows_verified_token", "signature", "proof"]) {
    assert.equal(result[forbidden], undefined, `${forbidden} would be another transferable credential`);
  }
});

// ---- a verification is bound to ONE operation ----------------------------------

test("A.2: a verification cannot be transferred to another operation", async () => {
  const { verifier: v } = verifier();
  const verified = await v.verify({ purpose: "Authorize", operationRef: "op-authorize" });

  assert.equal(v.authorizes(verified, "op-authorize").ok, true);
  assert.equal(v.authorizes(verified, "op-revoke").ok, false, "not transferable");
  assert.equal(v.authorizes(verified, "2026-08-17-sumzup-digest-budget-1747").ok, false,
    "not usable across exception ids");

  // And an unverified outcome authorizes nothing at all.
  const cancelled = await verifier({ outcome: "cancelled" }).verifier
    .verify({ purpose: "x", operationRef: "op-authorize" });
  assert.equal(v.authorizes(cancelled, "op-authorize").ok, false);
});

test("A.2: a result that does not echo this host's challenge is refused", async () => {
  // A standalone process invoking the broker for its OWN challenge proves
  // nothing to this host.
  const { verifier: v } = verifier({ echoChallenge: false });
  const result = await v.verify({ purpose: "Authorize", operationRef: "op-1" });
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /did not echo this host's challenge/);
});

test("A.2: challenges are unforgeable and never repeat", () => {
  const seen = new Set(Array.from({ length: 200 }, () => randomChallenge()));
  assert.equal(seen.size, 200);
  assert.ok([...seen].every((c) => c.startsWith("chal_") && c.length > 40));
});

// ---- every non-verified outcome is boring --------------------------------------

test("A.2: cancelled, failed and unavailable all mutate nothing", async () => {
  for (const [outcome, expected] of [["cancelled", "cancelled"], ["failed", "failed"]]) {
    const { verifier: v } = verifier({ outcome });
    const result = await v.verify({ purpose: "x", operationRef: "op-1" });
    assert.equal(result.outcome, expected);
    assert.equal(v.authorizes(result, "op-1").ok, false);
  }

  // Device absent / not configured / disabled by policy are NOT reasons to
  // fall back to trusting localhost.
  for (const availability of ["not_configured", "unavailable", "disabled", "error"]) {
    const { verifier: v } = verifier({ availability });
    const result = await v.verify({ purpose: "x", operationRef: "op-1" });
    assert.equal(result.outcome, "unavailable");
    assert.equal(v.authorizes(result, "op-1").ok, false);
  }
});

// ---- prompt-bomb protection -----------------------------------------------------

test("A.2: concurrent prompts collapse and cancellation cools down", async () => {
  const { verifier: v } = verifier();
  // Two at once: the second is refused rather than opening a second dialog.
  const [a, b] = await Promise.all([
    v.verify({ purpose: "x", operationRef: "op-a" }),
    v.verify({ purpose: "x", operationRef: "op-b" }),
  ]);
  const collapsed = [a, b].filter((r) => r.collapsed);
  assert.equal(collapsed.length, 1, "a caller must not be able to open dozens of dialogs");

  // After a cancellation, a cooldown holds.
  const cancelled = verifier({ outcome: "cancelled" });
  await cancelled.verifier.verify({ purpose: "x", operationRef: "op-1" });
  const immediate = await cancelled.verifier.verify({ purpose: "x", operationRef: "op-1" });
  assert.equal(immediate.cooldown, true);

  cancelled.advance(3001);
  const later = await cancelled.verifier.verify({ purpose: "x", operationRef: "op-1" });
  assert.notEqual(later.cooldown, true, "the cooldown must expire, not latch");
});

// ---- the read unlock can never satisfy a mutation ------------------------------

test("A.2: a read unlock reads and never rules", () => {
  let clock = 0;
  const unlock = createReadUnlock({ now: () => clock, ttlMs: 5 * 60 * 1000 });

  assert.equal(unlock.mayRead(), false);
  unlock.grant();
  assert.equal(unlock.mayRead(), true);
  // The rule that protects against an agent driving an already-open browser.
  assert.equal(unlock.mayMutate(), false);
  assert.equal(unlock.persisted, false, "never persisted, lost on host restart");

  clock += 5 * 60 * 1000 + 1;
  assert.equal(unlock.mayRead(), false, "five minutes absolute");
});

// ---- which operations demand presence ------------------------------------------

test("A.2: every owner ruling requires fresh presence, including the inbox", () => {
  for (const op of ["authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority"]) {
    assert.equal(requiresOwnerPresence(op), true, op);
  }
  // The finding that promoted this from an observation to a release condition:
  // an agent must not be able to impersonate her in the exception inbox either.
  for (const op of ["approve", "reply_done", "reply_no", "reply_need_context", "defer", "dismiss"]) {
    assert.equal(requiresOwnerPresence(op), true, op);
  }
  assert.equal(requiresOwnerPresence("read_context"), false, "reads do not prompt");
  assert.equal(requiresOwnerPresence("prepare"), false);
  assert.equal(OWNER_MUTATIONS.length, 10);
});

// ---- the prompt describes the host-bound operation ------------------------------

test("A.2: the prompt distinguishes the class of owner action", () => {
  const grant = describePurpose("authorize_goal", { scope_label: "DataScape / Continuity", max_wall_time_ms: 900000, max_cost: 0 });
  assert.match(grant, /Authorize DataScape autonomous work/);
  assert.match(grant, /DataScape \/ Continuity/);
  assert.match(grant, /15 minutes/);
  assert.match(grant, /\$0/);

  assert.match(describePurpose("revoke_authority"), /Stop autonomous work/);
  assert.match(describePurpose("reply_done", { exception_id: "2026-08-21-x" }), /Done/);
  assert.match(describePurpose("defer", { exception_id: "2026-08-21-x" }), /Defer/);

  // Distinguishable from each other: a person reading only the dialog is not
  // consenting blind.
  const prompts = ["authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority", "defer", "dismiss"]
    .map((op) => describePurpose(op, { exception_id: "e" }));
  assert.equal(new Set(prompts).size, prompts.length);
});

// ---- the broker holds nothing, and never prompts by accident --------------------

test("A.2: the broker exposes only availability and verify", () => {
  const broker = createWindowsOwnerPresenceBroker();
  assert.deepEqual(Object.keys(broker).filter((k) => typeof broker[k] === "function").sort(), ["availability", "verify"]);
  assert.equal(broker.holdsAuthority, false);
  for (const forbidden of ["store", "exceptions", "listen", "dispatch", "execute", "fetch"]) {
    assert.equal(typeof broker[forbidden], "undefined", `${forbidden} must not exist on the broker`);
  }
});

test("A.2: interactive verification is refused unless explicitly permitted", async () => {
  // The guard that stops an unattended tick from putting a dialog in front of
  // someone who did not ask for one.
  const guarded = createWindowsOwnerPresenceBroker();
  const result = await guarded.verify({ challenge: "chal_x", purpose: "test" });
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /not permitted by the caller/);
  assert.equal(result.challenge, "chal_x", "even a refusal echoes the challenge");
});

// ---- nothing here reaches authority or execution --------------------------------

test("A.2: the presence substrate reaches no authority store and no executor", async () => {
  const path = await import("node:path");
  const { importGraph, reachesAny } = await import("../src/continuity/control/import-audit.js");
  for (const entry of ["owner-presence.js", "owner-presence-windows.js"]) {
    const graph = importGraph(path.resolve("src/continuity/control", entry));
    assert.equal(reachesAny(graph, [
      "control/authority-store.js", "control/authority-journal.js", "control/authority-endpoint.js",
      "control/dispatch.js", "control/simulate.js",
    ]), false, `${entry} must hold no authority or execution capability`);
  }
});

// ---- A.2.1: owner presence is genuinely one-shot -------------------------------

test("A.2.1: the same verification cannot authorize the same operation twice", async () => {
  const { verifier: v } = verifier();
  const verified = await v.verify({ purpose: "Authorize", operationRef: "op-1" });

  assert.equal(v.authorizes(verified, "op-1").ok, true, "the first use succeeds");
  const second = v.authorizes(verified, "op-1");
  assert.equal(second.ok, false, "a verified result is not a reusable capability");
  assert.match(second.reason, /already been used/);
  assert.equal(v.unspentCount(), 0);
});

test("A.2.1: a copied or serialized verification is not usable proof", async () => {
  const { verifier: v } = verifier();
  const verified = await v.verify({ purpose: "Authorize", operationRef: "op-1" });

  // Round-tripped through JSON, exactly as it would be if it had travelled.
  const copied = JSON.parse(JSON.stringify(verified));
  assert.equal(v.authorizes(copied, "op-1").ok, true, "a faithful copy spends the one handle");
  // ...and neither the copy nor the original works again.
  assert.equal(v.authorizes(copied, "op-1").ok, false);
  assert.equal(v.authorizes(verified, "op-1").ok, false);

  // A fabricated handle from outside this process authorizes nothing.
  const forged = { outcome: "verified", operation_ref: "op-2", verification_handle: "chal_forged" };
  assert.equal(v.authorizes(forged, "op-2").ok, false);
  // And so does one with no handle at all.
  assert.equal(v.authorizes({ outcome: "verified", operation_ref: "op-2" }, "op-2").ok, false);
});

test("A.2.1: one-shot consumption does not weaken cross-operation refusal", async () => {
  const { verifier: v } = verifier();
  const verified = await v.verify({ purpose: "Authorize", operationRef: "op-a" });

  // Spending it on the wrong operation must not spend it at all.
  assert.equal(v.authorizes(verified, "op-b").ok, false);
  assert.equal(v.unspentCount(), 1, "a refused cross-operation attempt must not burn the handle");
  assert.equal(v.authorizes(verified, "op-a").ok, true);
});

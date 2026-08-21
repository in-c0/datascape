import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ACTION_SEMANTICS, OWNER_ACTIONS, createMemoryJournalStorage, createPromptBudget,
  createRulingJournal, exceptionFingerprint, performOwnerRuling, prepareOwnerMutation, promptFor,
  validateCurrentState,
} from "../src/continuity/control/owner-ruling.js";
import {
  LANE_WITHDRAWAL_STATUS, authorizeTransition, classifyTransition,
} from "../src/continuity/control/owner-ruling-policy.js";
import { parseArgs } from "../ops/owner-rule.mjs";

const EXCEPTION = {
  id: "2026-08-22-unit-0001",
  status: "blocked-on-owner",
  updated: "2026-08-22T08:00:00+10:00",
  proposed: "spend $40",
  proposal_revision: 2,
  body: "",
};

function harness({ outcome = "verified", exception = { ...EXCEPTION } } = {}) {
  let clock = Date.parse("2026-08-22T09:00:00+10:00");
  const prompts = [];
  const mutations = [];
  const state = { current: { ...exception } };

  const verifier = {
    issued: new Set(),
    async verify({ purpose, operationRef }) {
      prompts.push({ purpose, operationRef });
      if (state.duringPrompt) state.duringPrompt();
      if (outcome !== "verified") return { outcome, reason: `device said ${outcome}` };
      const verification = { outcome: "verified", operation_ref: operationRef };
      verifier.issued.add(verification);
      return verification;
    },
    authorizes(verification, ref) {
      if (verification?.outcome !== "verified") return { ok: false, reason: "no verified owner presence" };
      if (verification.operation_ref !== ref) return { ok: false, reason: "different operation" };
      if (!verifier.issued.has(verification)) return { ok: false, reason: "already used or not ours" };
      verifier.issued.delete(verification);
      return { ok: true };
    },
  };

  const now = () => clock;
  return {
    prompts, mutations, state, verifier, now,
    advance: (ms) => { clock += ms; },
    journal: createRulingJournal({ storage: createMemoryJournalStorage(), now }),
    budget: createPromptBudget({ now }),
    readException: (id) => (id === state.current.id ? { ...state.current } : null),
    applyMutation: (mutation) => {
      mutations.push(mutation);
      state.current = {
        ...state.current,
        status: ACTION_SEMANTICS[mutation.action].status ?? state.current.status,
        updated: new Date(clock).toISOString(),
        body: `${state.current.body}\nOWNER [${mutation.operation_ref}]`,
      };
      return { id: state.current.id, action: mutation.action, ruling_ref: mutation.operation_ref };
    },
  };
}

const rule = (h, request) => performOwnerRuling({ request, ...h });

test("owner-ruling: the six classes are closed and prose is never classified", () => {
  assert.deepEqual(OWNER_ACTIONS,
    ["approve", "reply_done", "reply_no", "reply_need_context", "defer", "dismiss"]);

  // The old wire vocabulary is gone, not tolerated.
  const generic = prepareOwnerMutation({ request: { action: "reply", note: "Done" }, exception: EXCEPTION, at: 0 });
  assert.equal(generic.ok, false);
  assert.equal(generic.failure, "invalid_action");

  // And nothing anywhere recovers her meaning from a string.
  const source = [
    "../src/continuity/control/owner-ruling.js",
    "../src/continuity/control/owner-ruling-policy.js",
    "../ops/live-host/briefing-server.mjs",
  ]
    .map((rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8"))
    .join("\n")
    // Strip comments first: a regex that matches its own explanation proves
    // nothing about the code.
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/["'`](done|need context|no)["'`]\s*(===|==)/i.test(source), "a class is compared, never a phrase");
  assert.ok(!/\.(includes|indexOf|match|test)\(\s*["'`][^"'`]*\b(done|context)\b/i.test(source),
    "no keyword classification of her words");
});

test("owner-ruling: the host derives the operation; the client only correlates", () => {
  const claimed = prepareOwnerMutation({
    request: { action: "dismiss", operation_id: "op-1", operation_ref: "ruling:i-made-this-up", exception_fingerprint: "fp:whatever" },
    exception: EXCEPTION, at: 0,
  });
  assert.equal(claimed.ok, true);
  assert.notEqual(claimed.mutation.operation_ref, "ruling:i-made-this-up");
  assert.equal(claimed.mutation.exception_fingerprint, exceptionFingerprint(EXCEPTION));
});

test("owner-ruling: approve binds the exact proposal and its revision", () => {
  const prepared = prepareOwnerMutation({ request: { action: "approve", operation_id: "op-2" }, exception: EXCEPTION, at: 0 });
  assert.equal(prepared.mutation.proposal_revision, 2);
  assert.equal(prepared.mutation.payload.proposal_ref, EXCEPTION.id);
});

test("owner-ruling: the prompt shows the class and the exact editable text", () => {
  const prepared = prepareOwnerMutation({
    request: { action: "reply_need_context", note: "which budget?", operation_id: "op-3" },
    exception: EXCEPTION, at: 0,
  });
  const prompt = promptFor(prepared.mutation);
  assert.match(prompt, /Ask for more context/);
  assert.match(prompt, /which budget\?/);

  const deferred = prepareOwnerMutation({
    request: { action: "defer", until: "2026-08-24T09:00:00+10:00", operation_id: "op-4" },
    exception: EXCEPTION, at: 0,
  });
  assert.match(promptFor(deferred.mutation), /Defer exception .* until 2026-08-2/);
});

test("owner-ruling: idempotency is decided before the prompt, staleness after it", async () => {
  const h = harness();
  const request = { id: EXCEPTION.id, action: "reply_done", operation_id: "op-order" };

  const first = await rule(h, request);
  assert.equal(first.ok, true);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.mutations.length, 1);

  // The ruling changed the exception. A retry must still replay — the question
  // "is this the same operation" is about semantics, not about state.
  const replay = await rule(h, request);
  assert.equal(replay.replayed, true);
  assert.equal(h.prompts.length, 1, "a replay must not prompt");
  assert.equal(h.mutations.length, 1, "a replay must not write");
});

test("owner-ruling: a state change during the prompt spends the presence and writes nothing", async () => {
  const h = harness();
  h.state.duringPrompt = () => { h.state.current = { ...h.state.current, proposed: "spend $400", updated: "2026-08-22T09:00:05+10:00" }; };

  const result = await rule(h, { id: EXCEPTION.id, action: "approve", operation_id: "op-stale" });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "stale_owner_operation");
  assert.equal(result.prompt_shown, true);
  assert.equal(h.mutations.length, 0);
  assert.equal(h.verifier.issued.size, 0, "the verification is spent, not left available for a retry");
});

test("owner-ruling: an operation id reused for different semantics collides without prompting", async () => {
  const h = harness();
  await rule(h, { id: EXCEPTION.id, action: "reply_no", operation_id: "op-x" });
  const collision = await rule(h, { id: EXCEPTION.id, action: "dismiss", operation_id: "op-x" });
  assert.equal(collision.failure, "idempotency_collision");
  assert.equal(h.prompts.length, 1);
  assert.equal(h.mutations.length, 1);
});

test("owner-ruling: every non-verified outcome means nothing happened", async () => {
  for (const outcome of ["cancelled", "failed", "unavailable"]) {
    const h = harness({ outcome });
    const result = await rule(h, { id: EXCEPTION.id, action: "dismiss", operation_id: `op-${outcome}` });
    assert.equal(result.ok, false);
    assert.equal(result.failure, outcome);
    assert.equal(result.mutation_performed, false);
    assert.equal(h.mutations.length, 0);
  }
});

test("owner-ruling: recovery needs the WHOLE postcondition, not just the ref", () => {
  const h = harness();
  const storage = createMemoryJournalStorage();
  const journal = createRulingJournal({ storage, now: h.now });
  const prepare = (action, id) => prepareOwnerMutation({
    request: { action, operation_id: id }, exception: h.state.current, at: h.now(),
  }).mutation;

  // Complete: the mutation landed, the process died before the journal commit.
  const done = prepare("dismiss", "op-crash");
  journal.begin(done);
  h.applyMutation(done);
  assert.deepEqual(journal.recover(h.readException),
    [{ operation_id: "op-crash", outcome: "rolled_forward", result: journal.completed("op-crash").result }]);
  assert.ok(journal.completed("op-crash").result.ruling_ref,
    "a rolled-forward operation must still be able to answer a retry");

  // Nothing landed: nothing is claimed.
  const h2 = harness();
  const j2 = createRulingJournal({ storage: createMemoryJournalStorage(), now: h2.now });
  const orphan = prepareOwnerMutation({
    request: { action: "reply_no", operation_id: "op-orphan" }, exception: h2.state.current, at: h2.now(),
  }).mutation;
  j2.begin(orphan);
  assert.deepEqual(j2.recover(h2.readException), [{ operation_id: "op-orphan", outcome: "aborted" }]);
  assert.equal(j2.completed("op-orphan"), null);
});

test("owner-ruling: a half-applied ruling fails closed instead of being rounded", async () => {
  const h = harness();
  const storage = createMemoryJournalStorage();
  const journal = createRulingJournal({ storage, now: h.now });
  const mutation = prepareOwnerMutation({
    request: { action: "reply_done", operation_id: "op-half" }, exception: h.state.current, at: h.now(),
  }).mutation;

  journal.begin(mutation);
  // The amendment landed; the status change did not. Searching the body for the
  // ref would call this committed and lose her ruling silently.
  h.state.current = { ...h.state.current, body: `OWNER [${mutation.operation_ref}]` };

  const recovered = journal.recover(h.readException);
  assert.deepEqual(recovered, [{ operation_id: "op-half", outcome: "partial_application" }]);
  assert.equal(journal.completed("op-half"), null, "half a ruling is not a ruling");

  // And the orchestrator refuses to rule again over the top of it.
  const blocked = await performOwnerRuling({
    request: { id: EXCEPTION.id, action: "reply_done", operation_id: "op-half" }, ...h, journal,
  });
  assert.equal(blocked.failure, "partial_application");
  assert.equal(blocked.prompt_shown, false);
  assert.equal(h.mutations.length, 0);
});

test("owner-ruling: an aborted attempt retries on the SAME record", async () => {
  const h = harness({ outcome: "cancelled" });
  const request = { id: EXCEPTION.id, action: "dismiss", operation_id: "op-retry-after-cancel" };

  const cancelled = await rule(h, request);
  assert.equal(cancelled.failure, "cancelled");
  assert.equal(h.journal.all().length, 1);

  // The browser deliberately keeps the operation id after a non-200, so this
  // path is reached constantly. It used to append a second row with the same
  // id, and `update` then patched whichever came first.
  h.advance(11000);
  h.verifier.nextOutcome = "verified";
  const retried = await performOwnerRuling({ request, ...h, verifier: { ...h.verifier,
    verify: async ({ purpose, operationRef }) => {
      h.prompts.push({ purpose, operationRef });
      const v = { outcome: "verified", operation_ref: operationRef };
      h.verifier.issued.add(v);
      return v;
    } } });
  assert.equal(retried.ok, true);
  const rows = h.journal.all().filter((e) => e.operation_id === request.operation_id);
  assert.equal(rows.length, 1, "one operation is one journal record, always");
  assert.equal(rows[0].phase, "committed");
  assert.equal(rows[0].attempt, 2);
});

test("owner-ruling: a ruling on an item nobody is waiting on never prompts", async () => {
  for (const [status, action, proposed] of [
    ["resolved", "reply_done", "spend $40"],
    ["investigating", "defer", "spend $40"],
    ["blocked-on-owner", "approve", ""],
  ]) {
    const h = harness({ exception: { ...EXCEPTION, status, proposed } });
    const result = await rule(h, {
      id: EXCEPTION.id, action, operation_id: `op-${status}-${action}`,
      until: "2026-08-24T09:00:00+10:00",
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "action_not_currently_valid", `${status}/${action}`);
    assert.equal(h.prompts.length, 0, `${status}/${action} raised a prompt`);
    assert.equal(h.mutations.length, 0);
  }
});

test("owner-ruling: prompt budget cools down, locks out, and recovers", () => {
  let clock = 0;
  const budget = createPromptBudget({ now: () => clock });

  assert.equal(budget.mayPrompt().ok, true);
  budget.recordOutcome("cancelled");
  assert.equal(budget.mayPrompt().failure, "prompt_cooldown");

  clock += 11000; budget.recordOutcome("cancelled");
  clock += 11000; budget.recordOutcome("cancelled");
  clock += 11000;
  assert.equal(budget.mayPrompt().failure, "prompt_lockout");

  clock += 5 * 60 * 1000 + 1;
  assert.equal(budget.mayPrompt().ok, true);
  budget.recordOutcome("verified");
  assert.equal(budget.mayPrompt().ok, true, "a successful verification returns to normal");
  assert.equal(budget.persisted, false, "anti-DoS state is not security state");
});

// ---------------------------------------------------------------------------
// The CLI is not a second authority
// ---------------------------------------------------------------------------

test("policy: closing an owner-gated item is her decision; withdrawing it is the lane's", () => {
  const closing = classifyTransition({ from: "blocked-on-owner", to: "resolved" });
  assert.equal(closing.requires_owner_presence, true);

  const withdrawal = classifyTransition({ from: "blocked-on-owner", to: LANE_WITHDRAWAL_STATUS });
  assert.equal(withdrawal.requires_owner_presence, false);
  assert.match(withdrawal.record_as, /LANE WITHDREW/);

  // Ordinary lane work is untouched — a control that prompted her for this
  // would be switched off inside a week.
  assert.equal(classifyTransition({ from: "new", to: "investigating" }).requires_owner_presence, false);
  assert.equal(classifyTransition({ from: "investigating", to: "resolved" }).requires_owner_presence, false);

  // Claiming to record her decision requires presence wherever it happens.
  assert.equal(classifyTransition({ from: "investigating", to: "resolved", claims_owner_decision: true })
    .requires_owner_presence, true);
});

test("policy: a ruling ref is only evidence in the process that produced it", () => {
  const bare = authorizeTransition({ from: "blocked-on-owner", to: "resolved" });
  assert.equal(bare.ok, false);
  assert.equal(bare.failure, "owner_ruling_ref_required");

  const forged = authorizeTransition({
    from: "blocked-on-owner", to: "resolved", ruling_ref: "ruling:abc", verifiedRefs: new Set(),
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.failure, "unverified_ruling_ref");

  const real = authorizeTransition({
    from: "blocked-on-owner", to: "resolved", ruling_ref: "ruling:abc", verifiedRefs: new Set(["ruling:abc"]),
  });
  assert.equal(real.ok, true);
});

test("cli: argument parsing keeps the action closed and flags out of it", () => {
  assert.deepEqual(parseArgs(["id-1", "reply_done", "--note", "ok"]), { id: "id-1", action: "reply_done", note: "ok" });
  // A flag in the action position is a flag, not an action named "--withdraw".
  assert.deepEqual(parseArgs(["id-1", "--withdraw"]), { id: "id-1", action: undefined, withdraw: true });
});

// V6.1.6-A.2 PR B acceptance — the release gate.
//
// Direct unit calls are useful and are elsewhere. They do not satisfy this
// gate, because the property being claimed is about the SERVER: that a request
// arriving over HTTP cannot cause an owner-gated write without fresh owner
// presence for that exact operation.
//
// So every case here goes through the candidate's actual registered
// briefing-server on an ephemeral port, with an isolated exception directory, a
// private temporary ruling journal, and a fake owner-presence device. The real
// live host is never touched and no Windows dialog is ever possible: the broker
// is a stub, and `allowInteractive` is never set.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { acceptanceWorld, fixture } from "../ops/prb-world.mjs";

const op = (n) => `op-acceptance-${n}`;

// ---------------------------------------------------------------------------
// The six closed classes, each through the real transport
// ---------------------------------------------------------------------------

const CLASSES = [
  { action: "approve", expect: "investigating", verb: "APPROVED PROPOSED" },
  { action: "reply_done", expect: "resolved", verb: "REPLIED DONE" },
  { action: "reply_no", expect: "investigating", verb: "REPLIED NO" },
  { action: "reply_need_context", note: "which budget?", expect: "investigating", verb: "ASKED FOR CONTEXT" },
  { action: "defer", until: "2026-08-24T09:00:00+10:00", expect: "blocked-on-owner", verb: "DEFERRED" },
  { action: "dismiss", expect: "resolved", verb: "DISMISSED" },
];

for (const spec of CLASSES) {
  test(`acceptance: ${spec.action} verifies once and mutates once`, async () => {
    const world = await acceptanceWorld();
    try {
      const id = fixture(world);
      const result = await world.act({
        id, action: spec.action, note: spec.note ?? "", until: spec.until ?? null, operation_id: op(spec.action),
      });

      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(world.broker.calls.length, 1, "prompt_count must be exactly 1");
      assert.equal(world.amendments(id), 1, "mutation_count must be exactly 1");
      assert.equal(world.status(id), spec.expect);
      assert.match(world.file(id), new RegExp(`OWNER ${spec.verb} `));

      // The OS prompt described this operation, not browser prose.
      assert.match(world.broker.calls[0].purpose, new RegExp(id));
      if (spec.note) assert.match(world.broker.calls[0].purpose, new RegExp(spec.note));

      // The ruling is durably recorded, and carries the ref that makes a
      // crashed retry recoverable.
      assert.ok(result.body.ruling_ref, "a ruling must be identifiable");
      assert.match(world.file(id), new RegExp(result.body.ruling_ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const journal = world.deps.journal.completed(op(spec.action));
      assert.equal(journal.phase, "committed");

      // Nothing about the verification travelled back to the browser.
      const wire = JSON.stringify(result.body);
      for (const leak of ["verified", "challenge", "token", "nonce", "proof", "signature", "presence"]) {
        assert.ok(!new RegExp(`"[a-z_]*${leak}`, "i").test(wire), `the response leaks ${leak}`);
      }
    } finally { await world.close(); }
  });
}

test("acceptance: defer persists the absolute instant, not the browser's phrasing", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const result = await world.act({
      id, action: "defer", until: "2026-08-24T09:00:00+10:00", note: "Tonight", operation_id: op("defer-abs"),
    });
    assert.equal(result.status, 200);
    assert.match(world.file(id), /deferred_until: 2026-08-24T\d\d:\d\d/);
    assert.ok(!world.file(id).includes("Tonight"), "a UI convenience must never reach the file");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// Non-verified outcomes
// ---------------------------------------------------------------------------

for (const [outcome, availability, expected] of [
  ["cancelled", "available", "cancelled"],
  ["failed", "available", "failed"],
  ["verified", "unavailable", "unavailable"],
]) {
  test(`acceptance: a ${expected} verification writes nothing`, async () => {
    const world = await acceptanceWorld();
    try {
      const id = fixture(world);
      world.broker.outcomeValue = outcome;
      world.broker.availabilityValue = availability;

      const result = await world.act({ id, action: "reply_done", operation_id: op(expected) });
      assert.equal(result.body.mutation_performed, false);
      assert.equal(result.body.error, expected);
      assert.equal(world.amendments(id), 0, "a non-verified outcome must write nothing");
      assert.equal(world.status(id), "blocked-on-owner");
    } finally { await world.close(); }
  });
}

test("acceptance: a device that does not echo this host's challenge is not owner presence", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    world.broker.echoChallenge = false;
    const result = await world.act({ id, action: "dismiss", operation_id: op("echo") });
    assert.equal(result.body.mutation_performed, false);
    assert.equal(world.amendments(id), 0);
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// Staleness — checked AFTER the prompt
// ---------------------------------------------------------------------------

test("acceptance: a proposal that changes while Hello is open is NOT approved", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world, { proposed: "rev2 — spend $40" });

    // Another lane revises the proposal while the dialog is up. She reviewed
    // rev2; rev3 has never been in front of her.
    world.broker.duringPrompt = async () => {
      const file = world.file(id);
      fs.writeFileSync(path.join(world.inbox, `${id}.md`),
        file.replace("proposed: rev2 — spend $40", "proposed: rev3 — spend $400"));
    };

    const result = await world.act({ id, action: "approve", operation_id: op("stale") });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "stale_owner_operation");
    assert.equal(world.amendments(id), 0, "rev3 must not be approved from a verification of rev2");
    assert.equal(world.broker.calls.length, 1, "the prompt did happen — it is the WRITE that must not");

    // The verification is spent on the stale attempt. Approving rev3 requires a
    // new review and a new prompt.
    world.broker.duringPrompt = null;
    const retry = await world.act({ id, action: "approve", operation_id: op("stale-2") });
    assert.equal(retry.status, 200);
    assert.equal(world.broker.calls.length, 2, "a fresh ruling costs a fresh verification");
    assert.match(world.file(id), /rev3/);
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// Idempotency — checked BEFORE the prompt
// ---------------------------------------------------------------------------

test("acceptance: a retried operation replays without prompting or writing again", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const body = { id, action: "reply_done", operation_id: op("retry") };

    const first = await world.act(body);
    assert.equal(first.status, 200);
    assert.equal(world.broker.calls.length, 1);
    assert.equal(world.amendments(id), 1);

    // The response was lost; she clicks again. Same intent, same id.
    const second = await world.act(body);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(world.broker.calls.length, 1, "prompt_count delta must be 0");
    assert.equal(world.amendments(id), 1, "mutation_count delta must be 0");
    assert.equal(second.body.ruling_ref, first.body.ruling_ref, "a replay returns the original ruling");
  } finally { await world.close(); }
});

test("acceptance: the same operation id meaning something else is a collision, not a ruling", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    await world.act({ id, action: "reply_done", operation_id: op("collide") });
    assert.equal(world.amendments(id), 1);

    const collision = await world.act({ id, action: "dismiss", operation_id: op("collide") });
    assert.equal(collision.status, 409);
    assert.equal(collision.body.error, "idempotency_collision");
    assert.equal(world.broker.calls.length, 1, "a collision must not cost a prompt");
    assert.equal(world.amendments(id), 1, "a collision must not write");
  } finally { await world.close(); }
});

test("acceptance: a crash between the amendment and the journal commit does not double-apply", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const body = { id, action: "reply_no", operation_id: op("crash") };
    const first = await world.act(body);
    assert.equal(first.status, 200);
    assert.equal(world.amendments(id), 1);

    // Simulate the crash window: the exception was amended, the journal never
    // reached `committed`. This is the case where a naive retry appends her
    // ruling twice.
    const journalFile = path.join(world.dir, "state", "owner-rulings.json");
    const entries = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    entries[0] = { ...entries[0], phase: "preparing" };
    delete entries[0].result;
    fs.writeFileSync(journalFile, JSON.stringify(entries, null, 2));

    // A new process starts and recovers.
    const recoveredDeps = world.server.createOwnerRulingDeps({
      verifier: world.deps.verifier, now: world.deps.now, journalFile,
    });
    assert.deepEqual(recoveredDeps.recovered, [{ operation_id: op("crash"), outcome: "rolled_forward" }]);
    assert.equal(recoveredDeps.journal.completed(op("crash")).phase, "committed");
    assert.equal(world.amendments(id), 1, "recovery must roll forward, never re-apply");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// The prompt surface — what must never be able to raise a dialog
// ---------------------------------------------------------------------------

test("acceptance: nothing cheap can raise a prompt or spend prompt budget", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const cases = [
      ["foreign origin", () => world.act({ id, action: "dismiss", operation_id: op("x1") }, { origin: "https://evil.example" }), 403],
      ["wrong content type", () => world.act({ id, action: "dismiss", operation_id: op("x2") }, { contentType: "text/plain" }), 415],
      ["GET", () => world.act(null, { method: "GET" }), 404],
      ["invalid action", () => world.act({ id, action: "resolve_everything", operation_id: op("x3") }), 400],
      ["generic reply", () => world.act({ id, action: "reply", note: "Done", operation_id: op("x4") }), 400],
      ["missing exception", () => world.act({ id: "no-such-exception", action: "dismiss", operation_id: op("x5") }), 404],
      ["no operation id", () => world.act({ id, action: "dismiss" }), 400],
      ["defer without a time", () => world.act({ id, action: "defer", operation_id: op("x6") }), 400],
      ["empty editable reply", () => world.act({ id, action: "reply_need_context", note: "   ", operation_id: op("x7") }), 400],
    ];

    for (const [label, run, expected] of cases) {
      const result = await run();
      assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.body)}`);
      assert.equal(world.broker.calls.length, 0, `${label} raised a prompt`);
      assert.equal(world.amendments(id), 0, `${label} wrote`);
    }

    // And the budget was never touched, so a real ruling still works at once.
    const real = await world.act({ id, action: "dismiss", operation_id: op("real") });
    assert.equal(real.status, 200);
    assert.equal(world.broker.calls.length, 1);
  } finally { await world.close(); }
});

test("acceptance: a browser cannot claim it was verified", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    world.broker.outcomeValue = "cancelled";

    const result = await world.act({
      id, action: "dismiss", operation_id: op("claim"),
      verified: true, owner: true, windowsHelloPassed: true,
      verification_token: "trust-me", presence: { outcome: "verified" },
    });
    assert.equal(result.body.mutation_performed, false);
    assert.equal(world.amendments(id), 0, "a claimed verification must not substitute for one");
  } finally { await world.close(); }
});

test("acceptance: repeated non-verified attempts cool down and then lock out", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    world.broker.outcomeValue = "cancelled";

    // 1st cancellation → cooldown.
    assert.equal((await world.act({ id, action: "dismiss", operation_id: op("b1") })).body.error, "cancelled");
    const immediate = await world.act({ id, action: "dismiss", operation_id: op("b2") });
    assert.equal(immediate.status, 429);
    assert.equal(immediate.body.error, "prompt_cooldown");
    assert.equal(world.broker.calls.length, 1, "a cooling-down request must not reach the device");

    // Wait it out twice more; three non-verified prompts inside a minute is a
    // pattern, not an accident.
    world.advance(11000);
    assert.equal((await world.act({ id, action: "dismiss", operation_id: op("b3") })).body.error, "cancelled");
    world.advance(11000);
    assert.equal((await world.act({ id, action: "dismiss", operation_id: op("b4") })).body.error, "cancelled");
    assert.equal(world.broker.calls.length, 3);

    world.advance(11000);
    const locked = await world.act({ id, action: "dismiss", operation_id: op("b5") });
    assert.equal(locked.body.error, "prompt_lockout");
    assert.equal(world.broker.calls.length, 3, "a lockout must stop reaching the device entirely");
    assert.ok(locked.body.retry_after_ms > 60000);

    // The lockout is bounded — it protects her from a dialog storm, it does not
    // lock her out of her own inbox forever.
    world.advance(5 * 60 * 1000 + 1000);
    world.broker.outcomeValue = "verified";
    const recovered = await world.act({ id, action: "dismiss", operation_id: op("b6") });
    assert.equal(recovered.status, 200);
    assert.equal(world.amendments(id), 1);
  } finally { await world.close(); }
});

test("acceptance: reads are unaffected by any of this", async () => {
  const world = await acceptanceWorld();
  try {
    const response = await fetch(`http://127.0.0.1:${world.port}/api/decisions`);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).decisions));
    assert.equal(world.broker.calls.length, 0, "reading her briefing must never prompt her");
  } finally { await world.close(); }
});

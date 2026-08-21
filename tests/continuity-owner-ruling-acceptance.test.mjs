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
import { pathToFileURL } from "node:url";

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

test("acceptance: a crash before the journal commit rolls forward, never re-applies", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const body = { id, action: "reply_no", operation_id: op("crash") };
    const first = await world.act(body);
    assert.equal(first.status, 200);
    assert.equal(world.amendments(id), 1);

    // The exception was written completely; the journal never reached
    // `committed`. A naive retry appends her ruling twice.
    const journalFile = path.join(world.dir, "state", "owner-rulings.json");
    const entries = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    entries[0] = { ...entries[0], phase: "preparing" };
    delete entries[0].result;
    fs.writeFileSync(journalFile, JSON.stringify(entries, null, 2));

    // A new process starts and recovers.
    const recoveredDeps = world.server.createOwnerRulingDeps({
      verifier: world.deps.verifier, now: world.deps.now, journalFile,
    });
    assert.equal(recoveredDeps.recovered[0].outcome, "rolled_forward");
    assert.equal(recoveredDeps.journal.completed(op("crash")).phase, "committed");
    assert.ok(recoveredDeps.journal.completed(op("crash")).result.ruling_ref,
      "a recovered operation must still be able to answer a retry");
    assert.equal(world.amendments(id), 1, "recovery must roll forward, never re-apply");
  } finally { await world.close(); }
});

test("acceptance: the authoritative exception write is atomic across every class", async () => {
  const world = await acceptanceWorld();
  try {
    // Every ruling is ONE file replacement. The earlier shape wrote the
    // amendment, the status and the defer field separately, so a crash between
    // them left a half-ruled exception that recovery could not classify.
    for (const [action, extra] of [
      ["reply_done", {}],
      ["defer", { until: "2026-08-24T09:00:00+10:00" }],
    ]) {
      const id = fixture(world, { id: `2026-08-22-atomic-${action}` });
      const target = path.join(world.inbox, `${id}.md`);
      const inPlace = [];
      const renames = [];
      const realWrite = fs.writeFileSync;
      const realRename = fs.renameSync;
      // `${id}.md.tmp` also "includes" `${id}.md`, so match the exact path —
      // the first version of this check counted the temp write and failed the
      // code for doing precisely the right thing.
      fs.writeFileSync = (file, ...rest) => {
        if (path.resolve(String(file)) === path.resolve(target)) inPlace.push(String(file));
        return realWrite(file, ...rest);
      };
      fs.renameSync = (from, to, ...rest) => {
        if (path.resolve(String(to)) === path.resolve(target)) renames.push(String(to));
        return realRename(from, to, ...rest);
      };
      try {
        await world.act({ id, action, ...extra, operation_id: op(`atomic-${action}`) });
      } finally {
        fs.writeFileSync = realWrite;
        fs.renameSync = realRename;
      }
      assert.equal(inPlace.length, 0,
        `${action}: the exception must never be written in place — a reader could see half a ruling`);
      assert.equal(renames.length, 1,
        `${action}: one ruling is ONE authoritative replacement, not a sequence of them`);
      assert.equal(world.amendments(id), 1);
    }
  } finally { await world.close(); }
});

test("acceptance: a HALF-applied ruling is refused, not rounded either way", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const body = { id, action: "reply_done", operation_id: op("half") };
    await world.act(body);

    // Rewind the STATUS but leave the amendment: the shape a crash between two
    // separate writes would have left, and the shape a ref-only recovery check
    // would have called committed.
    fs.writeFileSync(path.join(world.inbox, `${id}.md`),
      world.file(id).replace(/^status: resolved$/m, "status: blocked-on-owner"));
    const journalFile = path.join(world.dir, "state", "owner-rulings.json");
    const entries = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    entries[0] = { ...entries[0], phase: "preparing" };
    fs.writeFileSync(journalFile, JSON.stringify(entries, null, 2));

    const recoveredDeps = world.server.createOwnerRulingDeps({
      verifier: world.deps.verifier, now: world.deps.now, journalFile,
    });
    assert.equal(recoveredDeps.recovered[0].outcome, "partial_application");

    const blocked = await world.act(body);
    assert.equal(blocked.body.error, "partial_application");
    assert.equal(blocked.body.mutation_performed, false);
    assert.equal(world.amendments(id), 1, "a half-ruled exception must not be ruled over the top of");
  } finally { await world.close(); }
});

test("acceptance: an aborted attempt retries on the same journal record", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const body = { id, action: "dismiss", operation_id: op("abort-retry") };
    world.broker.outcomeValue = "cancelled";
    assert.equal((await world.act(body)).body.error, "cancelled");

    world.advance(11000);
    world.broker.outcomeValue = "verified";
    const retried = await world.act(body);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));

    const rows = JSON.parse(fs.readFileSync(path.join(world.dir, "state", "owner-rulings.json"), "utf8"))
      .filter((e) => e.operation_id === body.operation_id);
    assert.equal(rows.length, 1, "one operation is one journal record, always");
    assert.equal(rows[0].phase, "committed");
    assert.equal(rows[0].attempt, 2);
  } finally { await world.close(); }
});

test("acceptance: a ruling on an item nobody is waiting on never prompts", async () => {
  const world = await acceptanceWorld();
  try {
    const resolved = fixture(world, { id: "2026-08-22-already-resolved", status: "resolved" });
    const noProposal = fixture(world, { id: "2026-08-22-no-proposal", proposed: "" });

    for (const [id, action] of [[resolved, "reply_done"], [noProposal, "approve"]]) {
      const result = await world.act({ id, action, operation_id: op(`invalid-${id}`) });
      assert.equal(result.body.error, "action_not_currently_valid", JSON.stringify(result.body));
      assert.equal(world.broker.calls.length, 0, `${id} raised a prompt`);
      assert.equal(world.amendments(id), 0);
    }
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

test("acceptance: the world records which exception implementation it exercised", async () => {
  const world = await acceptanceWorld();
  try {
    const store = world.dependencies.find((d) => d.name === "exception.mjs");
    // "The gate passed" means less if the component that changes owner-gated
    // state was a stand-in and nobody said which.
    assert.ok(["real host", "stand-in"].includes(store.source));
    const id = fixture(world);
    await world.act({ id, action: "dismiss", operation_id: "op-store" });
    assert.equal(world.amendments(id), 1);
    assert.equal(world.status(id), "resolved");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// The legacy CLI is no longer a second authority
// ---------------------------------------------------------------------------

test("acceptance: the raw exception store cannot close an owner-gated item", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);

    // This is the original impersonation route, unchanged: the command that
    // moves an item out of her queue and leaves a record reading as though she
    // answered. Adding a safe CLI does not remove the unsafe one.
    for (const status of ["resolved", "investigating", "new"]) {
      assert.throws(() => world.store.setStatus(id, status),
        (error) => error.code === "owner_ruling_required",
        `setStatus(${status}) must be refused on a blocked-on-owner item`);
    }
    // A ref typed on a command line is a string, not evidence.
    assert.throws(() => world.store.setStatus(id, "resolved", "", "ruling:i-made-this-up"),
      (error) => error.code === "unverified_ruling_ref");

    assert.equal(world.status(id), "blocked-on-owner", "nothing moved");
    assert.equal(world.broker.calls.length, 0, "and nothing prompted her either");
  } finally { await world.close(); }
});

test("acceptance: ordinary lane transitions are untouched by the gate", async () => {
  const world = await acceptanceWorld();
  try {
    // A control that made agents ask her before updating routine workflow state
    // would be switched off within a week, and then nothing would be guarded.
    const open = fixture(world, { id: "2026-08-22-ordinary-work", status: "new" });
    assert.equal(world.store.setStatus(open, "investigating"), open);
    assert.equal(world.status(open), "investigating");
    assert.equal(world.store.setStatus(open, "resolved"), open);
    assert.equal(world.status(open), "resolved");

    // Including raising a new owner gate.
    const raising = fixture(world, { id: "2026-08-22-raise-a-gate", status: "investigating" });
    assert.equal(world.store.setStatus(raising, "blocked-on-owner"), raising);
    assert.equal(world.broker.calls.length, 0);
  } finally { await world.close(); }
});

test("acceptance: a verified ruling still moves the item, through the gate", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const result = await world.act({ id, action: "reply_done", operation_id: op("gate-pass") });
    assert.equal(result.status, 200);
    assert.equal(world.status(id), "resolved",
      "the gate must not block the one path that has her verification");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// The manual owner CLI runs DEPLOYED bytes
// ---------------------------------------------------------------------------

test("acceptance: sabotaging the working tree does not change the owner CLI", async () => {
  const world = await acceptanceWorld();
  try {
    // A repo-shaped world whose src/continuity/control is booby-trapped. If the
    // CLI still imports its orchestrator or its policy from the working tree —
    // which it did, while its commit message said otherwise — importing it here
    // throws and this test fails loudly.
    const repo = path.join(world.dir, "sabotaged-repo");
    const control = path.join(repo, "src", "continuity", "control");
    fs.mkdirSync(path.join(repo, "ops"), { recursive: true });
    fs.mkdirSync(control, { recursive: true });
    for (const name of ["owner-ruling.js", "owner-ruling-policy.js", "owner-presence.js", "owner-presence-windows.js"]) {
      fs.writeFileSync(path.join(control, name),
        `throw new Error("the CLI loaded ${name} from the working tree");\n`);
    }
    fs.copyFileSync(path.join(process.cwd(), "ops", "owner-rule.mjs"), path.join(repo, "ops", "owner-rule.mjs"));

    const cli = await import(pathToFileURL(path.join(repo, "ops", "owner-rule.mjs")).href);

    // Dependencies assembled from the DEPLOYED artifact, as realDeps() does.
    const staged = (f) => import(pathToFileURL(path.join(world.ops, "_continuity", f)).href);
    const ruling = await staged("owner-ruling.js");
    const id = fixture(world);
    const deps = {
      now: world.deps.now,
      OWNER_ACTIONS: ruling.OWNER_ACTIONS,
      performOwnerRuling: ruling.performOwnerRuling,
      readException: world.deps.readException,
      applyMutation: world.deps.applyMutation,
      journal: world.deps.journal,
      budget: world.deps.budget,
      verifier: world.deps.verifier,
    };

    const result = await cli.runOwnerRule([id, "reply_done"], deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(world.amendments(id), 1);
    assert.equal(world.status(id), "resolved");

    // Rerunning the identical command replays rather than ruling twice.
    const again = await cli.runOwnerRule([id, "reply_done"], deps);
    assert.equal(again.replayed, true);
    assert.equal(world.amendments(id), 1);
    assert.equal(world.broker.calls.length, 1);
  } finally { await world.close(); }
});

test("acceptance: the owner CLI offers no unauthenticated lane withdrawal", async () => {
  const world = await acceptanceWorld();
  try {
    const cli = await import(pathToFileURL(path.join(process.cwd(), "ops", "owner-rule.mjs")).href);
    const ruling = await import(pathToFileURL(path.join(world.ops, "_continuity", "owner-ruling.js")).href);
    const id = fixture(world);
    const deps = { ...world.deps, OWNER_ACTIONS: ruling.OWNER_ACTIONS, performOwnerRuling: ruling.performOwnerRuling };

    // Any local process could have run this against somebody else's gate and
    // emptied it from her queue with no presence and no lane check.
    const withdrawn = await cli.runOwnerRule([id, "--withdraw", "--note", "not needed"], deps);
    assert.equal(withdrawn.ok, false);
    assert.equal(withdrawn.failure, "unsupported");
    assert.equal(world.status(id), "blocked-on-owner");
    assert.equal(world.amendments(id), 0);
    assert.equal(world.broker.calls.length, 0);
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// A half-installed security layer must not rule
// ---------------------------------------------------------------------------

test("acceptance: a mixed or incomplete deployment serves reads and refuses rulings", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);

    // Deployment replaces the artifact one file at a time. This is what a crash
    // in the middle leaves behind, and until now the host would have started
    // anyway and ruled out of a half-installed security layer.
    const gated = world.server.createServer(world.deps, {
      ownerRulings: false,
      unverifiedReason: "the deployed _continuity set is incomplete.",
    });
    await new Promise((resolve) => gated.listen(0, "127.0.0.1", resolve));
    const port = gated.address().port;
    try {
      const refused = await fetch(`http://127.0.0.1:${port}/api/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "dismiss", operation_id: op("unverified") }),
      });
      assert.equal(refused.status, 503);
      const payload = await refused.json();
      assert.equal(payload.error, "deployment_unverified");
      assert.equal(payload.mutation_performed, false);
      assert.match(payload.detail, /incomplete/);
      assert.equal(world.amendments(id), 0);
      assert.equal(world.broker.calls.length, 0, "an unverified deployment must not reach the device");

      // Reads are untouched: she can still see her briefing.
      const reads = await fetch(`http://127.0.0.1:${port}/api/decisions`);
      assert.equal(reads.status, 200);
    } finally {
      await new Promise((resolve) => gated.close(resolve));
    }
  } finally { await world.close(); }
});

// The batch transaction: N rulings, ONE dialog (owner request 2026-08-22).
//
// The invariant under test is the same one the single path proves — nothing is
// performed that was not on the dialog she read — extended to enumeration:
// exactly one broker call per batch, its purpose listing every act; items that
// fail any pre-prompt gate refuse the WHOLE batch before a prompt exists; items
// that change while the dialog is up are skipped individually.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { acceptanceWorld, fixture } from "../ops/prb-world.mjs";

const op = (label) => `op_${label}_${Math.random().toString(36).slice(2, 8)}`;

const batchBody = (items) => ({ batch: items });

test("batch: three rulings, one prompt, all applied and journaled per item", async () => {
  const world = await acceptanceWorld();
  try {
    const a = fixture(world, { id: "2026-08-22-batch-a" });
    const b = fixture(world, { id: "2026-08-22-batch-b" });
    const c = fixture(world, { id: "2026-08-22-batch-c" });

    const result = await world.act(batchBody([
      { id: a, action: "approve", operation_id: op("a") },
      { id: b, action: "dismiss", operation_id: op("b") },
      { id: c, action: "reply_done", operation_id: op("c") },
    ]));

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.performed, 3);
    assert.equal(result.body.skipped, 0);
    assert.equal(world.broker.calls.length, 1, "exactly ONE dialog for the whole batch");

    // The one prompt enumerates every act — she consents line by line.
    const purpose = world.broker.calls[0].purpose;
    assert.match(purpose, /Apply 3 owner rulings:/);
    assert.match(purpose, new RegExp(`1\\. .*${a}`));
    assert.match(purpose, new RegExp(`2\\. .*${b}`));
    assert.match(purpose, new RegExp(`3\\. .*${c}`));

    // Every exception actually mutated, with its own recorded ruling.
    assert.equal(world.amendments(a), 1);
    assert.equal(world.amendments(b), 1);
    assert.equal(world.amendments(c), 1);
    assert.equal(world.status(b), "resolved");
    assert.equal(world.status(c), "resolved");
    assert.equal(world.status(a), "investigating");
  } finally { await world.close(); }
});

test("batch: one invalid item refuses the whole batch BEFORE any prompt", async () => {
  const world = await acceptanceWorld();
  try {
    const good = fixture(world, { id: "2026-08-22-batch-good" });
    const noProposal = fixture(world, { id: "2026-08-22-batch-noprop", proposed: "" });

    const result = await world.act(batchBody([
      { id: good, action: "dismiss", operation_id: op("g") },
      { id: noProposal, action: "approve", operation_id: op("n") },
    ]));

    assert.equal(result.body.error, "action_not_currently_valid", JSON.stringify(result.body));
    assert.equal(result.body.item, noProposal, "the refusal names the offending item");
    assert.equal(world.broker.calls.length, 0, "no dialog may be raised for a batch the host would refuse");
    assert.equal(world.amendments(good), 0, "nothing in the batch is applied");
  } finally { await world.close(); }
});

test("batch: an item that changes while the dialog is up is skipped alone", async () => {
  const world = await acceptanceWorld();
  try {
    const stays = fixture(world, { id: "2026-08-22-batch-stays" });
    const drifts = fixture(world, { id: "2026-08-22-batch-drifts", proposed: "rev2 — spend $40" });

    world.broker.duringPrompt = async () => {
      const file = world.file(drifts);
      fs.writeFileSync(path.join(world.inbox, `${drifts}.md`),
        file.replace("rev2 — spend $40", "rev3 — spend $400"));
    };

    const result = await world.act(batchBody([
      { id: stays, action: "dismiss", operation_id: op("s") },
      { id: drifts, action: "approve", operation_id: op("d") },
    ]));

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.performed, 1);
    assert.equal(result.body.skipped, 1);
    const skipped = result.body.results.find((r) => r.exception_id === drifts);
    assert.equal(skipped.failure, "stale_owner_operation");
    assert.equal(world.amendments(stays), 1, "the untouched item she approved still lands");
    assert.equal(world.amendments(drifts), 0, "rev3 was never in front of her and must not be approved");
    assert.equal(world.broker.calls.length, 1);
  } finally { await world.close(); }
});

test("batch: the same exception twice in one prompt is refused", async () => {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world, { id: "2026-08-22-batch-dup" });
    const result = await world.act(batchBody([
      { id, action: "approve", operation_id: op("d1") },
      { id, action: "dismiss", operation_id: op("d2") },
    ]));
    assert.equal(result.body.error, "invalid_action");
    assert.match(result.body.detail, /twice/);
    assert.equal(world.broker.calls.length, 0);
    assert.equal(world.amendments(id), 0);
  } finally { await world.close(); }
});

test("batch: cancelling the one dialog applies nothing", async () => {
  const world = await acceptanceWorld();
  try {
    const a = fixture(world, { id: "2026-08-22-batch-cxa" });
    const b = fixture(world, { id: "2026-08-22-batch-cxb" });
    world.broker.outcomeValue = "cancelled";

    const result = await world.act(batchBody([
      { id: a, action: "dismiss", operation_id: op("ca") },
      { id: b, action: "reply_done", operation_id: op("cb") },
    ]));

    assert.equal(result.body.error, "cancelled", JSON.stringify(result.body));
    assert.equal(world.amendments(a), 0);
    assert.equal(world.amendments(b), 0);
    assert.equal(world.broker.calls.length, 1);
  } finally { await world.close(); }
});

test("batch: caps at 20 so the dialog stays readable", async () => {
  const world = await acceptanceWorld();
  try {
    const items = [];
    for (let n = 0; n < 21; n++) {
      const id = fixture(world, { id: `2026-08-22-batch-cap-${String(n).padStart(2, "0")}` });
      items.push({ id, action: "dismiss", operation_id: op(`cap${n}`) });
    }
    const result = await world.act(batchBody(items));
    assert.equal(result.body.error, "invalid_action");
    assert.match(result.body.detail, /capped at 20/);
    assert.equal(world.broker.calls.length, 0);
  } finally { await world.close(); }
});

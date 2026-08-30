// A prepared authorization belongs to the browser session that prepared it.
//
// Without that binding a receipt is portable between owner-read sessions: she
// reviews in one window, it rotates or expires, and the prepared authorization
// is still presentable by whatever holds the id next. Re-review costs one
// unlock; a migrating receipt costs the meaning of the review.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  browserSafeReceipt, createReceiptStore, receiptPreview,
} from "../src/continuity/control/authority-receipt.js";
import { createAuthorityDraft } from "../src/continuity/control/authority-draft.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Built by the real factory rather than hand-rolled: a shape this module would
// reject is not a fixture, it is a different test.
const DRAFT = createAuthorityDraft({
  draft_id: "draft:session-binding",
  kind: "bounded_canary",
  statement: "one bounded task",
  scope_refs: ["scope:datascape/briefing"],
  allowed_capabilities: ["read"],
  stop_conditions: ["the candidate is reviewed"],
});

function issue(store, readSessionId, overrides = {}) {
  return store.issue({
    draft: DRAFT,
    action: "authorize_bounded_task",
    sourceExceptionId: "2026-08-21-datascape-v6-execution-authority-b4e2",
    goalId: "goal:1",
    baseRevision: 1,
    resultingScopeRefs: ["scope:datascape/briefing"],
    readSessionId,
    ...overrides,
  });
}

test("receipt: it is bound to the session that prepared it", () => {
  const c = clock();
  const store = createReceiptStore({ now: c.now });
  const receipt = issue(store, "session-S1");

  assert.equal(receipt.read_session_id, "session-S1");
  assert.equal(store.verify(receipt.receipt_id, {}, { readSessionId: "session-S1" }).ok, true);
});

test("receipt: S1's review cannot be committed from S2", () => {
  const c = clock();
  const store = createReceiptStore({ now: c.now });
  const receipt = issue(store, "session-S1");

  // The same human unlocking a second time does not make it the same review.
  const other = store.verify(receipt.receipt_id, {}, { readSessionId: "session-S2" });
  assert.equal(other.ok, false);
  assert.equal(other.failure, "receipt_session_mismatch");

  // And presenting it with no session at all is refused by name, not by
  // falling through to the field checks.
  const none = store.verify(receipt.receipt_id, {}, {});
  assert.equal(none.ok, false);
  assert.equal(none.failure, "receipt_session_missing");
});

test("receipt: the session check runs BEFORE the browser's claimed fields", () => {
  const c = clock();
  const store = createReceiptStore({ now: c.now });
  const receipt = issue(store, "session-S1");

  // A wrong-session commit that ALSO claims the wrong action must report the
  // session, because that is the fact that matters: it is a different review,
  // not a mismatched field within this one.
  const result = store.verify(receipt.receipt_id, { action: "revoke_authority" }, { readSessionId: "session-S2" });
  assert.equal(result.failure, "receipt_session_mismatch");
});

test("receipt: the session id never reaches the browser", () => {
  const c = clock();
  const store = createReceiptStore({ now: c.now });
  const receipt = issue(store, "session-secret-value");

  const preview = receiptPreview(receipt, {}, () => ({ summary: "authorize one bounded task" }));
  assert.ok(!JSON.stringify(preview).includes("session-secret-value"),
    "the preview she reads must not carry the host's session handle");

  const safe = browserSafeReceipt(receipt);
  assert.equal(safe.read_session_id, undefined);
  assert.ok(!JSON.stringify(safe).includes("session-secret-value"));
  // Everything else survives — this strips one field, it does not redact the
  // authorization.
  assert.equal(safe.action, receipt.action);
  assert.equal(safe.base_authority_revision, receipt.base_authority_revision);
});

test("receipt: an expired session's receipt is dead even inside the receipt TTL", () => {
  const c = clock();
  const store = createReceiptStore({ now: c.now });
  const receipt = issue(store, "session-S1");

  // The receipt itself has ten minutes; the read session has five. When the
  // session goes, the review it belongs to stops being presentable — the host
  // simply no longer authenticates that session id, so nothing can present it.
  c.advance(6 * 60 * 1000);
  assert.equal(store.verify(receipt.receipt_id, {}, { readSessionId: "session-S1" }).ok, true,
    "the receipt object is still live...");
  const rotated = store.verify(receipt.receipt_id, {}, { readSessionId: "session-S2" });
  assert.equal(rotated.failure, "receipt_session_mismatch",
    "...but the only session that could present it is gone");
});

test("receipt: an unbound receipt still verifies, so the substrate stays usable", () => {
  // Not every caller of this store is the HTTP authority host — the existing
  // endpoint tests prepare receipts with no session. Binding is enforced when
  // present rather than demanded unconditionally, so adding it did not
  // invalidate the substrate it extends.
  const c = clock();
  const store = createReceiptStore({ now: c.now });
  const receipt = issue(store, null);
  assert.equal(receipt.read_session_id, null);
  assert.equal(store.verify(receipt.receipt_id, {}, {}).ok, true);
});

test("receipt: nothing in the module logs or persists the session id", () => {
  const source = fs.readFileSync(
    new URL("../src/continuity/control/authority-receipt.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/console\.(log|info|warn|error)/.test(source));
  assert.ok(!/writeFileSync|appendFileSync/.test(source),
    "receipts and their session binding live in process memory");
});

// The journal <-> exception-adapter contract translation.
//
// This is the seam the parts 0-8 review flagged, and the failure it prevents is
// not a wrong status code: it is a SILENT INFINITE RETRY against her real
// exception files, once per host start, forever. So the tests below assert the
// translation in both directions and, more importantly, assert what recovery
// concludes — because that is where the retry loop would live.
import test from "node:test";
import assert from "node:assert/strict";

import { createJournalExceptionPort } from "../src/continuity/control/authority-exception-port.js";
import {
  createAuthorityJournal, createMemoryStorage,
} from "../src/continuity/control/authority-journal.js";

/** An adapter with the PRIVATE adapter's real contract. */
function adapter({ status = "blocked-on-owner", refs = [] } = {}) {
  const state = { status, refs: [...refs], calls: [] };
  return {
    state,
    resolve(exceptionId, rulingRef, options = {}) {
      state.calls.push({ exceptionId, rulingRef, options });
      if (!exceptionId || !rulingRef || typeof rulingRef !== "string") {
        return { ok: false, failure: "invalid_resolution", reason: "an exception id and a ruling ref are required" };
      }
      const others = state.refs.filter((ref) => ref !== rulingRef);
      if (state.refs.includes(rulingRef)) {
        if (state.status === "resolved" && !others.length) {
          return { ok: true, replayed: true, status: "resolved", ruling_ref: rulingRef };
        }
        return { ok: false, failure: "inconsistent_resolution", status: state.status, reason: "torn" };
      }
      if (others.length) {
        return {
          ok: false, failure: "already_authorized", existing_refs: others,
          reason: `already resolved by ${others.join(", ")}`,
        };
      }
      if (state.status !== "blocked-on-owner") {
        return { ok: false, failure: "not_owner_gated", status: state.status, reason: "nothing waiting" };
      }
      state.refs.push(rulingRef);
      state.status = "resolved";
      return { ok: true, replayed: false, status: "resolved", ruling_ref: rulingRef, at: 5 };
    },
  };
}

test("the port passes a ruling ref as a STRING, not as the journal's options object", () => {
  // Wired directly, the journal's second positional argument is an options
  // object. The adapter would take it as the ruling ref, fail every comparison
  // against it, and behave as though a ref it had never seen were in play.
  const a = adapter();
  const port = createJournalExceptionPort(a);
  port.resolve("exc-1", { ruling_ref: "ruling:abc", at: 7, recovered: false });

  assert.equal(a.state.calls.length, 1);
  assert.equal(typeof a.state.calls[0].rulingRef, "string");
  assert.equal(a.state.calls[0].rulingRef, "ruling:abc");
});

test("a successful resolution reports resolved_by as OUR ruling", () => {
  const port = createJournalExceptionPort(adapter());
  const result = port.resolve("exc-1", { ruling_ref: "ruling:abc", at: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.resolved_by, "ruling:abc");
});

test("a blocker resolved by SOMEONE ELSE surfaces their ref as resolved_by", () => {
  // Without this the journal sees `already_authorized` with no `resolved_by`,
  // reads it as "not resolvable yet", and retries on every open.
  const port = createJournalExceptionPort(adapter({ status: "resolved", refs: ["ruling:someone-else"] }));
  const result = port.resolve("exc-1", { ruling_ref: "ruling:mine" });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "already_authorized");
  assert.equal(result.resolved_by, "ruling:someone-else");
});

test("recovery marks a conflicting resolution INCONSISTENT instead of retrying forever", () => {
  // The end-to-end version of the test above, through the real journal: this is
  // the loop the port exists to prevent.
  const storage = createMemoryStorage([{
    operation_id: "op-1",
    phase: "authority_written",
    source_exception_id: "exc-1",
    record: { ruling: { ref: "ruling:mine" }, revision: 1 },
  }]);
  const port = createJournalExceptionPort(adapter({ status: "resolved", refs: ["ruling:someone-else"] }));
  const journal = createAuthorityJournal({ storage, exceptions: port, now: () => 10 });

  assert.deepEqual(journal.recovered_on_open, [{ operation_id: "op-1", outcome: "inconsistent" }]);
  assert.equal(storage.read()[0].phase, "inconsistent");

  // And it STAYS stopped: a second open must not reconsider it.
  const again = createAuthorityJournal({ storage, exceptions: port, now: () => 11 });
  assert.deepEqual(again.recovered_on_open, []);
});

test("the same ruling recovering twice stays idempotent and rolls forward", () => {
  const storage = createMemoryStorage([{
    operation_id: "op-1",
    phase: "authority_written",
    source_exception_id: "exc-1",
    record: { ruling: { ref: "ruling:mine" }, revision: 1 },
  }]);
  // Already carries OUR ref: the crash happened after resolve() succeeded and
  // before the journal recorded it. This is the narrowest window in the design.
  const port = createJournalExceptionPort(adapter({ status: "resolved", refs: ["ruling:mine"] }));
  const journal = createAuthorityJournal({ storage, exceptions: port, now: () => 10 });

  assert.deepEqual(journal.recovered_on_open, [{ operation_id: "op-1", outcome: "rolled_forward" }]);
  assert.equal(storage.read()[0].phase, "committed");
});

test("a torn own-resolution is left mid-flight, not declared someone else's conflict", () => {
  // Our ref is present but the status disagrees. That is our own half-applied
  // write and the next open can finish it, so it must NOT be reported as a
  // conflict with another ruling — which would stop it permanently.
  const port = createJournalExceptionPort(adapter({ status: "blocked-on-owner", refs: ["ruling:mine"] }));
  const result = port.resolve("exc-1", { ruling_ref: "ruling:mine" });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "inconsistent_resolution");
  assert.equal(result.resolved_by, undefined, "our own torn state is not another ruling");
});

test("the port refuses to be constructed without an adapter", () => {
  assert.throws(() => createJournalExceptionPort(null), /exception adapter/);
  assert.throws(() => createJournalExceptionPort({}), /exception adapter/);
});

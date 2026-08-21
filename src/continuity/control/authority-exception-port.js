// The ONE place the authority journal and the private exception adapter meet.
//
// They were written to different contracts and the difference is not cosmetic.
// The journal calls:
//
//   exceptions.resolve(id, { ruling_ref, at, recovered })
//
// and detects a conflicting recovery by reading `resolution.resolved_by`.
// The adapter exposes:
//
//   resolve(exceptionId, rulingRef, { note })
//
// and reports a conflict as `already_authorized` with `existing_refs`.
//
// Injected into each other directly, the second positional argument would
// arrive as an options OBJECT where a ruling ref string was expected. It would
// fail the ref comparison, fall through to "not mine", and — for a blocker
// somebody else had already resolved — return a failure the journal does not
// recognise as a conflict. Recovery would then read it as "still not
// resolvable" and RETRY IT FOREVER, on every host start, rather than marking
// the transaction inconsistent and stopping.
//
// That is a silent infinite retry against her real exception store, so this
// translation is written once, here, and tested against both contracts.

/**
 * Adapt a private exception adapter to the journal's `exceptions` interface.
 *
 * The port is deliberately narrow: `resolve` and `isResolved`. The journal asks
 * for nothing else, and anything wider would be a second way to reach her
 * exception files.
 */
export function createJournalExceptionPort(adapter) {
  if (!adapter || typeof adapter.resolve !== "function") {
    throw new Error("the journal exception port requires an exception adapter");
  }

  return {
    /**
     * The journal's calling convention, translated.
     *
     * `recovered` is accepted and deliberately NOT forwarded as behaviour: a
     * recovery resolve must be byte-identical to a first-attempt resolve, or
     * the "idempotent for the same ruling" property the journal depends on
     * would hold only on the path that never crashed.
     */
    resolve(exceptionId, { ruling_ref: rulingRef, at = null, recovered = false, note = "" } = {}) {
      const result = adapter.resolve(exceptionId, rulingRef, { note });

      if (result.ok) {
        // Whether this was a first write or a replay, the blocker now carries
        // OUR ruling — so `resolved_by` is ours and the journal sees no
        // conflict. Saying so explicitly beats leaving the field absent and
        // letting the journal's `&&` decide by accident.
        return { ...result, resolved_by: result.ruling_ref ?? rulingRef, recovered, at: result.at ?? at };
      }

      if (result.failure === "already_authorized") {
        // THE CASE THIS PORT EXISTS FOR. Surface the other ruling as
        // `resolved_by` so recovery marks the transaction inconsistent — fail
        // closed — instead of retrying a resolution that can never succeed.
        return { ...result, resolved_by: result.existing_refs?.[0] ?? "an unknown ruling" };
      }

      if (result.failure === "inconsistent_resolution") {
        // Our ref is present but the status disagrees: a half-applied write.
        // This must not read as a conflict with SOMEONE ELSE — it is our own
        // torn state — so `resolved_by` stays absent and the journal leaves the
        // entry mid-flight for the next open() to retry, which is correct here
        // because the next attempt can complete it.
        return { ...result };
      }

      return { ...result };
    },

    isResolved(exceptionId) {
      if (typeof adapter.isResolved === "function") return adapter.isResolved(exceptionId);
      return null;
    },
  };
}

/**
 * Adapt the authority journal to the commit path's `operations` interface.
 *
 * The commit path deliberately knows nothing about journal phases; it knows
 * `completed`, `claim`, `commit` and `abort`. Keeping that boundary means the
 * ordering in `authority-commit.js` stays readable as an ordering rather than
 * as journal bookkeeping.
 */
export function createCommitJournalPort({ journal, applyAuthority, currentRevision, revisionOf, now }) {
  return {
    completed(operationId) {
      const entry = journal.completed(operationId);
      // `receipt_id` travels with the replay because the replay check happens
      // BEFORE the receipt is looked up — a committed operation consumed its
      // receipt, so there is no object left to bind against. Carrying the id
      // lets the commit path tell a lost response apart from the same id
      // presented with a DIFFERENT prepared review, which would otherwise
      // replay a result for a change she never reviewed.
      return entry ? { result: entry.record, receipt_id: entry.receipt_id ?? null } : null;
    },

    claim(args) { return journal.claim(args); },

    /**
     * ONE durable transaction: the authority write, the exception resolution
     * and the committed marker.
     *
     * The final revision CAS lives INSIDE `build()`, which is the only point
     * atomic with the write. Every earlier check is a read, and a read that
     * happened before the Windows dialog cannot speak for the state after it.
     */
    async commit({ operation_id, receipt, expected_revision }) {
      const result = journal.transact({
        operation_id,
        source_exception_id: receipt.source_exception_id ?? null,
        build: () => {
          const observed = revisionOf(currentRevision(receipt));
          if (observed !== expected_revision) {
            return {
              ok: false, outcome: "stale_authority_revision",
              reason: "the authority changed between verification and commit; review again",
            };
          }
          return applyAuthority(receipt);
        },
      });

      if (result.ok) return { ok: true, result: result.record, authority_written: true };
      return {
        ok: false,
        failure: result.outcome || "transaction_failed",
        reason: result.reason,
        // A crash after the durable authority write leaves a record recovery
        // will roll forward, so this is not "nothing happened".
        authority_written: result.outcome === "crashed",
      };
    },

    abort(operationId, outcome) {
      // An operation that never reached `transact` is still holding a durable
      // claim. Releasing it as ABORTED rather than deleting it keeps the id
      // definitively spent: a refused verification must not be retryable by
      // anything that kept the id.
      if (typeof journal.abandon === "function") return journal.abandon(operationId, outcome);
      return null;
    },
    now,
  };
}

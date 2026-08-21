// The operation idempotency ledger — spec V6 §12.
//
// Recovery and retry must not duplicate side effects. The dangerous window is
// narrow and entirely real:
//
//   executor A performs the side effect
//   executor A dies BEFORE acknowledging it
//   lease expires
//   executor B recovers the intent
//   executor B sees "not acknowledged" and does it again
//
// Two PRs. Two comments. Two deploys. Eventually two payments. The fix is that
// intent to act is recorded BEFORE the act, so a resumed executor can tell the
// difference between "never started" and "started, outcome unknown" — and the
// second of those is never silently retried.

export const RECOVERABLE = "started";
export const COMPLETED = "completed";

export function createOperationLedger() {
  /** operation_id -> record */
  const records = new Map();

  return {
    /**
     * Declare intent to perform an externally meaningful action.
     *
     * Returns `{ proceed }`. If the operation was already completed, B observes
     * the completion and does NOT execute. If it was started but never
     * acknowledged, B does not execute either: it reports an indeterminate
     * outcome for reconciliation, because guessing here is how you get two.
     */
    begin(operationId, { executor_id, kind, at = null } = {}) {
      const existing = records.get(operationId);
      if (existing?.status === COMPLETED) {
        return { proceed: false, observed: existing, reason: "operation already completed" };
      }
      if (existing?.status === RECOVERABLE) {
        return {
          proceed: false,
          observed: existing,
          indeterminate: true,
          reason: "operation was started and never acknowledged; outcome must be reconciled, not repeated",
        };
      }
      const record = { operation_id: operationId, executor_id, kind, status: RECOVERABLE, started_at: at, completed_at: null, result_ref: null };
      records.set(operationId, record);
      return { proceed: true, record };
    },

    complete(operationId, { result_ref = null, at = null } = {}) {
      const record = records.get(operationId);
      if (!record) return { ok: false, reason: "no such operation" };
      record.status = COMPLETED;
      record.completed_at = at;
      record.result_ref = result_ref;
      return { ok: true, record };
    },

    /**
     * Reconcile an indeterminate operation by OBSERVING the world rather than
     * by re-doing the action. "Did the PR get created?" is answerable; "did my
     * previous self succeed?" is not.
     */
    reconcile(operationId, observe) {
      const record = records.get(operationId);
      if (!record) return { ok: false, reason: "no such operation" };
      const found = observe(record);
      if (found) {
        record.status = COMPLETED;
        record.result_ref = found.result_ref ?? record.result_ref;
        return { ok: true, outcome: "already_performed", record };
      }
      records.delete(operationId);
      return { ok: true, outcome: "never_performed", record: null };
    },

    status(operationId) {
      return records.get(operationId)?.status ?? null;
    },

    /** How many times each externally meaningful action actually happened. */
    counts() {
      const byKind = {};
      for (const record of records.values()) {
        if (record.status !== COMPLETED) continue;
        byKind[record.kind] = (byKind[record.kind] || 0) + 1;
      }
      return byKind;
    },

    all() {
      return [...records.values()].map((r) => ({ ...r }));
    },
  };
}

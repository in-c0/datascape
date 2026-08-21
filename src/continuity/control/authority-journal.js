// Durable authority transactions — spec V6.1.5 PR B governance review, P0-3.
//
// The previous store kept revisions and idempotency in two in-process Maps and
// called the sequence "all-or-nothing". It was not. Authority disappeared on
// restart, and a crash between resolving the exception and recording the
// authority produced exactly the state the design says must be impossible:
//
//   blocker resolved + no durable authority
//
// So: a write-ahead journal with an explicit COMMITTED record, and recovery on
// open. The externally visible invariant, across any crash point, is
//
//   blocker open + no authority        (nothing happened)
//   blocker resolved + exact revision  (it happened)
//
// and never half of one and half of the other.
//
// Ordering matters and is the whole trick. The authority record is written
// durably FIRST but stays INVISIBLE until the committed marker exists, so a
// crash before the marker reads as "nothing happened". The exception is
// resolved between those two writes, and recovery rolls the transaction
// FORWARD — it never rolls back a resolution the outside world may already
// have seen.

export const PHASES = [
  // "claimed" is the PRE-PROMPT phase, added per the parts 0-8 review.
  //
  // It exists because the commit path previously did its replay check against
  // an in-process Map: two concurrent requests with the same operation id could
  // both pass it and both prompt, a same-id-different-receipt attempt was never
  // detected at all, and the whole "durable replay" claim evaporated on
  // restart. Making the claim durable — and binding it to the receipt — is what
  // turns "we check for duplicates" into something a crash cannot forget.
  "claimed",
  "preparing", "authority_written", "resolved", "committed", "aborted",
];

/** An in-memory storage backend. Tests construct two stores over one of these to simulate a restart. */
export function createMemoryStorage(seed = []) {
  const entries = seed.map((e) => ({ ...e }));
  return {
    append(entry) { entries.push({ ...entry }); return entries.length; },
    update(operationId, patch) {
      const found = entries.filter((e) => e.operation_id === operationId).pop();
      if (found) Object.assign(found, patch);
      return Boolean(found);
    },
    read() { return entries.map((e) => ({ ...e })); },
    // Everything a restart would preserve, and nothing a process would.
    snapshot() { return entries.map((e) => ({ ...e })); },
  };
}

/**
 * A filesystem backend: one JSON document, rewritten atomically via a temp file.
 *
 * FAILS CLOSED. Only an absent file means "no authority yet". A corrupt,
 * unreadable or permission-denied journal means the authority state is
 * UNAVAILABLE — reading it as an empty list would silently convert a storage
 * fault into "the owner never authorized anything", which is the most dangerous
 * possible misreading of this file.
 */
export class AuthorityStateUnavailable extends Error {
  constructor(cause) {
    super(`authority state is unavailable: ${cause}`);
    this.name = "AuthorityStateUnavailable";
    this.fail_closed = true;
  }
}

export function createFileStorage({ fs, path: file }) {
  const load = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // Absence is the ONLY benign read failure.
      if (error?.code === "ENOENT") return [];
      throw new AuthorityStateUnavailable(error?.code || String(error.message || error));
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("journal is not an array");
      return parsed;
    } catch (error) {
      throw new AuthorityStateUnavailable(`corrupt journal (${error.message})`);
    }
  };
  const save = (entries) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    // Rename is the atomic step: a reader sees the old file or the new one,
    // never a half-written one.
    fs.renameSync(tmp, file);
  };
  return {
    append(entry) { const e = load(); e.push(entry); save(e); return e.length; },
    update(operationId, patch) {
      const e = load();
      const found = e.filter((x) => x.operation_id === operationId).pop();
      if (!found) return false;
      Object.assign(found, patch);
      save(e);
      return true;
    },
    read: load,
    snapshot: load,
  };
}

/**
 * The journal.
 *
 * `open()` recovers before serving anything, so a store constructed over
 * existing storage behaves as the same store — which is what "survives a
 * restart" has to mean.
 */
export function createAuthorityJournal({ storage, exceptions, now, faultInjector = null }) {
  const injectedFault = faultInjector;
  function recover() {
    const recovered = [];
    for (const entry of storage.read()) {
      if (["committed", "aborted", "inconsistent"].includes(entry.phase)) continue;

      if (entry.phase === "claimed") {
        // A claim that outlived its process never produced a committed write,
        // and it cannot resume: owner presence is a one-shot object held in
        // memory, so it dies with the process by construction. Marking it
        // aborted is therefore definitive rather than optimistic.
        storage.update(entry.operation_id, { phase: "aborted", error: "host restarted before the verification completed", recovered_at: now() });
        recovered.push({ operation_id: entry.operation_id, outcome: "aborted" });
        continue;
      }

      if (entry.phase === "preparing") {
        // The authority record never became durable. Nothing outside this
        // journal can have observed anything, so abandoning is safe and leaves
        // "blocker open + no authority".
        storage.update(entry.operation_id, { phase: "aborted", recovered_at: now() });
        recovered.push({ operation_id: entry.operation_id, outcome: "aborted" });
        continue;
      }

      // authority_written or resolved: roll FORWARD. The exception may already
      // have been resolved where the outside world could see it, and undoing
      // that would leave her blocker mysteriously reopened with no explanation.
      //
      // The narrow window this covers: resolve() SUCCEEDED and the process died
      // before the journal recorded it. The entry still says authority_written,
      // so recovery calls resolve() again — which is only safe because the
      // contract below requires idempotency FOR THE SAME RULING.
      if (entry.phase === "authority_written" && entry.source_exception_id) {
        const rulingRef = entry.record?.ruling?.ref;
        const resolution = exceptions.resolve(entry.source_exception_id, {
          ruling_ref: rulingRef, at: now(), recovered: true,
        });
        if (resolution?.resolved_by && resolution.resolved_by !== rulingRef) {
          // Someone else's ruling closed this blocker. That is an inconsistent
          // state, not a race to win: fail closed rather than stacking a second
          // authority on top of a resolution that meant something different.
          storage.update(entry.operation_id, {
            phase: "inconsistent",
            error: `resolved by ${resolution.resolved_by}, expected ${rulingRef}`,
          });
          recovered.push({ operation_id: entry.operation_id, outcome: "inconsistent" });
          continue;
        }
        if (!resolution?.ok) {
          // Still not resolvable. Leave it mid-flight rather than inventing an
          // outcome; the next open() will try again.
          recovered.push({ operation_id: entry.operation_id, outcome: "retry_pending" });
          continue;
        }
        storage.update(entry.operation_id, { phase: "resolved" });
      }
      storage.update(entry.operation_id, { phase: "committed", recovered_at: now() });
      recovered.push({ operation_id: entry.operation_id, outcome: "rolled_forward" });
    }
    return recovered;
  }

  const recoveredOnOpen = recover();

  const committed = () => storage.read().filter((e) => e.phase === "committed");

  return {
    recovered_on_open: recoveredOnOpen,

    /**
     * DURABLE PRE-PROMPT CLAIM, bound to the prepared receipt.
     *
     * Called immediately before asking Windows, and the reason it is here
     * rather than in a Map beside the commit path: this journal already owns
     * durable operation ids, crash recovery and restart reconstruction. A
     * second independent durable truth would have to be kept in agreement with
     * this one forever, and the first disagreement is a double prompt or a
     * double write.
     *
     * `binding` is host-derived — a hash of the prepared receipt — never a
     * value the browser supplies. It is what makes "same id, different
     * intention" detectable: without it, replaying an operation id with a
     * different receipt is indistinguishable from a legitimate retry.
     *
     * Every outcome except `claimed` means DO NOT PROMPT.
     */
    claim({ operation_id, binding, receipt_id = null, at = now() }) {
      if (!operation_id || typeof operation_id !== "string") {
        return { ok: false, failure: "invalid_claim", reason: "a claim needs a stable operation id" };
      }
      if (!binding || typeof binding !== "string") {
        return { ok: false, failure: "invalid_claim", reason: "a claim must be bound to a prepared receipt" };
      }

      const existing = storage.read().filter((e) => e.operation_id === operation_id).pop();
      if (!existing) {
        storage.append({ operation_id, phase: "claimed", binding, receipt_id, claimed_at: at });
        return { ok: true, state: "claimed" };
      }

      // Binding first: a different receipt under the same id is a COLLISION at
      // every phase, including a committed one. Returning the committed result
      // there would answer a question that was never asked.
      if (existing.binding && existing.binding !== binding) {
        return {
          ok: false, failure: "idempotency_collision",
          reason: "this operation id was already used for a different prepared review",
        };
      }

      if (existing.phase === "committed") {
        return { ok: true, state: "committed", record: existing.record };
      }
      if (existing.phase === "aborted" || existing.phase === "inconsistent") {
        // DEFINITIVE, not retryable. A deliberate new attempt gets a new id;
        // silently re-opening this one would let a failed verification be
        // retried by anything that kept the id around.
        return {
          ok: false, failure: "operation_aborted", phase: existing.phase,
          reason: existing.error || "this operation already ended without committing",
        };
      }
      // claimed / preparing / authority_written / resolved: in flight.
      return {
        ok: false, failure: "operation_in_progress",
        reason: "this operation is already underway; a second verification will not be requested",
      };
    },

    /** Has this operation already completed? Durable, so a restart cannot forget. */
    completed(operationId) {
      return committed().find((e) => e.operation_id === operationId) ?? null;
    },

    /**
     * Run one authority transaction.
     *
     * `build()` produces the record. It runs AFTER the preparing entry exists,
     * so even a crash inside it leaves a journal trace rather than silence.
     */
    /**
     * `faultInjector` is a TEST capability supplied at construction, never by a
     * request. A browser-controlled fault switch would let an authenticated
     * owner — or anything that could reach the endpoint — steer the transaction
     * into a half-written phase on purpose.
     */
    transact({ operation_id, source_exception_id = null, build }) {
      const faultInjector = injectedFault;
      const existing = this.completed(operation_id);
      if (existing) return { ok: true, replayed: true, record: existing.record, revision: existing.record.revision };

      // A claim from the pre-prompt step is UPDATED, not duplicated: two
      // entries for one operation id would make `read().pop()` the arbiter of
      // truth and leave recovery walking a phantom.
      const claimed = storage.read().filter((e) => e.operation_id === operation_id).pop();
      if (claimed && claimed.phase === "claimed") {
        storage.update(operation_id, { phase: "preparing", started_at: now(), source_exception_id });
      } else {
        storage.append({ operation_id, phase: "preparing", started_at: now(), source_exception_id });
      }

      let record;
      try {
        record = build();
      } catch (error) {
        storage.update(operation_id, { phase: "aborted", error: String(error.message || error) });
        return { ok: false, outcome: "transaction_failed", reason: String(error.message || error) };
      }
      if (!record?.ok) {
        storage.update(operation_id, { phase: "aborted", error: record?.reason });
        return { ok: false, outcome: record?.outcome || "transaction_failed", reason: record?.reason };
      }

      // 1. Authority durable but INVISIBLE (only `committed` entries are read).
      storage.update(operation_id, { phase: "authority_written", record: record.value });
      if (faultInjector === "after_authority_written") {
        return { ok: false, outcome: "crashed", reason: "injected fault after the authority write" };
      }

      // 2. Resolve the exception.
      if (source_exception_id) {
        const resolution = exceptions.resolve(source_exception_id, { ruling_ref: record.value.ruling?.ref, at: now() });
        if (!resolution?.ok) {
          storage.update(operation_id, { phase: "aborted", error: resolution?.reason });
          return { ok: false, outcome: "resolution_failed", reason: resolution?.reason || "the exception could not be resolved" };
        }
        if (faultInjector === "between_resolve_and_journal") {
          // The narrowest window in the whole design: the outside world has
          // seen the resolution and the journal does not know it yet.
          return { ok: false, outcome: "crashed", reason: "injected fault between resolution and journal" };
        }
        storage.update(operation_id, { phase: "resolved" });
      }
      if (faultInjector === "after_resolution") {
        return { ok: false, outcome: "crashed", reason: "injected fault after the exception resolution" };
      }

      // 3. The committed marker. This is what makes the authority visible.
      storage.update(operation_id, { phase: "committed", committed_at: now() });
      return { ok: true, replayed: false, record: record.value, revision: record.value.revision };
    },

    /**
     * Release a claim that never reached `transact`.
     *
     * ABORTED, not deleted. A refused verification, an exhausted prompt budget
     * or a state that moved under the dialog all end the operation id for good;
     * deleting the entry would make the id reusable by anything that kept it,
     * which is the retry path a definitive outcome is supposed to close.
     */
    abandon(operationId, outcome = "aborted") {
      const entry = storage.read().filter((e) => e.operation_id === operationId).pop();
      if (!entry) return null;
      if (["committed", "inconsistent", "aborted"].includes(entry.phase)) return entry.phase;
      storage.update(operationId, { phase: "aborted", error: String(outcome), aborted_at: now() });
      return "aborted";
    },

    /** Every committed entry, oldest first — the durable source of material events. */
    allCommitted() {
      return committed().map((e) => ({ ...e }));
    },

    /**
     * The current authority for an authority DOMAIN, found without a goal id.
     *
     * The live UI has no goal id after a reload — it has only the blocker it
     * came from — and looking the goal up via the open blocker cannot work
     * because a successful grant RESOLVES that blocker. So the lineage is
     * indexed by the originating exception recorded on the grant itself, which
     * survives resolution because it lives in the journal rather than in the
     * exception layer.
     */
    currentForDomain(sourceExceptionId) {
      if (!sourceExceptionId) return null;
      const lineage = committed()
        .map((e) => e.record)
        .filter((r) => r?.source_exception_id === sourceExceptionId);
      return lineage.length ? lineage[lineage.length - 1] : null;
    },

    /** Every committed revision for a goal, oldest first. */
    revisions(goalId) {
      return committed().map((e) => e.record).filter((r) => r?.goal?.goal_id === goalId);
    },

    current(goalId) {
      const list = this.revisions(goalId);
      return list.length ? list[list.length - 1] : null;
    },

    /** For assertions: what state would an outside observer see right now? */
    observableState(goalId, exceptionId) {
      return {
        authority_visible: Boolean(this.current(goalId)),
        blocker_resolved: exceptions.isResolved ? exceptions.isResolved(exceptionId) : null,
        in_flight: storage.read().filter((e) => !["committed", "aborted"].includes(e.phase)).length,
      };
    },
  };
}

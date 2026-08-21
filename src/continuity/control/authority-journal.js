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

export const PHASES = ["preparing", "authority_written", "resolved", "committed", "aborted"];

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

      storage.append({ operation_id, phase: "preparing", started_at: now(), source_exception_id });

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

    /** Every committed entry, oldest first — the durable source of material events. */
    allCommitted() {
      return committed().map((e) => ({ ...e }));
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

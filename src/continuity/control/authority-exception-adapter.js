// Resolving the V6 blocker after a verified authority transaction.
//
// A.2.2 made the exception store refuse every exit from `blocked-on-owner`,
// which is correct and is the point. But the authority journal resolves its
// source blocker between the durable authority write and the committed marker,
// and it did that through `setStatus()` — so the first real authorization would
// have thrown `owner_ruling_required` while trying to close its own blocker.
//
// This is the private adapter for that one job. Three things keep it from being
// the escape hatch we just removed:
//
//   it is not a route, not a CLI, and nothing user-facing imports it
//   it resolves ONE exception, to ONE status, carrying the authority's own ref
//   it will not touch an exception that some OTHER authority already resolved
//
// It takes no credential. A caller who can call it has already executed the
// verified authority transaction in-process; a caller who cannot reach it gets
// nothing by knowing a ruling ref, which is exactly why there is no ref to
// present.
//
// THE CRASH INVARIANT this exists to preserve:
//
//   blocker open     + no visible authority     OK
//   blocker resolved + exact committed authority OK
//   blocker resolved + no authority              NEVER
import fs from "node:fs";

/** How an authority resolution is written into the exception body. */
export function resolutionAmendment({ rulingRef, at, note = "" }) {
  return `OWNER AUTHORIZED ${at} (via datascape/authority) [${rulingRef}]${note ? ` — ${note}` : ""}`;
}

/**
 * @param inbox  the exception directory
 * @param now    a clock returning an ISO instant string
 * @param atomic the exception writer — INJECTED, not imported.
 *
 * The repo keeps this module beside `exception-atomic.js`; the deployed host
 * keeps it in `_authority/` while that writer lives in `_continuity/`. A
 * relative import would therefore be correct in exactly one of the two
 * layouts, and the artifact-closure gate rightly refuses a module whose import
 * does not resolve inside its own set. Injecting sidesteps the whole coupling.
 */
export function createAuthorityExceptionAdapter({ inbox, now, atomic }) {
  if (!inbox) throw new Error("the authority exception adapter needs an inbox");
  if (!atomic?.applyRulingAtomically || !atomic?.exceptionFile || !atomic?.parseException) {
    throw new Error("the authority exception adapter needs the exception writer injected");
  }
  const { applyRulingAtomically, exceptionFile, parseException } = atomic;

  /** What does the exception currently say about authority resolution? */
  function inspect(exceptionId) {
    const file = exceptionFile(inbox, exceptionId);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { present: false };
      throw error;
    }
    const entry = parseException(raw);
    const refs = [...entry.body.matchAll(/OWNER AUTHORIZED [^\n[]*\[([^\]]+)\]/g)].map((m) => m[1]);
    return { present: true, file, status: entry.meta.status, refs };
  }

  return {
    inspect,

    /**
     * Resolve the blocker for exactly this authority.
     *
     * Idempotent by REF, not by status: calling twice with the same ruling ref
     * is a recovery replay and writes nothing the second time. Calling with a
     * different ref on an already-authorized exception fails closed, because
     * two authorities claiming the same blocker is a fact somebody needs to
     * look at rather than a race to resolve twice.
     */
    resolve(exceptionId, rulingRef, { note = "" } = {}) {
      if (!exceptionId || !rulingRef) {
        return { ok: false, failure: "invalid_resolution", reason: "an exception id and a ruling ref are required" };
      }

      const current = inspect(exceptionId);
      if (!current.present) {
        return { ok: false, failure: "unknown_exception", reason: `no exception ${exceptionId}` };
      }

      if (current.refs.includes(rulingRef)) {
        // Already done by this exact authority. Recovery calling again must not
        // append a second amendment.
        return { ok: true, replayed: true, status: current.status, ruling_ref: rulingRef };
      }
      if (current.refs.length) {
        return {
          ok: false, failure: "already_authorized",
          reason: `${exceptionId} was already resolved by ${current.refs.join(", ")}`,
          existing_refs: current.refs,
        };
      }

      const at = now();
      const applied = applyRulingAtomically({
        file: current.file,
        amendment: resolutionAmendment({ rulingRef, at, note }),
        status: "resolved",
        statusNote: `owner authority ${rulingRef}`,
        at,
      });
      return { ok: true, replayed: false, status: applied.status, ruling_ref: rulingRef, at };
    },
  };
}

// The verified owner-ruling transaction — spec V6.1.6-A.2 PR B.
//
// The rule the whole file exists for:
//
//   The operation Windows verifies must be the EXACT operation the host
//   subsequently performs.
//
// The browser supplies intent. The host constructs the ruling. After
// verification there is no browser round trip, and no verification result,
// handle, token, proof or boolean crosses back into browser state.
//
// Order matters and is not negotiable:
//
//   idempotency  BEFORE prompting  (a committed retry must not re-prompt)
//   staleness    AFTER prompting   (the exception can change while Hello is up)
//   consume      BEFORE mutating   (presence is spent once, on this attempt)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describePurpose, requiresOwnerPresence } from "./owner-presence.js";

/** The six closed owner action classes. No prose is ever classified. */
export const OWNER_ACTIONS = ["approve", "reply_done", "reply_no", "reply_need_context", "defer", "dismiss"];

/** How each class lands in the exception layer's own vocabulary. */
export const ACTION_SEMANTICS = {
  approve: { wire: "approve", status: "investigating", needsText: false },
  reply_done: { wire: "reply", status: "resolved", needsText: false },
  reply_no: { wire: "reply", status: "investigating", needsText: false },
  reply_need_context: { wire: "reply", status: "investigating", needsText: true },
  defer: { wire: "defer", status: null, needsUntil: true },
  dismiss: { wire: "dismiss", status: "resolved", needsText: false },
};

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * A deterministic fingerprint of everything about the exception that
 * materially affects THIS ruling.
 *
 * Prefers the store's own revision when it has one. Otherwise derived from the
 * authoritative fields, because "it looked the same" has to mean something
 * checkable when a prompt has been open for several seconds.
 */
export function exceptionFingerprint(exception) {
  if (!exception) return null;
  if (exception.revision !== undefined && exception.revision !== null) {
    return `rev:${exception.revision}`;
  }
  return `fp:${sha(JSON.stringify({
    id: exception.id,
    status: exception.status,
    updated: exception.updated,
    proposed: exception.proposed ?? null,
    proposal_ref: exception.proposal_ref ?? null,
    proposal_revision: exception.proposal_revision ?? null,
    deferred_until: exception.deferred_until ?? null,
  }))}`;
}

/**
 * Normalize a browser request into a host-owned immutable operation.
 *
 * `operation_id` may come from the client for retry correlation and grants NO
 * authority. `operation_ref` and the canonical hash are host-derived, so two
 * requests claiming the same id but meaning different things are detectable.
 */
export function prepareOwnerMutation({ request, exception, at }) {
  if (!exception) return { ok: false, failure: "unknown_exception", reason: "no such exception" };

  const action = request?.action;
  if (!OWNER_ACTIONS.includes(action)) {
    // Explicit closed classes only. The old wire vocabulary sent a generic
    // `reply` plus free text, which would have forced the host to infer her
    // meaning from prose — and a keyword search for "done" is not consent.
    return { ok: false, failure: "invalid_action", reason: `unknown owner action: ${action}` };
  }

  const semantics = ACTION_SEMANTICS[action];
  const payload = {};
  if (semantics.needsUntil) {
    const until = request.until ? new Date(Date.parse(request.until)) : null;
    if (!until || Number.isNaN(until.getTime())) {
      return { ok: false, failure: "invalid_action", reason: "defer needs an absolute time" };
    }
    payload.deferred_until = until.toISOString();
  }
  if (semantics.needsText) {
    const text = String(request.note ?? "").trim();
    if (!text) return { ok: false, failure: "invalid_action", reason: "this ruling needs her words" };
    // Editable text is part of the ruling, so it is bound and prompted on.
    payload.text = text;
  }
  if (action === "approve") {
    payload.proposal_ref = exception.proposal_ref ?? exception.id;
    payload.proposal_revision = exception.proposal_revision ?? exception.updated ?? null;
  }

  const fingerprint = exceptionFingerprint(exception);
  // The canonical hash is the SEMANTICS of the ruling — which exception, which
  // class, which bound payload. It deliberately excludes the fingerprint: a
  // ruling changes the exception it rules on, so folding the state in would
  // make every legitimate retry look like a different operation and turn a lost
  // response into a permanent collision.
  //
  // The fingerprint travels on the mutation for the staleness check, which is a
  // different question asked at a different moment.
  const canonical = { exception_id: exception.id, action, payload };
  const canonical_hash = sha(JSON.stringify(canonical));

  return {
    ok: true,
    mutation: {
      operation_id: String(request.operation_id ?? ""),
      // Host-derived. A client cannot name an operation into existence.
      // Host-derived and unique to THIS attempt: two attempts at the same
      // ruling are the same semantics but different events, and the amendment
      // that lands must name the attempt that produced it.
      operation_ref: `ruling:${sha(`${canonical_hash}|${request.operation_id ?? ""}|${fingerprint}`).slice(0, 24)}`,
      canonical_hash,
      ...canonical,
      exception_fingerprint: fingerprint,
      proposal_ref: payload.proposal_ref ?? null,
      proposal_revision: payload.proposal_revision ?? null,
      prepared_at: at,
    },
  };
}

/** The OS prompt text, derived entirely from the prepared mutation. */
export function promptFor(mutation) {
  const detail = { exception_id: mutation.exception_id };
  if (mutation.action === "defer") {
    const when = new Date(mutation.payload.deferred_until);
    return `Defer exception ${mutation.exception_id} until ${when.toISOString()}`;
  }
  const base = describePurpose(mutation.action, detail);
  // For an editable reply the exact final text is part of what she is
  // approving, so the dialog shows it. A prompt naming only the class would let
  // the text be swapped between review and verification.
  if (mutation.payload.text) return `${base}\n"${mutation.payload.text}"`;
  return base;
}

/**
 * File-backed journal storage.
 *
 * Lives outside the repository by default. It is private host state: it records
 * which owner rulings this machine performed, and nothing about it belongs in
 * a commit or in `git add -A`.
 */
export function createRulingJournalStorage(file) {
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      // Fail closed. An unreadable journal means idempotency cannot be
      // decided, and guessing "new" here is how a ruling gets applied twice.
      throw new Error(`the owner-ruling journal is unreadable: ${error.message}`);
    }
  };
  const save = (entries) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, file);
  };

  return {
    read: load,
    append(entry) {
      const entries = load();
      entries.push(entry);
      save(entries);
    },
    update(operationId, patch) {
      const entries = load();
      const index = entries.findIndex((e) => e.operation_id === operationId);
      if (index === -1) throw new Error(`no journal entry for ${operationId}`);
      entries[index] = { ...entries[index], ...patch };
      save(entries);
    },
  };
}

/** In-memory storage, for tests and for a host with no durable directory yet. */
export function createMemoryJournalStorage() {
  const entries = [];
  return {
    read: () => entries.map((e) => ({ ...e })),
    append: (entry) => { entries.push({ ...entry }); },
    update(operationId, patch) {
      const index = entries.findIndex((e) => e.operation_id === operationId);
      if (index === -1) throw new Error(`no journal entry for ${operationId}`);
      entries[index] = { ...entries[index], ...patch };
    },
  };
}

/**
 * The durable owner-ruling journal.
 *
 * Exists because `setStatus()` may be harmlessly repeatable while the amendment
 * text attached to it is not: a retry after a lost response could append her
 * ruling twice. The journal records intent before the mutation and completion
 * after it, and recovery rolls forward by looking for `operation_ref` in the
 * exception itself.
 */
export function createRulingJournal({ storage, now }) {
  const read = () => storage.read();

  return {
    /** Has this exact operation already completed? */
    completed(operationId) {
      return read().find((e) => e.operation_id === operationId && e.phase === "committed") ?? null;
    },

    /**
     * Idempotency, checked BEFORE any prompt.
     *
     * Same id and same canonical semantics replays. Same id, different
     * semantics is a collision — and neither costs a Windows dialog.
     */
    check(mutation) {
      const prior = read().find((e) => e.operation_id === mutation.operation_id);
      if (!prior) return { outcome: "new" };
      if (prior.canonical_hash !== mutation.canonical_hash) {
        return { outcome: "idempotency_collision", reason: "this operation id already means something else" };
      }
      if (prior.phase === "committed") return { outcome: "replay", record: prior };
      return { outcome: "recoverable", record: prior };
    },

    begin(mutation) {
      storage.append({
        operation_id: mutation.operation_id,
        operation_ref: mutation.operation_ref,
        canonical_hash: mutation.canonical_hash,
        exception_id: mutation.exception_id,
        phase: "preparing",
        started_at: now(),
      });
      return mutation.operation_ref;
    },

    complete(mutation, result) {
      storage.update(mutation.operation_id, { phase: "committed", committed_at: now(), result });
      return result;
    },

    abort(mutation, reason) {
      storage.update(mutation.operation_id, { phase: "aborted", reason, aborted_at: now() });
    },

    /**
     * Recovery: an amendment carrying this operation_ref proves the mutation
     * landed even though the journal never recorded it.
     */
    recover(readException) {
      const recovered = [];
      for (const entry of read()) {
        if (entry.phase !== "preparing") continue;
        const exception = readException(entry.exception_id);
        const applied = exception && String(exception.body ?? "").includes(entry.operation_ref);
        storage.update(entry.operation_id, {
          phase: applied ? "committed" : "aborted",
          recovered_at: now(),
          reason: applied ? "amendment found in the exception" : "no amendment; never applied",
        });
        recovered.push({ operation_id: entry.operation_id, outcome: applied ? "rolled_forward" : "aborted" });
      }
      return recovered;
    },

    all: read,
  };
}

/**
 * Production prompt budget.
 *
 * A local process cannot produce owner authority, but it can produce dialogs.
 * Bounded annoyance is acceptable; an endless Hello storm is not. Malformed,
 * stale and idempotent requests never reach here, so they cost nothing.
 */
export function createPromptBudget({ now, cooldownMs = 10000, windowMs = 60000, strikes = 3, lockoutMs = 5 * 60 * 1000 }) {
  let cooldownUntil = 0;
  let lockedUntil = 0;
  let failures = [];

  return {
    mayPrompt() {
      const at = now();
      if (at < lockedUntil) return { ok: false, failure: "prompt_lockout", retry_after_ms: lockedUntil - at };
      if (at < cooldownUntil) return { ok: false, failure: "prompt_cooldown", retry_after_ms: cooldownUntil - at };
      return { ok: true };
    },
    recordOutcome(outcome) {
      const at = now();
      if (outcome === "verified") { failures = []; cooldownUntil = 0; return; }
      cooldownUntil = at + cooldownMs;
      failures = failures.filter((t) => at - t < windowMs);
      failures.push(at);
      if (failures.length >= strikes) {
        lockedUntil = at + lockoutMs;
        failures = [];
      }
    },
    state: () => ({ cooldown_until: cooldownUntil, locked_until: lockedUntil, recent_failures: failures.length }),
    // Process memory only: a host restart clears anti-DoS state, which is the
    // correct trade — it is not security state.
    persisted: false,
  };
}

/**
 * The whole transaction, in one place.
 *
 * `deps` are all injected so an acceptance suite can drive the real sequence
 * with a fake verifier and an isolated store, and so nothing here can reach a
 * real Windows dialog by accident.
 */
export async function performOwnerRuling({
  request, readException, applyMutation, verifier, journal, budget, now,
}) {
  const at = now();

  // 1. Resolve the authoritative exception FIRST. Everything downstream is
  //    derived from the store, never from the request.
  const exception = readException(request?.id);
  const prepared = prepareOwnerMutation({ request, exception, at });
  if (!prepared.ok) {
    // Rejected before any prompt and without touching prompt budget.
    return { ok: false, ...prepared, prompt_shown: false, mutation_performed: false };
  }
  const mutation = prepared.mutation;

  if (!requiresOwnerPresence(mutation.action)) {
    return { ok: false, failure: "invalid_action", reason: "not an owner ruling", prompt_shown: false, mutation_performed: false };
  }
  if (!mutation.operation_id) {
    return { ok: false, failure: "invalid_action", reason: "an owner ruling needs a stable operation id", prompt_shown: false, mutation_performed: false };
  }

  // 2. Idempotency BEFORE prompting.
  const idempotent = journal.check(mutation);
  if (idempotent.outcome === "replay") {
    return { ok: true, replayed: true, result: idempotent.record.result, prompt_shown: false, mutation_performed: false };
  }
  if (idempotent.outcome === "idempotency_collision") {
    return { ok: false, failure: "idempotency_collision", reason: idempotent.reason, prompt_shown: false, mutation_performed: false };
  }

  // 3. Prompt budget, checked before a dialog can be requested.
  const allowed = budget.mayPrompt();
  if (!allowed.ok) return { ok: false, ...allowed, prompt_shown: false, mutation_performed: false };

  journal.begin(mutation);

  // 4. Fresh owner presence for THIS exact operation.
  const verification = await verifier.verify({
    purpose: promptFor(mutation),
    operationRef: mutation.operation_ref,
  });
  budget.recordOutcome(verification.outcome);
  if (verification.outcome !== "verified") {
    journal.abort(mutation, verification.outcome);
    return {
      ok: false, failure: verification.outcome, reason: verification.reason,
      prompt_shown: true, mutation_performed: false,
    };
  }

  // 5. Staleness AFTER the prompt. The exception can change while Hello is up.
  const current = readException(mutation.exception_id);
  if (exceptionFingerprint(current) !== mutation.exception_fingerprint) {
    // The presence is spent on this attempt and is NOT carried to a freshly
    // prepared mutation: she reviewed the old state, so she must review again.
    verifier.authorizes(verification, mutation.operation_ref);
    journal.abort(mutation, "stale_owner_operation");
    return {
      ok: false, failure: "stale_owner_operation",
      reason: "the exception changed while the verification was open",
      prompt_shown: true, mutation_performed: false,
    };
  }

  // 6. Consume presence exactly once, then perform the EXACT prepared mutation.
  const consumed = verifier.authorizes(verification, mutation.operation_ref);
  if (!consumed.ok) {
    journal.abort(mutation, consumed.reason);
    return { ok: false, failure: "presence_not_valid", reason: consumed.reason, prompt_shown: true, mutation_performed: false };
  }

  const result = applyMutation(mutation);
  journal.complete(mutation, result);
  return {
    ok: true, replayed: false, result,
    operation_ref: mutation.operation_ref,
    prompt_shown: true, mutation_performed: true,
  };
}

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

/** The status an owner ruling is a ruling ON. */
export const OWNER_GATED_STATUS = "blocked-on-owner";

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
 * Is this ruling valid against the exception as it stands RIGHT NOW?
 *
 * Deliberately separate from `prepareOwnerMutation`, and deliberately checked
 * AFTER the idempotency lookup. A successful ruling moves the item out of
 * `blocked-on-owner`, so checking validity first would reject the legitimate
 * retry of a completed ruling instead of replaying it — the exact failure the
 * idempotency record exists to prevent.
 *
 * Checked BEFORE the prompt, so an action that is not currently valid still
 * costs zero dialogs.
 */
export function validateCurrentState(mutation, exception) {
  if (!exception) return { ok: false, failure: "unknown_exception", reason: "the exception is gone" };

  // Every one of the six classes rules on a question that is waiting for her.
  // Ruling on an item nobody is waiting on is not a ruling.
  if (exception.status !== OWNER_GATED_STATUS) {
    return {
      ok: false, failure: "action_not_currently_valid",
      reason: `${exception.id} is ${exception.status}, not waiting on her`,
    };
  }
  if (mutation.action === "approve" && !String(exception.proposed ?? "").trim()) {
    // "Approve the proposed action" with no proposed action is a prompt with
    // nothing behind it.
    return {
      ok: false, failure: "action_not_currently_valid",
      reason: `${exception.id} has no current proposal to approve`,
    };
  }
  return { ok: true };
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
    // ONE record per operation_id, always. The first version appended, so a
    // retry after a cancellation wrote a second row with the same id and
    // `update` then patched whichever came first — leaving the live attempt
    // stranded and the journal lying about what happened.
    put(entry) {
      const entries = load().filter((e) => e.operation_id !== entry.operation_id);
      entries.push(entry);
      save(entries);
    },
    get(operationId) {
      return load().find((e) => e.operation_id === operationId) ?? null;
    },
  };
}

/** In-memory storage, for tests and for a host with no durable directory yet. */
export function createMemoryJournalStorage() {
  let entries = [];
  return {
    read: () => entries.map((e) => ({ ...e })),
    put(entry) {
      entries = entries.filter((e) => e.operation_id !== entry.operation_id);
      entries.push({ ...entry });
    },
    get: (operationId) => {
      const found = entries.find((e) => e.operation_id === operationId);
      return found ? { ...found } : null;
    },
  };
}

/**
 * What the exception MUST look like for this ruling to count as committed.
 *
 * Searching the body for the operation_ref was not enough. `applyOwnerMutation`
 * used to make several authoritative writes, so a crash between them could
 * leave the ref present with the status never changed — and recovery would call
 * that committed. The postcondition is now the whole intended end state.
 */
export function expectedPostcondition(mutation) {
  const semantics = ACTION_SEMANTICS[mutation.action];
  return {
    operation_ref: mutation.operation_ref,
    status: semantics.status ?? null,
    deferred_until: mutation.payload.deferred_until ?? null,
  };
}

/**
 * Did the ruling land completely, not at all, or half way?
 *
 * A half-applied owner ruling is the one answer that must never be rounded to
 * either of the others.
 */
export function classifyApplication(expected, exception) {
  if (!exception) return "none";
  const signals = [String(exception.body ?? "").includes(expected.operation_ref)];
  if (expected.status) signals.push(exception.status === expected.status);
  if (expected.deferred_until) {
    signals.push(Date.parse(exception.deferred_until ?? "") === Date.parse(expected.deferred_until));
  }
  if (signals.every(Boolean)) return "complete";
  if (signals.every((s) => !s)) return "none";
  return "partial";
}

/**
 * The durable owner-ruling journal.
 *
 * Exists because the amendment attached to a ruling is not harmlessly
 * repeatable: a retry after a lost response could append her ruling twice. One
 * record per operation, moving through a closed set of phases:
 *
 *   new -> preparing -> committed
 *   new -> preparing -> aborted -> preparing (next attempt) -> committed
 */
export function createRulingJournal({ storage, now }) {
  return {
    /** Has this exact operation already completed? */
    completed(operationId) {
      const entry = storage.get(operationId);
      return entry?.phase === "committed" ? entry : null;
    },

    /**
     * Idempotency, decided BEFORE any prompt.
     *
     * `preparing` means a previous attempt died mid-flight and must be
     * recovered against the exception before anything else happens.
     */
    check(mutation) {
      const prior = storage.get(mutation.operation_id);
      if (!prior) return { outcome: "new" };
      if (prior.canonical_hash !== mutation.canonical_hash) {
        return { outcome: "idempotency_collision", reason: "this operation id already means something else" };
      }
      if (prior.phase === "committed") return { outcome: "replay", record: prior };
      if (prior.phase === "aborted") return { outcome: "retryable", record: prior };
      return { outcome: "recoverable", record: prior };
    },

    /** Claim the record for a new attempt. Never a second row. */
    begin(mutation, result = null) {
      const prior = storage.get(mutation.operation_id);
      storage.put({
        operation_id: mutation.operation_id,
        operation_ref: mutation.operation_ref,
        canonical_hash: mutation.canonical_hash,
        exception_id: mutation.exception_id,
        action: mutation.action,
        payload: mutation.payload,
        // Enough to verify the postcondition and to rebuild a replay result
        // after a recovery, which the first version could not do.
        expected: expectedPostcondition(mutation),
        phase: "preparing",
        attempt: (prior?.attempt ?? 0) + 1,
        started_at: now(),
        result,
      });
      return mutation.operation_ref;
    },

    complete(mutation, result) {
      const prior = storage.get(mutation.operation_id) ?? {};
      storage.put({ ...prior, phase: "committed", committed_at: now(), result });
      return result;
    },

    abort(mutation, reason) {
      const prior = storage.get(mutation.operation_id) ?? {};
      storage.put({ ...prior, phase: "aborted", reason, aborted_at: now() });
    },

    /**
     * Resolve one mid-flight record against the authoritative exception.
     *
     * Rolls forward on a COMPLETE postcondition, releases the record when
     * nothing was applied, and fails closed on a half-application rather than
     * guessing which way to round it.
     */
    resolve(entry, readException) {
      const exception = readException(entry.exception_id);
      const applied = classifyApplication(entry.expected, exception);
      if (applied === "complete") {
        const result = entry.result ?? {
          id: entry.exception_id,
          action: entry.action,
          ruling_ref: entry.operation_ref,
          operation_ref: entry.operation_ref,
          resultingStatus: entry.expected.status ?? exception?.status ?? null,
          recovered: true,
        };
        storage.put({ ...entry, phase: "committed", committed_at: now(), recovered_at: now(), result });
        return { outcome: "rolled_forward", result };
      }
      if (applied === "none") {
        storage.put({ ...entry, phase: "aborted", reason: "never applied", aborted_at: now() });
        return { outcome: "aborted" };
      }
      // Half-applied. Somebody has to look at it; inventing the rest of the
      // ruling, or pretending it never happened, are both worse.
      storage.put({ ...entry, phase: "preparing", partial: true, detected_at: now() });
      return { outcome: "partial_application" };
    },

    /** Startup recovery across every mid-flight record. */
    recover(readException) {
      return storage.read()
        .filter((entry) => entry.phase === "preparing")
        .map((entry) => ({ operation_id: entry.operation_id, ...this.resolve(entry, readException) }));
    },

    all: () => storage.read(),
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
  let idempotent = journal.check(mutation);

  if (idempotent.outcome === "recoverable") {
    // A previous attempt died mid-flight. It has to be resolved against the
    // authoritative exception before this one may proceed — otherwise a retry
    // prompts her for a ruling that may already have landed.
    const resolved = journal.resolve(idempotent.record, readException);
    if (resolved.outcome === "rolled_forward") {
      return { ok: true, replayed: true, recovered: true, result: resolved.result, prompt_shown: false, mutation_performed: false };
    }
    if (resolved.outcome === "partial_application") {
      // Fail closed. Half a ruling is not a ruling, and neither completing it
      // blind nor re-running it is safe.
      return {
        ok: false, failure: "partial_application", prompt_shown: false, mutation_performed: false,
        reason: "a previous attempt left this exception half-ruled; it needs repair before another ruling",
      };
    }
    idempotent = journal.check(mutation);
  }

  if (idempotent.outcome === "replay") {
    return { ok: true, replayed: true, result: idempotent.record.result, prompt_shown: false, mutation_performed: false };
  }
  if (idempotent.outcome === "idempotency_collision") {
    return { ok: false, failure: "idempotency_collision", reason: idempotent.reason, prompt_shown: false, mutation_performed: false };
  }

  // 3. Current-state validity, still before anything can cost a dialog.
  const valid = validateCurrentState(mutation, exception);
  if (!valid.ok) return { ok: false, ...valid, prompt_shown: false, mutation_performed: false };

  // 4. Prompt budget, checked before a dialog can be requested.
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

/**
 * N rulings, ONE dialog — the batch transaction (owner request, 2026-08-22:
 * "windows dialogue per act is annoying").
 *
 * This is deliberately NOT a grace window. A time-window grant after one
 * dialog would let an agent driving her already-open browser piggyback
 * rulings she never saw — the exact threat the per-act prompt exists to stop,
 * on a machine where autonomous sessions drive browsers all day. Batching
 * keeps the invariant intact: the ONE prompt enumerates every act it grants,
 * line by line, so nothing is performed that was not on the dialog she read.
 *
 * Composition, not a new mechanism:
 *  - every item goes through the same prepare / class / idempotency /
 *    current-state gates as a single ruling, ALL BEFORE the prompt — one
 *    invalid item refuses the whole batch, so the dialog can never enumerate
 *    an act the host would refuse;
 *  - one verification, bound to a batch operation_ref derived from the ordered
 *    item refs, consumed exactly once (the one-shot identity capability is
 *    unchanged);
 *  - staleness is re-checked PER ITEM after the prompt; an item that changed
 *    while the dialog was up is skipped and reported stale — she reviewed the
 *    old state of that item, so it alone needs a fresh review — while the
 *    untouched items she approved still land;
 *  - each item keeps its own journal lifecycle, so a crash mid-batch leaves
 *    per-item recoverable records exactly like the single path.
 */
export async function performOwnerRulingBatch({
  requests, readException, applyMutation, verifier, journal, budget, now,
}) {
  const at = now();
  const refuse = (failure, reason, extra = {}) => ({
    ok: false, failure, reason, prompt_shown: false, mutation_performed: false, ...extra,
  });

  if (!Array.isArray(requests) || requests.length === 0) {
    return refuse("invalid_action", "a batch needs at least one ruling");
  }
  if (requests.length > 20) {
    // A dialog she cannot read is consent she cannot give.
    return refuse("invalid_action", "a batch is capped at 20 rulings per prompt");
  }

  // 1. Prepare EVERYTHING first. The prompt may only ever enumerate acts that
  //    would individually pass every pre-prompt gate right now.
  const items = [];
  const seen = new Set();
  for (const request of requests) {
    const exception = readException(request?.id);
    const prepared = prepareOwnerMutation({ request, exception, at });
    if (!prepared.ok) {
      return refuse(prepared.failure, `${request?.id ?? "?"}: ${prepared.reason}`, { item: request?.id ?? null });
    }
    const mutation = prepared.mutation;
    if (!requiresOwnerPresence(mutation.action)) {
      return refuse("invalid_action", `${mutation.exception_id}: not an owner ruling`, { item: mutation.exception_id });
    }
    if (!mutation.operation_id) {
      return refuse("invalid_action", `${mutation.exception_id}: an owner ruling needs a stable operation id`, { item: mutation.exception_id });
    }
    if (seen.has(mutation.exception_id)) {
      // Two rulings on one exception inside one prompt cannot both describe
      // the state she reviewed.
      return refuse("invalid_action", `${mutation.exception_id}: appears twice in one batch`, { item: mutation.exception_id });
    }
    seen.add(mutation.exception_id);

    const idempotent = journal.check(mutation);
    if (idempotent.outcome !== "new") {
      // Replays and recoveries carry per-item history a batch prompt cannot
      // honestly summarise. Rare by construction; the client retries those
      // individually through the single path, which knows how to resolve them.
      return refuse("batch_item_not_new", `${mutation.exception_id}: ${idempotent.outcome} — rule on it individually`, { item: mutation.exception_id });
    }
    const valid = validateCurrentState(mutation, exception);
    if (!valid.ok) {
      return refuse(valid.failure, `${mutation.exception_id}: ${valid.reason}`, { item: mutation.exception_id });
    }
    items.push({ mutation });
  }

  // 2. One prompt-budget slot for one prompt.
  const allowed = budget.mayPrompt();
  if (!allowed.ok) return refuse(allowed.failure, allowed.reason);

  for (const { mutation } of items) journal.begin(mutation);
  const abortAll = (outcome) => { for (const { mutation } of items) journal.abort(mutation, outcome); };

  // 3. ONE verification whose purpose is the enumerated batch.
  const batchRef = `batch:${sha(items.map((i) => i.mutation.operation_ref).join("|")).slice(0, 24)}`;
  const purpose = [
    `Apply ${items.length} owner ruling${items.length === 1 ? "" : "s"}:`,
    ...items.map(({ mutation }, n) => `${n + 1}. ${promptFor(mutation)}`),
  ].join("\n");
  const verification = await verifier.verify({ purpose, operationRef: batchRef });
  budget.recordOutcome(verification.outcome);
  if (verification.outcome !== "verified") {
    abortAll(verification.outcome);
    return {
      ok: false, failure: verification.outcome, reason: verification.reason,
      prompt_shown: true, mutation_performed: false,
    };
  }

  // 4. Consume the one-shot capability for the batch, exactly once.
  const consumed = verifier.authorizes(verification, batchRef);
  if (!consumed.ok) {
    abortAll(consumed.reason);
    return { ok: false, failure: "presence_not_valid", reason: consumed.reason, prompt_shown: true, mutation_performed: false };
  }

  // 5. Per-item staleness, then perform. Only items still EXACTLY as reviewed
  //    are applied; the rest are reported for a fresh, individual review.
  const results = [];
  let performed = 0;
  for (const { mutation } of items) {
    const current = readException(mutation.exception_id);
    if (exceptionFingerprint(current) !== mutation.exception_fingerprint) {
      journal.abort(mutation, "stale_owner_operation");
      results.push({
        exception_id: mutation.exception_id, ok: false, failure: "stale_owner_operation",
        reason: "this exception changed while the verification was open",
      });
      continue;
    }
    const result = applyMutation(mutation);
    journal.complete(mutation, result);
    performed += 1;
    results.push({ exception_id: mutation.exception_id, ok: true, ...result });
  }

  return {
    ok: true, batch_ref: batchRef, results,
    prompt_shown: true, mutation_performed: performed > 0,
    performed, skipped: results.length - performed,
  };
}

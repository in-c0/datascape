// Client for the briefing action endpoint — the follow-through half.
//
// Spec §5.1 / §6: exactly four affordances, each a read/write projection of the
// authoritative exception. There is no DataScape-local task, no second queue,
// and no owner-action copy.
//
// When no API is configured the surface degrades to read-only rather than
// rendering controls that silently fail: she must never be unable to tell
// "acted" from "nothing happened".

export const ACTION_API = import.meta.env?.VITE_BRIEFING_API || null;

/**
 * Refusals where the host is certain no mutation occurred and never will for
 * this attempt. Anything else — a timeout, a 5xx, a dropped connection — is
 * ambiguous and must keep its operation id.
 */
const DEFINITIVE_REFUSALS = [
  "cancelled", "failed", "unavailable", "invalid_action",
  "unknown_exception", "action_not_currently_valid", "stale_owner_operation",
];

/**
 * The six closed owner action classes (spec V6.1.6-A.2 PR B).
 *
 * This used to be four, with Done / No / Need context all sent as a generic
 * `reply` plus the chip's label as free text. That forced the host to recover
 * her meaning from prose, and a host that greps a reply for "done" is
 * classifying consent by keyword. The class is now on the wire, so what Windows
 * prompts about and what the host performs are the same closed value.
 */
export const ACTIONS = {
  approve: {
    key: "approve",
    label: "Approve proposed",
    // Conditional — only shown when the exception carries authored prose.
    requiresProposed: true,
    // → investigating: the filing lane now owns the next move.
    closes: false,
  },
  reply_done: { key: "reply_done", label: "Done", closes: true },
  reply_no: { key: "reply_no", label: "No", closes: false },
  // The only class carrying editable text; the exact final text is bound into
  // the operation and shown in the OS prompt.
  reply_need_context: { key: "reply_need_context", label: "Need context", needsNote: true, closes: false },
  defer: { key: "defer", label: "Defer", needsUntil: true, closes: false },
  dismiss: { key: "dismiss", label: "Dismiss as not needed", closes: true },
};

/**
 * A stable operation id per user action.
 *
 * Kept across network retry: if a response is ambiguous — a timeout, a dropped
 * connection — clicking again must reach the host as the SAME operation, so the
 * host replays its recorded ruling instead of applying it twice and instead of
 * prompting her a second time. A different ruling is a different intent and
 * gets a fresh id.
 */
const OPERATION_STORE_KEY = "continuity.pendingOwnerOperations";

/**
 * Persisted in sessionStorage, not just in memory.
 *
 * The failure this exists for is precisely the one that survives a reload: the
 * ruling commits, the response is lost, the page reloads, she clicks again. An
 * in-memory map is empty by then, so the retry arrives with a NEW operation id
 * and the host cannot recognise the ruling it already performed — it prompts
 * her a second time for something already done.
 *
 * The operation id is not authority. It is a correlation label, and persisting
 * it is safe for exactly that reason. No verification result, and nothing
 * derived from one, is ever stored here.
 */
function loadPending() {
  try {
    return new Map(Object.entries(JSON.parse(globalThis.sessionStorage?.getItem(OPERATION_STORE_KEY) || "{}")));
  } catch {
    return new Map();
  }
}

function savePending(map) {
  try {
    globalThis.sessionStorage?.setItem(OPERATION_STORE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // A private-mode browser with no storage still works; it just loses the
    // cross-reload guarantee, which is better than failing the ruling.
  }
}

export function operationIdFor(intent) {
  const key = JSON.stringify(intent);
  const pending = loadPending();
  if (!pending.has(key)) {
    const random = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    pending.set(key, `op-${random}`);
    savePending(pending);
  }
  return pending.get(key);
}

/** Called once the ruling's fate is KNOWN, so the id is never reused. */
export function retireOperationId(intent) {
  const pending = loadPending();
  if (pending.delete(JSON.stringify(intent))) savePending(pending);
}

/**
 * Record an owner ruling.
 *
 * Returns the server's rebuilt queue. Nothing is removed optimistically: a
 * defer keeps the exception exactly where it is and merely stops it being
 * due-now, and a reply moves it to `investigating` rather than closing it, so
 * only the server's view is honest.
 */
export async function recordAction({ id, action, note = "", until = null }) {
  if (!ACTION_API) throw new Error("no action API configured");
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`unknown action ${action}`);
  if (spec.needsNote && !String(note).trim()) throw new Error("this action needs a reply");
  if (spec.needsUntil && !until) throw new Error("defer needs a time");

  const intent = { id, action, note, until };
  const operation_id = operationIdFor(intent);

  const response = await fetch(`${ACTION_API}/api/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...intent, operation_id }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Prefer the host's explanation over its error CODE. A refusal that reads
    // "owner_presence_required" tells her nothing she can act on; the detail
    // says what changed and what to do instead.
    //
    // Retired only when the host has definitively said nothing happened. A
    // refusal she can retry — and anything ambiguous — keeps the id, so the
    // retry arrives as the SAME operation and replays instead of ruling twice.
    if (payload?.mutation_performed === false && DEFINITIVE_REFUSALS.includes(payload?.error)) {
      retireOperationId(intent);
    }
    throw new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
  }
  retireOperationId(intent);
  return payload;
}

export async function fetchDecisions() {
  if (!ACTION_API) return [];
  try {
    const response = await fetch(`${ACTION_API}/api/decisions`);
    if (!response.ok) return [];
    return (await response.json()).decisions || [];
  } catch {
    return [];
  }
}

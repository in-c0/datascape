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
const pendingOperations = new Map();

export function operationIdFor(intent) {
  const key = JSON.stringify(intent);
  if (!pendingOperations.has(key)) {
    const random = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    pendingOperations.set(key, `op-${random}`);
  }
  return pendingOperations.get(key);
}

/** Called once a ruling is known to have landed, so the id is never reused. */
export function retireOperationId(intent) {
  pendingOperations.delete(JSON.stringify(intent));
}

export function actionsAvailable() {
  return Boolean(ACTION_API);
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
    // The operation id is deliberately NOT retired here: a refusal she can
    // retry must retry as the same operation.
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

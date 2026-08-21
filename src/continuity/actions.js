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

export const ACTIONS = {
  approve: {
    key: "approve",
    label: "Approve proposed",
    // Conditional — only shown when the exception carries authored prose.
    requiresProposed: true,
    // → investigating: the filing lane now owns the next move.
    closes: false,
  },
  reply: { key: "reply", label: "Reply…", needsNote: true, closes: false },
  defer: { key: "defer", label: "Defer", needsUntil: true, closes: false },
  dismiss: { key: "dismiss", label: "Dismiss as not needed", closes: true },
};

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

  const response = await fetch(`${ACTION_API}/api/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, action, note, until }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
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

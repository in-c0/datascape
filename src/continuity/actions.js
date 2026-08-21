// Client for the briefing action endpoint — the follow-through half.
//
// The surface is otherwise a read over static JSON. When an action API is
// configured (VITE_BRIEFING_API, set by the catchup launcher), owner-action
// nodes gain controls that actually do something: record a ruling, close an
// item, dismiss it. Without it the surface degrades to read-only rather than
// showing controls that silently fail — a dead button on a catch-up surface is
// worse than no button, because she cannot tell the difference between "acted"
// and "nothing happened".

export const ACTION_API = import.meta.env?.VITE_BRIEFING_API || null;

export const ACTIONS = {
  // Deliberately few, and each maps onto a status the exception inbox already
  // has. No new lifecycle, no parallel queue.
  done: {
    key: "done",
    label: "I did it",
    hint: "Closes the item.",
    needsNote: false,
    closes: true,
  },
  ruling: {
    key: "ruling",
    label: "Record my ruling",
    hint: "Your words go back to the lane that asked. Stays open until that lane finishes.",
    needsNote: true,
    closes: false,
  },
  dismiss: {
    key: "dismiss",
    label: "Not needed",
    hint: "Closes the item with your reason.",
    needsNote: true,
    closes: true,
  },
};

export function actionsAvailable() {
  return Boolean(ACTION_API);
}

async function post(pathname, body) {
  const response = await fetch(`${ACTION_API}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

/**
 * Record an owner action.
 *
 * Returns the fresh owner-action list from the server rather than mutating
 * local state optimistically: the write goes through exception.mjs and may
 * legitimately not remove the item (a ruling keeps it open for the filing
 * lane), so the server's view is the only honest one to render.
 */
export async function recordAction({ id, action, note = "" }) {
  if (!ACTION_API) throw new Error("no action API configured");
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`unknown action ${action}`);
  if (spec.needsNote && !String(note).trim()) {
    throw new Error("this action needs a note");
  }
  return post("/api/act", { id, action, note });
}

export async function fetchDecisions() {
  if (!ACTION_API) return [];
  try {
    const response = await fetch(`${ACTION_API}/api/decisions`);
    if (!response.ok) return [];
    const payload = await response.json();
    return payload.decisions || [];
  } catch {
    return [];
  }
}

// The ruling tray — client state for "N rulings, ONE Windows prompt".
//
// Owner request 2026-08-22: the per-act dialog was the friction. The server
// keeps every security property (one enumerated prompt, per-item binding and
// staleness); this module only holds WHICH acts she has queued, so it is
// deliberately dumb state: no verification material, no authority, nothing a
// copy of sessionStorage could replay into a ruling.
//
// Module-scoped rather than lifted React state because the briefing scene
// RECOMPOSES on every selection — cards unmount wholesale — and a tray that
// forgets its queue on navigation teaches her not to trust it. sessionStorage
// keeps it across an accidental reload for the same reason.

const KEY = "continuity.rulingTray";

function load() {
  try {
    const raw = JSON.parse(globalThis.sessionStorage?.getItem(KEY) || "{}");
    return { mode: Boolean(raw.mode), items: Array.isArray(raw.items) ? raw.items : [] };
  } catch {
    return { mode: false, items: [] };
  }
}

let state = load();
const listeners = new Set();

function commit(next) {
  state = next;
  try { globalThis.sessionStorage?.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export const rulingTray = {
  get: () => state,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  setMode(on) { commit({ ...state, mode: Boolean(on) }); },

  /** Queue one act. One entry per exception — a later act replaces an earlier
   *  one, mirroring the server's one-ruling-per-exception-per-prompt rule. */
  add(entry) {
    if (!entry?.id || !entry?.action) return;
    const items = state.items.filter((x) => x.id !== entry.id).concat([{ ...entry, queuedAt: Date.now() }]);
    commit({ ...state, items });
  },

  remove(id) { commit({ ...state, items: state.items.filter((x) => x.id !== id) }); },
  clear() { commit({ ...state, items: [] }); },

  /** After an apply: drop what landed (or is definitively refused), keep the rest. */
  settle(results) {
    const done = new Set((results || []).filter((r) => r.ok || r.failure === "stale_owner_operation").map((r) => r.exception_id));
    commit({ ...state, items: state.items.filter((x) => !done.has(x.id)) });
  },
};

// The FIXTURE owner-read client — for visual review only.
//
// Its safety is structural, not a flag. There is no fetch here, no endpoint
// path, and `unlock()` cannot open anything: it returns a canned refusal
// explaining that a fixture cannot verify her. A caller holding this object has
// no route to a Windows prompt or to a real session, so the review route can be
// screenshotted on a machine with no host running at all.
//
// This is also why the four states are a FIXTURE CONTROL rather than something
// the live gate can be talked into. The live route and this one load different
// modules, so a query string cannot move the live gate into "unlocked".

export const GATE_FIXTURES = ["locked", "unlocked", "prepared", "expired"];

/** Fixed instants, so a screenshot is byte-stable across runs. */
const FIXED_NOW = Date.UTC(2026, 7, 22, 4, 30, 0);
const FIXED_EXPIRY = FIXED_NOW + 3 * 60 * 1000 + 42 * 1000;

export const FIXTURE_PREPARED = {
  title: "Authorize one bounded DataScape task",
  // The host's own prompt text, copied from what `promptForReceipt()` produces
  // for this receipt shape. The gate refuses to draw this panel without it,
  // precisely so a fixture cannot invent a friendlier dialog than the real one.
  prompt_preview: [
    "Authorize one bounded DataScape task",
    "Scope: continuity/briefing, continuity/authority",
    "Paid usage: $0",
  ].join("\n"),
  scope_refs: ["continuity/briefing", "continuity/authority"],
};

export function createOwnerReadFixtureClient(state = "locked") {
  const fixture = GATE_FIXTURES.includes(state) ? state : "locked";
  const open = fixture === "unlocked" || fixture === "prepared";

  return {
    mode: "fixture",
    fixture,
    // Structural: the review route holds no transport, so there is nothing here
    // that could reach the host even if something asked it to.
    holdsTransport: false,
    prepared: fixture === "prepared" ? FIXTURE_PREPARED : null,
    now: () => FIXED_NOW,

    async status() {
      return {
        ok: true,
        open,
        expires_at: open ? FIXED_EXPIRY : null,
        permits: ["context", "current", "blocker", "catalogue", "suggestions", "draft", "prepare_authority"],
      };
    },

    async unlock() {
      return {
        ok: false,
        failure: "fixture_cannot_verify",
        reason: "This is the review route. Verification happens on the live route, against the host.",
      };
    },

    async lock() {
      return { ok: true, unlocked: false };
    },
  };
}

/**
 * The "expired" fixture needs the gate to have SEEN an open window, because
 * that is the only thing separating "expired" from "locked" — the host reports
 * both as closed. Rather than let the review route reach into the component's
 * internals, the fixture says so and the route seeds it.
 */
export function fixtureSawOpenSession(state) {
  return state === "expired";
}

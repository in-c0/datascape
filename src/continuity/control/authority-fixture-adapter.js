// The REVIEW adapter — spec V6.1.5 PR B §1, revised per the governance review.
//
// This module is the whole reason the review route is safe, and its safety is
// a property of what it does not contain rather than of a flag it checks.
//
// It imports no authority store, no endpoint client and no owner boundary.
// There is no `authorize`, `narrow`, `revoke` or `commit` on the object it
// returns — only `simulate`, which moves a screenshot along and touches
// nothing. A caller holding this cannot write authority by any path.
//
// It also owns the `?state=F1..F7` interpretation. Those fixture URL controls
// belong exclusively to the review route; the shell no longer knows they exist.

import { fixtureStates, SCOPE_CATALOGUE } from "./authority-fixture.js";

const AUTHORIZED_STATES = ["F3", "F5", "F6", "F7"];
const EDITING_STATES = ["F2", "F4"];
const CANARY_STATES = ["F4", "F5"];

export function createFixtureAuthorityAdapter({ state = "F1", step = null } = {}) {
  const fixtures = fixtureStates();
  const seed = fixtures[Object.keys(fixtures).find((k) => k.startsWith(state))] || fixtures.F1_no_authority;

  let simulated = seed.authorized
    ? {
      state: seed.revoked ? "revoked" : seed.narrowed_to ? "narrowed" : "authorized",
      revision: seed.revoked ? 3 : seed.narrowed_to ? 2 : 1,
      fixture: true,
    }
    : null;

  return {
    mode: "review",
    // Structural, and asserted in tests: this adapter cannot mutate anything.
    canWriteAuthority: false,

    initialStep() {
      if (step) return step;
      if (AUTHORIZED_STATES.includes(state)) return "authorized";
      if (EDITING_STATES.includes(state)) return "goal";
      return "choose";
    },

    initialPath() {
      if (CANARY_STATES.includes(state)) return "canary";
      return state === "F1" ? null : "goal";
    },

    readCurrentAuthority() {
      return simulated;
    },

    readBlocker() {
      return { id: "fixture-blocker", title: "V6 execution authority (fixture)", fixture: true };
    },

    scopeCatalogue() {
      return SCOPE_CATALOGUE;
    },

    // Owner-authored evidence, from the fixture. Same rules as the live route:
    // the text may seed the goal field and nothing else.
    suggestions() {
      return [{
        starting_text: "Keep the portfolio's surfaces working while I am not looking at them.",
        source_ref: "brief 2026-08-09",
        pre_authorized: false,
        capabilities_prechecked: [],
      }];
    },

    seedDraft() {
      return seed.draft ?? null;
    },

    /**
     * Advance the mock. Deliberately NOT named `authorize`: the review route
     * must not have a method whose name a future edit could wire to a real
     * transaction by habit.
     */
    simulate(action) {
      const next = {
        authorize: { state: "authorized", revision: 1 },
        narrow: { state: "narrowed", revision: (simulated?.revision ?? 1) + 1 },
        revoke: { state: "revoked", revision: (simulated?.revision ?? 1) + 1 },
      }[action];
      if (next) simulated = { ...next, fixture: true };
      return simulated;
    },
  };
}

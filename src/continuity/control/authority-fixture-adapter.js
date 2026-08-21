// The REVIEW adapter — spec V6.1.5 PR B §1.
//
// This module is the whole reason the review route is safe, and its safety is
// a property of what it does not contain rather than of a flag it checks.
//
// It imports no authority store, no live adapter, and no owner boundary. There
// is no `authorize`, `narrow`, `revoke` or `commit` on the object it returns.
// A caller holding this cannot write authority by any path, so changing a
// query string cannot turn a fixture caller into an authenticated owner one.
//
// The rejected alternative was one privileged component with
// `if (reviewMode) disableWriteButton()` — which keeps the write path present
// and one bug away from reachable.

import { fixtureStates, SCOPE_CATALOGUE } from "./authority-fixture.js";

export function createFixtureAuthorityAdapter({ state = "F1" } = {}) {
  const fixtures = fixtureStates();
  const seed = fixtures[Object.keys(fixtures).find((k) => k.startsWith(state))] || fixtures.F1_no_authority;

  return {
    mode: "review",
    // Structural, and asserted in tests: this adapter cannot mutate anything.
    canWriteAuthority: false,

    readCurrentAuthority() {
      return seed.authorized
        ? {
          revision: seed.revoked ? 3 : seed.narrowed_to ? 2 : 1,
          state: seed.revoked ? "revoked" : "authorized",
          record: seed.draft,
          fixture: true,
        }
        : null;
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
      return seed.draft;
    },
  };
}

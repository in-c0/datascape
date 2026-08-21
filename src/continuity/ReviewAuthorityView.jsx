// The REVIEW route — spec V6.1.5 PR B §1.
//
// Fixture-only, and structurally so: this module's entire import graph contains
// no authority store, no authority client and no owner boundary. There is
// nothing here to disable, because there is nothing here that could write.
//
// `ops/v615-prb-report.mjs` asserts that by walking the graph, so the property
// is checked rather than described.

import AuthorityShell from "./AuthorityShell.jsx";
import { createFixtureAuthorityAdapter } from "./control/authority-fixture-adapter.js";

export default function ReviewAuthorityView() {
  const state = new URLSearchParams(window.location.search).get("state") || "F1";
  return <AuthorityShell adapter={createFixtureAuthorityAdapter({ state })} />;
}

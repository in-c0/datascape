// The REVIEW route — spec V6.1.5 PR B §1.
//
// Fixture-only, and structurally so: this module's entire import graph contains
// no authority store, no endpoint client and no owner boundary. There is
// nothing here to disable, because there is nothing here that could write.
//
// It also owns the `?state=` / `?step=` fixture controls. The shell no longer
// interprets them, so the live route cannot be talked into a fixture state by
// a query string.

import AuthorityShell from "./AuthorityShell.jsx";
import { createFixtureAuthorityAdapter } from "./control/authority-fixture-adapter.js";

export default function ReviewAuthorityView() {
  const params = new URLSearchParams(window.location.search);
  const adapter = createFixtureAuthorityAdapter({
    state: params.get("state") || "F1",
    step: params.get("step") || null,
  });
  return <AuthorityShell adapter={adapter} />;
}

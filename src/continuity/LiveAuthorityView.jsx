// The LIVE route — spec V6.1.5 PR B §1, §3, §5, §8.
//
// This composition may write authority. It obtains the client from the
// application boundary rather than constructing one with an `authenticate()`
// of its own — a component that could supply its own authenticator would keep
// the PR A API shape while destroying the property it exists for.
//
// HELD UNMERGED: until governance review, `window.__continuityAuthority` is
// never provided by the app shell, so the live route renders read-only and no
// click anywhere can create a ruling.

import AuthorityShell from "./AuthorityShell.jsx";
// Imported so the live route's dependency graph structurally CONTAINS the real
// authority writer — that is the property the governance audit checks. It is
// only constructed when the application session layer supplies a boundary,
// which it deliberately does not yet.
import { createAuthorityClient } from "./control/authority-client.js";

export default function LiveAuthorityView() {
  // Supplied by the application session layer, not by React and not by a
  // query string. Absent today, deliberately.
  const provided = globalThis.__continuityAuthority ?? null;
  // The session boundary is the application's to provide. React never
  // constructs an authenticate(): a component that could supply its own
  // authenticator would keep the API shape while destroying the property.
  const adapter = provided?.session
    ? createAuthorityClient(provided)
    : provided;

  if (!adapter) {
    return (
      <div className="au">
        <div className="au__shell">
          <header className="au__top">
            <div className="au__brand">Datascape <span>/ Autonomy</span></div>
            <a className="au__back" href="?view=briefing">Back to briefing</a>
          </header>
          <div className="au__ask">
            <h1>Autonomy is not connected yet.</h1>
            <p>
              The authoring surface is built and the persistence layer is built, but the
              write path between them is deliberately not wired. Nothing here can grant
              authority today.
            </p>
          </div>
          <p className="au__reviewnote">
            Live route, no authority adapter provided. Preview the surface at{" "}
            <a href="?view=authority-review">?view=authority-review</a>.
          </p>
        </div>
      </div>
    );
  }
  return <AuthorityShell adapter={adapter} />;
}

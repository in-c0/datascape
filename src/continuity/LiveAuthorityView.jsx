// The LIVE route — spec V6.1.5 PR B §1, revised per the governance review
// (P0-1, P0-2).
//
// This module imports ONLY the endpoint client: a thin transport that can send
// a request and read a reply. It holds no store, no journal and no owner
// boundary, so there is no authenticator here for page JavaScript to supply or
// replace.
//
// The earlier version read a capability off `globalThis.__continuityAuthority`
// and constructed the real client when that object carried a `.session`. That
// satisfied "no actor field in the payload" while reintroducing the same hole
// one level up — same-page code could keep the genuine storage capability and
// swap the session object, and the browser would be authenticating itself
// again.
//
// It also ignores `?state=` entirely. Fixture controls belong to the review
// route.
//
// HELD UNMERGED: no privileged endpoint is served in this build, so the route
// renders read-only and says so.

import AuthorityShell from "./AuthorityShell.jsx";
import { createAuthorityEndpointClient } from "./control/authority-endpoint-client.js";

/** Is a privileged authority endpoint actually being served? */
function endpointAvailable() {
  return Boolean(globalThis.__continuityAuthorityEndpoint);
}

export default function LiveAuthorityView() {
  if (!endpointAvailable()) {
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
              The authoring surface is built and the persistence layer is built, but no
              privileged authority endpoint is being served. Nothing here can grant
              authority today.
            </p>
          </div>
          <p className="au__reviewnote">
            Live route, no authority endpoint. Preview the surface at{" "}
            <a href="?view=authority-review">?view=authority-review</a>.
          </p>
        </div>
      </div>
    );
  }
  // The endpoint path is the only thing the page supplies, and a path is not an
  // identity: the privileged process authenticates the caller itself.
  return <AuthorityShell adapter={createAuthorityEndpointClient({ endpoint: globalThis.__continuityAuthorityEndpoint })} />;
}

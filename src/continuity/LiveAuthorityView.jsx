// The LIVE route — spec V6.1.5 PR B §1, completed per V6.1.6 PR B §2.
//
// This module imports ONLY the endpoint client: a thin transport that can send
// a request and read a reply. It holds no store, no journal and no owner
// boundary, so there is no authenticator here for page JavaScript to supply or
// replace.
//
// It also no longer discovers an endpoint. An earlier version read
// `globalThis.__continuityAuthorityEndpoint` and passed it to the client, which
// left the last page-selectable endpoint hook in place: a page that could set
// that global could return fabricated authority state, or receive her drafts.
// The client now uses the fixed same-origin path and nothing else.
//
// The page may PROBE whether that fixed endpoint is being served. Probing is
// not selecting.
//
// HELD: no privileged endpoint is served in this build, so the route renders
// read-only and says so.

import { useEffect, useState } from "react";
import AuthorityShell from "./AuthorityShell.jsx";
import OwnerReadGate from "./OwnerReadGate.jsx";
import { createOwnerReadClient } from "./control/owner-read-client.js";
import { AUTHORITY_ENDPOINT, createAuthorityEndpointClient } from "./control/authority-endpoint-client.js";

export default function LiveAuthorityView() {
  // `null` while probing, then true/false. The three states below are
  // deliberately distinct: "host unavailable" is not an authorization state
  // (spec V6.1.6 PR B §13).
  const [available, setAvailable] = useState(null);

  useEffect(() => {
    let live = true;
    // A probe of the FIXED path. Its result decides whether to render the
    // surface — it never decides where requests go.
    fetch(`${AUTHORITY_ENDPOINT}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    })
      .then((response) => { if (live) setAvailable(response.ok); })
      .catch(() => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, []);

  if (available !== true) {
    return (
      <div className="au">
        <div className="au__shell">
          <header className="au__top">
            <div className="au__brand">Datascape <span>/ Autonomy</span></div>
            <a className="au__back" href="?view=briefing">Back to briefing</a>
          </header>
          <div className="au__ask">
            <h1>{available === null ? "Checking…" : "Autonomy is not connected yet."}</h1>
            <p>
              {available === null
                ? "Looking for the authority host."
                : "The authoring surface is built and the persistence layer is built, but no privileged authority endpoint is being served. Nothing here can grant authority today."}
            </p>
          </div>
          {available === false && (
            <p className="au__reviewnote">
              Live route, no authority endpoint. Preview the surface at{" "}
              <a href="?view=authority-review">?view=authority-review</a>.
            </p>
          )}
        </div>
      </div>
    );
  }

  // The GATE, not a lookalike: the live route mounts the same component the
  // review route screenshots, differing only in which client it is handed.
  //
  // It wraps the shell rather than sitting beside it, so the authority surface
  // is not reachable at all without a live owner-read session. That is a
  // presentation guarantee only — the host authenticates every request on its
  // own, and would refuse an unlocked caller even if this markup were removed.
  return (
    <OwnerReadGate client={createOwnerReadClient()}>
      <AuthorityShell adapter={createAuthorityEndpointClient()} />
    </OwnerReadGate>
  );
}

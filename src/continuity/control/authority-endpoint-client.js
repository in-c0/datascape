// The BROWSER side of the authority boundary — PR B governance review, P0-1.
//
// This module can do exactly one thing: send a request to a privileged
// endpoint and read the reply. It imports no store, no owner boundary and no
// journal, so there is nothing here to authenticate WITH.
//
// The previous shape read a capability off `globalThis.__continuityAuthority`
// and, if it carried a `.session`, constructed the real client from it. That
// still satisfied "no actor field in the payload" while quietly reintroducing
// the same hole one level up: same-page code could keep the genuine storage
// capability and swap the session object, and the browser would be supplying
// its own authenticator again.
//
// Now the page cannot supply an authenticator because the page has no code
// that consumes one.

export const AUTHORITY_ENDPOINT = "/__continuity/authority";

export function createAuthorityEndpointClient({ endpoint = AUTHORITY_ENDPOINT, transport = globalThis.fetch } = {}) {
  if (typeof transport !== "function") throw new Error("an authority endpoint client requires a transport");

  const call = async (op, body) => {
    const response = await transport(`${endpoint}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Credentials travel as the ambient session (cookie / IPC identity), which
      // the page cannot read or forge into a different principal.
      credentials: "same-origin",
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      return { ok: false, failure: "transaction_failed", reason: `endpoint returned ${response.status}` };
    }
    return response.json();
  };

  return {
    mode: "live",
    canWriteAuthority: true,
    // Structural: the page half of the boundary holds no authenticator and no
    // storage, so it cannot decide who the caller is.
    holdsAuthenticator: false,

    authorize: (request) => call("authorize", request),
    readCurrentAuthority: (goalId) => call("current", { goal_id: goalId }),
    readBlocker: () => call("blocker", {}),
    scopeCatalogue: () => call("catalogue", {}),
    suggestions: () => call("suggestions", {}),
    seedDraft: () => call("draft", {}),
  };
}

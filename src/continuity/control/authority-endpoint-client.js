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

/**
 * The browser may PROBE whether the fixed endpoint exists. It may not supply
 * one (spec V6.1.6 §1).
 *
 * A page-chosen endpoint could return fabricated authority state, or receive
 * her authority drafts. The path is therefore a constant here, and the
 * `endpoint` option exists only so tests can point at a fake transport — it is
 * refused whenever the transport is the real one.
 */
export function createAuthorityEndpointClient({ endpoint = AUTHORITY_ENDPOINT, transport = globalThis.fetch } = {}) {
  if (typeof transport !== "function") throw new Error("an authority endpoint client requires a transport");
  const usingRealTransport = transport === globalThis.fetch;
  if (usingRealTransport && endpoint !== AUTHORITY_ENDPOINT) {
    throw new Error("the authority endpoint is fixed; the page may not choose one");
  }

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

    // TWO STEPS, and `authorize` is gone.
    //
    // The old single-shot `authorize(request)` sent the draft, the policy
    // identity, the goal id, the expected revision and the resulting scope —
    // every authoritative field — and the host has stopped accepting them. A
    // client that still offered it would be offering a route to a transaction
    // that refuses it, so it is removed rather than deprecated.

    /** Intent goes here, and only here. The host normalizes and decides. */
    prepareAuthority: (request) => call("prepare", request),

    /**
     * The commit wire: two opaque strings.
     *
     * Nothing else is accepted here, and nothing else is offered. The host
     * refuses an authoritative field by name rather than ignoring it, so a
     * client that quietly added one would fail loudly — but the better
     * guarantee is that there is no parameter to add one through.
     */
    commitAuthority: ({ operationId, previewReceipt }) => call("commit", {
      operation_id: operationId,
      preview_receipt: previewReceipt,
    }),

    /** A committed operation, replayed after a restart. No receipt needed. */
    replayAuthority: (operationId) => call("commit", { operation_id: operationId }),
    // ONE contextual read. The page never learns or sends a goal id.
    authorityContext: () => call("context", {}),
    readCurrentAuthority: (goalId) => call("current", { goal_id: goalId }),
    readBlocker: () => call("blocker", {}),
    scopeCatalogue: () => call("catalogue", {}),
    suggestions: () => call("suggestions", {}),
    seedDraft: () => call("draft", {}),
  };
}

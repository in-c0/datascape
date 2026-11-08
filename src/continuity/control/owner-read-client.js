// The browser half of the owner-read session — the lock/unlock transport.
//
// Same shape and same discipline as `authority-endpoint-client.js`: this module
// can send a request to a FIXED same-origin path and read the reply. It holds
// no session, no token and no authenticator, because the session id is an
// HttpOnly cookie the page is never given.
//
// That is the point worth stating plainly: everything this client reports about
// lock state is the HOST's answer to `status`, not the browser's own belief. A
// countdown rendered from `expires_at` is a convenience for her; it is never
// the thing that decides whether she is unlocked.

// The state labelling lives in `owner-read-state.js` so the shared gate
// component can reach it WITHOUT importing this transport.
export { gateStateFrom } from "./owner-read-state.js";

export const OWNER_READ_ENDPOINT = "/__continuity/authority";

/**
 * `endpoint` exists only so tests can point at a fake transport, and is refused
 * whenever the transport is the real one — a page-chosen endpoint could report
 * "unlocked" for a host that never verified her.
 */
export function createOwnerReadClient({ endpoint = OWNER_READ_ENDPOINT, transport = globalThis.fetch } = {}) {
  if (typeof transport !== "function") throw new Error("an owner-read client requires a transport");
  if (transport === globalThis.fetch && endpoint !== OWNER_READ_ENDPOINT) {
    throw new Error("the authority endpoint is fixed; the page may not choose one");
  }

  const failure = (response) => ({
    ok: false,
    failure: response.status === 503 ? "host_unavailable" : "request_failed",
    status: response.status,
  });

  return {
    mode: "live",

    /**
     * Ask the host whether THIS browser holds a live session.
     *
     * Request-scoped on the host: an answer of `open: false` means this
     * browser is locked, not that the machine is.
     */
    async status() {
      const response = await transport(`${endpoint}/status`, {
        method: "GET",
        credentials: "same-origin",
      });
      if (!response.ok) return failure(response);
      const body = await response.json();
      return { ok: true, ...body };
    },

    /**
     * Ask for a Windows verification, and a five-minute window if it succeeds.
     *
     * This is the ONE call in the surface that can cause a dialog to appear,
     * which is why it is only ever reached from an explicit click.
     */
    async unlock() {
      const response = await transport(`${endpoint}/unlock_read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          ok: false,
          failure: body.error || failure(response).failure,
          reason: body.reason || body.detail || null,
          retry_after_ms: body.retry_after_ms ?? null,
        };
      }
      return { ok: true, ...body };
    },

    /** End the window early. Requires the current cookie; no prompt. */
    async lock() {
      const response = await transport(`${endpoint}/lock_read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, failure: body.error || failure(response).failure };
      return { ok: true, ...body };
    },
  };
}

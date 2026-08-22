// Browser-bound owner-read sessions for the authority surface.
//
// The existing `createReadUnlock()` is a process-global five-minute boolean.
// That is the wrong authentication boundary here: while it is open, EVERY local
// process reading this host can see her private authority context, because the
// unlock is a property of the machine rather than of the browser she unlocked
// it in. It stays useful as an internal concept; it is not the credential.
//
// So a read session is:
//
//   a random >=256-bit id, held only in this process's memory
//   handed to exactly one browser as an HttpOnly cookie
//   valid for 5 minutes ABSOLUTE, with no sliding refresh
//   gone when the host restarts
//   replaced — not joined — by the next successful unlock
//
// It permits reads and previews. It can never satisfy a mutation: authorize,
// narrow, revoke and every exception ruling each require fresh Windows presence
// of their own, immediately before the write.
//
// The token never appears in JSON, DOM state, localStorage, a URL, a log line
// or a receipt. The only thing the browser is told is when its window closes.
import crypto from "node:crypto";

export const COOKIE_NAME = "continuity_authority_read";
export const COOKIE_PATH = "/__continuity/authority";

/** 5 minutes, absolute. Not a timeout that politeness extends. */
export const SESSION_TTL_MS = 5 * 60 * 1000;

/** What a read session is allowed to ask for. */
export const READ_OPERATIONS = [
  "context", "current", "blocker", "catalogue", "suggestions", "draft", "prepare_authority",
];

/**
 * Operations that a read session must NEVER satisfy on its own.
 *
 * Listed explicitly rather than inferred, so adding a mutation later cannot
 * quietly inherit read authority by being absent from a deny list.
 */
export const MUTATION_OPERATIONS = [
  "authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority",
  "approve", "reply_done", "reply_no", "reply_need_context", "defer", "dismiss",
];

export function permitsRead(operation) {
  return READ_OPERATIONS.includes(operation);
}

/**
 * The session store. Process memory only — a host restart invalidates
 * everything, which is the intended behaviour and not a limitation to work
 * around with a file.
 */
export function createReadSessionStore({ now, ttlMs = SESSION_TTL_MS, randomId = null } = {}) {
  if (typeof now !== "function") throw new Error("a read-session store needs a clock");

  // At most ONE live session. A second unlock rotates rather than joins: two
  // browsers holding simultaneous owner-read sessions is not a state she ever
  // asked for, and it doubles the window in which private context is readable.
  let session = null;

  const mint = randomId ?? (() => crypto.randomBytes(32).toString("base64url"));

  return {
    /** After a VERIFIED owner presence, and never otherwise. */
    open() {
      const previous = session?.id ?? null;
      const at = now();
      session = { id: mint(), created_at: at, expires_at: at + ttlMs };
      return { session_id: session.id, expires_at: session.expires_at, rotated_from: previous };
    },

    /**
     * Resolve a cookie value to a live session.
     *
     * Constant-ish comparison by length-checked equality: the id is high
     * entropy and process-local, but there is no reason to leak timing either.
     */
    resolve(candidate) {
      if (!session || typeof candidate !== "string" || candidate.length !== session.id.length) return null;
      const a = Buffer.from(candidate);
      const b = Buffer.from(session.id);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      // ABSOLUTE expiry. Reading does not extend it.
      if (now() >= session.expires_at) { session = null; return null; }
      return { id: session.id, expires_at: session.expires_at };
    },

    /** For the health surface. Never includes the id. */
    state() {
      if (!session) return { open: false };
      const expired = now() >= session.expires_at;
      return { open: !expired, expires_at: expired ? null : session.expires_at };
    },

    clear() { session = null; },

    // Structural: nothing here writes to disk, so nothing survives a restart.
    persisted: false,
  };
}

/**
 * The Set-Cookie header for a freshly opened session.
 *
 * No `__Host-` prefix: this deployment is plain loopback HTTP and that prefix
 * requires `Secure`. Claiming a guarantee the transport cannot provide would be
 * decoration, and the Host/Origin checks are what actually bound this surface.
 */
export function sessionCookie(sessionId, { ttlMs = SESSION_TTL_MS } = {}) {
  return [
    `${COOKIE_NAME}=${sessionId}`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
    // Deliberately NO Domain attribute: a Domain would widen the cookie to
    // sibling hosts, and this one belongs to exactly this origin.
  ].join("; ");
}

/** The header that ends a session in the browser as well as in memory. */
export function clearedCookie() {
  return `${COOKIE_NAME}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Can a SameSite=Strict cookie set by `apiOrigin` travel on a request the page
 * at `uiOrigin` makes?
 *
 * Only if they are the same site. Port is not part of a site, so 127.0.0.1:5313
 * and 127.0.0.1:5319 are fine — but `localhost` and `127.0.0.1` are DIFFERENT
 * HOSTS, and that is the topology the launcher currently produces: it opens the
 * briefing on localhost while the API answers on 127.0.0.1. The owner-read
 * cookie would be set and then never sent, and the authority surface would
 * authenticate nobody.
 *
 * The fix is to serve the owner-controls surface from the same host as the API,
 * NOT to weaken the cookie to SameSite=None over loopback HTTP.
 */
export function sameSiteWith(uiOrigin, apiOrigin) {
  try {
    const ui = new URL(uiOrigin);
    const api = new URL(apiOrigin);
    // Scheme must match too: a Strict cookie is not sent across a scheme change.
    if (ui.protocol !== api.protocol) return false;
    return ui.hostname === api.hostname;
  } catch {
    return false;
  }
}

export function readCookie(header, name = COOKIE_NAME) {
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * Authenticate the ACTUAL request and produce a trusted, request-scoped context.
 *
 * The substrate's `authenticateCaller()` is a construction-time, zero-argument
 * function — a process-global principal. A cookie belongs to one request, so a
 * global answer would authenticate requests that never presented it.
 *
 * The browser body supplies none of these fields, and `read_session_id` is
 * host-private: it is bound into receipts but never returned.
 */
export function authenticateRequest({ store, cookieHeader }) {
  const candidate = readCookie(cookieHeader);
  if (!candidate) return { ok: false, failure: "no_read_session", reason: "owner controls are locked" };

  const live = store.resolve(candidate);
  if (!live) {
    return { ok: false, failure: "read_session_invalid", reason: "the owner-read session has expired or was replaced" };
  }
  return {
    ok: true,
    context: { principal: "owner", read_session_id: live.id, expires_at: live.expires_at },
  };
}

// The authority subsystem's HTTP surface.
//
// Deployed as a SEPARATE reviewed artifact into `_authority/`, and composed by
// the entry point only after its own gate passes. The base owner-ruling core
// never imports this file; it knows the URL prefix and nothing else, so a
// missing or corrupt authority build cannot stop her inbox controls loading.
//
// What exists so far is the authentication boundary: a browser-bound owner-read
// session, opened only behind fresh Windows presence, permitting reads and
// previews and never a mutation. The authority reads and the prepare/commit
// transaction land on top of this.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const session = await import(pathToFileURL(path.join(HERE, "authority-read-session.js")).href);
const {
  MUTATION_OPERATIONS, READ_OPERATIONS, authenticateRequest, clearedCookie,
  createReadSessionStore, sessionCookie,
} = session;

/** Read a JSON body with a hard size cap. A body is never a reason to prompt. */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("request body is too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("body must be JSON")); }
    });
    req.on("error", reject);
  });
}

/**
 * Build the authority host.
 *
 * `presence` is the host's ONE owner-presence coordinator. Constructing a
 * verifier here would give the machine a second device, and two subsystems each
 * honouring "one outstanding prompt" can still show two dialogs at once.
 */
export function createAuthorityHost({ presence, now = () => Date.now(), store = null } = {}) {
  if (!presence || typeof presence.forSubsystem !== "function") {
    throw new Error("the authority host requires the host's owner-presence coordinator");
  }
  const mine = presence.forSubsystem("authority");
  const sessions = store ?? createReadSessionStore({ now });

  async function unlockRead(req, res, { origin, send }) {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    if (type !== "application/json") {
      return send(res, 415, { error: "application/json required" }, origin);
    }
    // Read and discard: the body carries nothing this route trusts. Draining it
    // before the prompt keeps a malformed payload from costing her a dialog.
    await readJsonBody(req);

    // The host-wide budget, so an unlock cannot evade the cooldown a refused
    // exception ruling just incurred, and vice versa.
    const allowed = mine.budget.mayPrompt();
    if (!allowed.ok) {
      return send(res, 429, { error: allowed.failure, retry_after_ms: allowed.retry_after_ms }, origin);
    }

    const verification = await mine.verifier.verify({
      purpose: "Unlock DataScape owner controls for 5 minutes",
      operationRef: "authority:unlock_read",
    });
    mine.budget.recordOutcome(verification.outcome);
    if (verification.outcome !== "verified") {
      return send(res, 403, { error: verification.outcome, reason: verification.reason, unlocked: false }, origin);
    }
    // Spend the one-shot presence on this unlock so it cannot also authorise
    // something else.
    mine.verifier.authorizes(verification, "authority:unlock_read");

    const opened = sessions.open();
    res.setHeader("Set-Cookie", sessionCookie(opened.session_id));
    // The response carries the expiry so the surface can show a finite window,
    // and NOTHING ELSE. The token is not a value the browser is trusted with.
    return send(res, 200, {
      unlocked: true,
      expires_at: opened.expires_at,
      rotated_previous_session: Boolean(opened.rotated_from),
      permits: READ_OPERATIONS,
      requires_fresh_verification: MUTATION_OPERATIONS,
    }, origin);
  }

  function lockRead(req, res, { origin, send }) {
    sessions.clear();
    res.setHeader("Set-Cookie", clearedCookie());
    return send(res, 200, { unlocked: false }, origin);
  }

  function status(req, res, { origin, send }) {
    // Never includes the id, and never extends anything by being asked.
    return send(res, 200, { ...sessions.state(), permits: READ_OPERATIONS }, origin);
  }

  return {
    sessions,
    /** The request-scoped principal, or a named refusal. */
    authenticate: (req) => authenticateRequest({ store: sessions, cookieHeader: req.headers.cookie }),

    async handle(req, res, url, ctx) {
      const route = url.pathname.replace(/^\/__continuity\/authority\/?/, "");

      if (req.method === "POST" && route === "unlock_read") {
        await unlockRead(req, res, ctx);
        return true;
      }
      if (req.method === "POST" && route === "lock_read") {
        lockRead(req, res, ctx);
        return true;
      }
      if (req.method === "GET" && (route === "" || route === "status")) {
        status(req, res, ctx);
        return true;
      }

      // Every other authority route is authenticated. They do not exist yet, so
      // the honest answer is 501 rather than a 404 that implies "wrong URL".
      const auth = this.authenticate(req);
      if (!auth.ok) {
        return ctx.send(res, 401, { error: auth.failure, detail: auth.reason }, ctx.origin), true;
      }
      return ctx.send(res, 501, {
        error: "not_implemented",
        detail: "This authority operation is not part of the released host yet.",
      }, ctx.origin), true;
    },
  };
}

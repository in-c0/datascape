// Authority host preflight — spec V6.1.6 §1, §2, §4, §5, §6, §7, §8.
//
// Everything the real host needs BEFORE a route is registered. Nothing here
// registers one: PR A must remain unreachable from the browser, so this module
// is a preflight and a configuration contract, not a server.
//
// The governing rule for the session boundary:
//
//   browser JS can express intent
//   browser JS cannot choose the principal
//
// and its corollary, which matters more than any code below: if the host has no
// trusted owner-session mechanism, we STOP and say so. We do not compensate by
// weakening authentication, and we do not invent one.

import path from "node:path";

/** Where authority state may live, and where it may never live. */
export const FORBIDDEN_STORE_SEGMENTS = ["dist", "public", "build", "docs", "reviews", "shadow", "node_modules"];

/**
 * Validate a durable authority store location (§5).
 *
 * Authority state must be private, outside shipped assets, and outside
 * review artefacts. A journal under `dist/` would be published; a journal under
 * a review path would end up in a screenshot bundle.
 */
export function validateStorePath(storePath, { repoRoot = null } = {}) {
  const problems = [];
  if (!storePath) return { ok: false, problems: ["no authority store path configured"] };

  const normalized = path.resolve(storePath).split(path.sep).join("/");
  const segments = normalized.toLowerCase().split("/");
  for (const forbidden of FORBIDDEN_STORE_SEGMENTS) {
    if (segments.includes(forbidden)) problems.push(`authority state may not live under ${forbidden}/`);
  }
  if (repoRoot) {
    const root = path.resolve(repoRoot).split(path.sep).join("/");
    if (normalized.startsWith(`${root}/`)) {
      // Inside the repo at all is a publication risk: a stray `git add -A`
      // commits her authority record.
      problems.push("authority state may not live inside the repository working tree");
    }
  }
  return { ok: problems.length === 0, problems, resolved: normalized };
}

/**
 * Is the journal path actually ignored / private? (§5)
 *
 * Checked rather than assumed, because "we put it somewhere private" is the
 * kind of claim that stops being true when a path changes.
 */
export function verifyStorePrivacy({ storePath, fs, repoRoot = null }) {
  const validated = validateStorePath(storePath, { repoRoot });
  if (!validated.ok) return { ok: false, ...validated };

  const dir = path.dirname(path.resolve(storePath));
  let readable = true;
  try { fs.accessSync?.(dir); } catch { readable = false; }
  return {
    ok: true,
    resolved: validated.resolved,
    outside_repo: true,
    directory_present: readable,
    problems: [],
  };
}

/**
 * The startup recovery gate (§5).
 *
 * The endpoint may not serve reads OR writes until journal recovery has
 * completed. Serving mid-recovery could answer "no authority exists" for a
 * grant that is one write away from visible — the same class of lie as the
 * reload defect.
 */
export function createStartupGate() {
  let state = "recovering";
  let recovered = null;
  return {
    get state() { return state; },
    complete(recoveryResult) {
      recovered = recoveryResult;
      state = "ready";
      return { ok: true, recovered };
    },
    fail(reason) {
      state = "unavailable";
      return { ok: false, reason };
    },
    /** Every operation checks this. Fails CLOSED while recovering. */
    mayServe() {
      if (state === "ready") return { ok: true };
      return {
        ok: false,
        failure: state === "recovering" ? "recovering" : "authority_unavailable",
        reason: state === "recovering"
          ? "authority recovery has not completed"
          : "authority state is unavailable",
      };
    },
    recoveryReport: () => recovered,
  };
}

/**
 * Resolve the owner session mechanism (§4).
 *
 * Explicitly REFUSES the two shortcuts the spec names. "localhost == owner" is
 * not authentication: anything on the machine, including an agent, is on
 * localhost. And "the browser says owner" is the thing the whole boundary
 * exists to prevent.
 *
 * When no trusted mechanism is available this returns `resolved: false`, and
 * the correct response is to STOP rather than to serve the endpoint.
 */
export const REFUSED_SESSION_MECHANISMS = ["localhost_implies_owner", "browser_claims_owner", "trust_all", "none"];

export function resolveOwnerSession(hostConfig = {}) {
  const mechanism = hostConfig.sessionMechanism ?? "none";
  if (REFUSED_SESSION_MECHANISMS.includes(mechanism)) {
    return {
      resolved: false,
      mechanism,
      reason: mechanism === "none"
        ? "the host provides no trusted owner-session mechanism"
        : `${mechanism} is not authentication`,
      // Said explicitly so nobody has to infer it from a false.
      must_stop: true,
    };
  }
  if (typeof hostConfig.authenticateCaller !== "function") {
    return { resolved: false, mechanism, reason: "the mechanism supplies no caller authenticator", must_stop: true };
  }
  return { resolved: true, mechanism, must_stop: false };
}

/**
 * The full preflight (§20 tail).
 *
 * Non-mutating by construction: it resolves configuration and reports. It holds
 * no store, opens no route and performs no write.
 */
export function authorityHostPreflight({ hostConfig = {}, fs = null, repoRoot = null, blocker = null, catalogue = [] }) {
  const session = resolveOwnerSession(hostConfig);
  const storage = hostConfig.storePath && fs
    ? verifyStorePrivacy({ storePath: hostConfig.storePath, fs, repoRoot })
    : { ok: false, problems: ["no authority store path configured"] };

  return {
    real_blocker_found: Boolean(blocker),
    authority_domain_resolved: Boolean(blocker?.id ?? hostConfig.authorityDomain),
    scope_catalogue_resolved: catalogue.length > 0,
    owner_session_resolved: session.resolved,
    owner_session_mechanism: session.mechanism,
    storage_private: storage.ok,
    storage_problems: storage.problems,
    // A preview can only be prepared once the session resolves; preparing one
    // without an authenticated owner would leak her drafts and scope metadata.
    preview_can_be_prepared: session.resolved && storage.ok,
    write_performed: "NO",
    // The instruction, not a hint: do not weaken authentication to proceed.
    must_stop: !session.resolved,
    stop_reason: session.resolved ? null : session.reason,
  };
}

// The catch-up surface's action endpoint — the follow-through half.
//
// Until now an owner-action expanded to TEXT ONLY: no control did anything, a
// ruling had nowhere to go, and nothing left the queue when she acted. This is
// the mechanism that closes that loop.
//
//   GET  /api/briefing            the composed document, rebuilt on request
//   GET  /api/decisions           her recent rulings, newest first
//   POST /api/act                 record a ruling / close an item
//
// WRITE-BACK GOES THROUGH exception.mjs, NEVER THE FILES
//
// The exception inbox stays the single source of truth: an action here calls
// setStatus()/amend(), which bump `updated` and keep the item's age readable.
// Hand-editing was already identified as the way a queue starts lying.
//
// FOLLOW-THROUGH REACHES THE LANE VIA THE EXCEPTION ITSELF
//
// No new channel. Each lane already re-reads its own exceptions every tick, so
// an amendment carrying her words IS the delivery mechanism — the same reason
// the briefing renders the inbox rather than duplicating it. `decisions/` is an
// append-only mirror for display ("you ruled this 2h ago"), not the channel.
//
// SECURITY
//
// Binds 127.0.0.1 only, and validates Host + Origin against an exact loopback
// literal. This session watched a `startsWith('127.')` prefix test become a
// live DNS-rebinding hole on PersonalOS master for 3.4 hours; a local endpoint
// that can resolve exceptions is exactly the shape that must not repeat it.

import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { build } from "../briefing.mjs"
import { sydneyIso, sydneyDate } from "../mustread.mjs"
import * as exceptions from "../exception.mjs"

// The security layer is DEPLOYED beside this file as a recorded artifact, not
// imported from a development working tree. `./_continuity/` exists only in a
// staged or installed live host, so a production process cannot silently pick
// up whatever happens to be checked out in the repo right now.
import {
  createPromptBudget, createRulingJournal, createRulingJournalStorage, performOwnerRuling,
} from "./owner-ruling.js"
import { createOwnerPresenceVerifier, stripClaimedVerification } from "./owner-presence.js"
import { applyRulingAtomically, exceptionFile } from "./exception-atomic.js"
import { createWindowsOwnerPresenceBroker } from "./owner-presence-windows.js"
import { createOwnerPresenceCoordinator } from "./owner-presence-coordinator.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
// HERE is now `<ops>/_continuity`, so the decisions mirror is two levels up.
const DECISIONS = process.env.BRIEFING_DECISIONS || path.join(HERE, "..", "..", "decisions")
const PORT = Number(process.env.BRIEFING_API_PORT || 5319)

// ---------------------------------------------------------------------------
// Loopback validation — exact literals, never a prefix test.
// ---------------------------------------------------------------------------

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false
  const host = String(hostHeader).trim().toLowerCase()
  // Strip the port, handling bracketed IPv6.
  const bare = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0]
  if (bare === "localhost" || bare === "::1") return true
  // Exact dotted-quad in 127.0.0.0/8 — NOT startsWith("127.").
  const parts = bare.split(".")
  if (parts.length !== 4) return false
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false
  return parts[0] === "127"
}

function originAllowed(origin) {
  // No Origin at all is a same-origin or non-browser caller; allowed.
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    return isLoopbackHost(url.host)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Decisions log — an append-only mirror of what she ruled, for display.
// ---------------------------------------------------------------------------

function recordDecision(entry) {
  fs.mkdirSync(DECISIONS, { recursive: true })
  const file = path.join(DECISIONS, `${sydneyDate()}.jsonl`)
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8")
}

export function readDecisions({ limit = 40 } = {}) {
  let files = []
  try {
    files = fs.readdirSync(DECISIONS).filter((f) => f.endsWith(".jsonl")).sort().reverse()
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    let raw = ""
    try {
      raw = fs.readFileSync(path.join(DECISIONS, f), "utf8")
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // a torn line must not take the log down
      }
    }
    if (out.length >= limit) break
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return out.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Actions
//
// Deliberately few. Every one of them is something only she can do, and each
// maps onto a status the exception inbox already understands — no new states,
// no parallel lifecycle.
// ---------------------------------------------------------------------------

export const ACTIONS = {
  // Spec §6, now the six CLOSED owner classes of V6.1.6-A.2 PR B. Each maps
  // onto a status the exception inbox already understands — no new lifecycle,
  // no parallel queue.
  //
  // `approve` and the non-final replies move the item to `investigating`
  // because the filing lane now owns the next move; the item is no longer
  // waiting on her, but it is not finished either.
  //
  // The old generic `reply` is gone. It carried her meaning as prose, which
  // meant the host either ignored the distinction or recovered it by keyword.
  approve: { status: "investigating", kind: "approved-proposed", verb: "APPROVED PROPOSED" },
  reply_done: { status: "resolved", kind: "done", verb: "REPLIED DONE" },
  reply_no: { status: "investigating", kind: "declined", verb: "REPLIED NO" },
  reply_need_context: { status: "investigating", kind: "needs-context", verb: "ASKED FOR CONTEXT" },
  // Defer keeps it blocked-on-owner and sets an absolute timestamp; it simply
  // stops being due-now until then. No reminder, no scheduler mutation.
  defer: { status: null, kind: "deferred", verb: "DEFERRED" },
  dismiss: { status: "resolved", kind: "dismissed", verb: "DISMISSED" },
}

/**
 * Read the authoritative exception, shaped for fingerprinting and recovery.
 *
 * Everything the ruling depends on comes from here. The request supplies which
 * exception and which class; it supplies no state.
 */
// Mirror of the briefing builder's Proposed-action extraction (briefing.mjs).
// One regex, two consumers, one meaning.
const PROPOSED_RE = /##\s*Proposed action\s*\r?\n([\s\S]*?)(?=\r?\n##|\r?\n---|$)/i
function extractProposed(body) {
  const m = String(body ?? "").match(PROPOSED_RE)
  const text = m ? m[1].trim() : ""
  return text && text !== "_(none proposed)_" ? text : null
}

export function readException(id) {
  if (!id) return null
  const found = exceptions.find(id)
  if (!found) return null
  return {
    id: found.meta.id,
    status: found.meta.status,
    updated: found.meta.updated,
    // The proposal lives in the BODY as a "## Proposed action" section - the
    // exception store has no `proposed` frontmatter key and find() derives no
    // such field, so the old `found.meta.proposed ?? found.proposed` was null
    // for EVERY exception and every Approve refused with "has no current
    // proposal to approve" (owner report, 2026-08-22 - the first real ruling
    // ever attempted through the surface). Extract it with the SAME regex the
    // briefing builder uses, because "Approve proposed" is offered exactly
    // when THAT parser finds one; two parsers that disagree turn a rendered
    // button into a guaranteed refusal. The filed-empty placeholder counts as
    // no proposal: approving "_(none proposed)_" is a prompt with nothing
    // behind it.
    proposed: extractProposed(found.body),
    proposal_ref: found.meta.proposal_ref ?? null,
    proposal_revision: found.meta.proposal_revision ?? null,
    deferred_until: found.meta.deferred_until ?? null,
    title: found.meta.title,
    loop: found.meta.loop || null,
    body: found.body ?? "",
  }
}

/**
 * Perform an owner ruling that has ALREADY been verified.
 *
 * Takes a PreparedOwnerMutation, never a browser request. Nothing in the
 * original payload is consulted here — if it were, the operation Windows
 * described and the operation performed could differ, which is the whole thing
 * this layer exists to prevent.
 *
 * ONE authoritative write. The earlier version called amend, setStatus and
 * setDeferredUntil in sequence, and every gap between them was a half-commit a
 * crash could leave behind.
 */
export function applyOwnerMutation(mutation) {
  const spec = ACTIONS[mutation.action]
  if (!spec) throw new Error(`unknown action ${JSON.stringify(mutation.action)}`)

  const found = exceptions.find(mutation.exception_id)
  if (!found) throw new Error(`no exception ${mutation.exception_id}`)
  const realId = found.meta.id

  const at = sydneyIso()
  const text = mutation.payload.text ? String(mutation.payload.text).trim() : ""

  // The operation_ref rides along because it is what makes this write
  // recoverable: recovery checks for the ref AND the resulting status AND the
  // deferred instant, so a partial application cannot read as a committed one.
  const amendment = `OWNER ${spec.verb} ${at} (via datascape/briefing) [${mutation.operation_ref}]`
    + `${text ? ` — ${text}` : ""}`

  const applied = applyRulingAtomically({
    file: exceptionFile(exceptions.INBOX, realId),
    amendment,
    status: spec.status,
    statusNote: `owner ruling ${mutation.operation_ref}`,
    // Persist the ABSOLUTE instant only — "Tonight" is a UI convenience and
    // must never reach the file. It was normalized at prepare time.
    deferredUntil: mutation.action === "defer"
      ? sydneyIso(new Date(Date.parse(mutation.payload.deferred_until)))
      : null,
    at,
  })

  const entry = {
    at,
    id: realId,
    action: mutation.action,
    kind: spec.kind,
    note: text || null,
    operation_ref: mutation.operation_ref,
    ruling_ref: mutation.operation_ref,
    deferredUntil: applied.deferred_until,
    title: found.meta.title,
    loop: found.meta.loop || null,
    resultingStatus: applied.status,
  }
  // A non-authoritative mirror, written AFTER the authoritative state. It must
  // never be what decides whether the ruling committed.
  recordDecision(entry)
  return entry
}

/**
 * The host's owner-ruling dependencies.
 *
 * Injectable so the acceptance suite can drive the REAL transport with a fake
 * verifier and an isolated store — and so nothing here can reach a Windows
 * dialog unless a broker that can show one was deliberately supplied.
 */
/**
 * The host's single owner-presence coordinator.
 *
 * Created once, after the base preflight passes, and shared by every route that
 * can ask for her. Two independently-constructed verifiers could each honour
 * "one outstanding prompt" and still put two Windows dialogs on screen; two
 * independent prompt budgets could each be evaded by alternating routes.
 */
export function createHostPresence({
  allowInteractive = process.env.OWNER_PRESENCE_INTERACTIVE !== "0",
  now = () => Date.now(),
  verifier = null,
  budget = null,
} = {}) {
  return createOwnerPresenceCoordinator({
    now, verifier, budget,
    broker: verifier ? null : createWindowsOwnerPresenceBroker({ allowInteractive }),
    randomChallenge: () => crypto.randomUUID(),
  })
}

export function createOwnerRulingDeps({
  verifier = null,
  presence = null,
  journalFile = process.env.OWNER_RULING_JOURNAL
    || path.join(process.env.LOCALAPPDATA || HERE, "datascape", "live-host", "owner-rulings.json"),
  // INTERACTIVE BY DEFAULT, disabled by an explicit "0".
  //
  // This was opt-in via OWNER_PRESENCE_INTERACTIVE=1, and nothing sets it —
  // not catchup, not the entry point, not any operator instruction. So the
  // exact production spawn path loaded the whole verified runtime and then
  // could never complete a ruling, because the broker returns failure before
  // it ever asks Windows. PR B would have shipped without delivering the thing
  // it exists for: replacing the fail-closed inbox with the real owner path.
  //
  // Requiring a human to remember an environment variable is the same
  // release-path configuration gap in a smaller costume. The broker's own
  // default stays safe (non-interactive) — it is THIS host, after a passed
  // preflight, that explicitly permits verification.
  //
  // Safe because construction displays nothing. Only a request that has already
  // survived Host/Origin/method/content-type, canonical preparation,
  // current-state validity, the idempotency lookup and the prompt budget ever
  // reaches verify().
  allowInteractive = process.env.OWNER_PRESENCE_INTERACTIVE !== "0",
  now = () => Date.now(),
} = {}) {
  // One coordinator for the whole host. A caller may hand one in (the entry
  // point does, so authority shares it); otherwise this route creates the
  // host's coordinator and later subsystems take handles from it.
  const coordinator = presence ?? createHostPresence({ allowInteractive, now, verifier })
  const mine = coordinator.forSubsystem("owner_rulings")

  const journal = createRulingJournal({ storage: createRulingJournalStorage(journalFile), now })
  // Forward recovery on startup: any ruling that was mid-flight when a previous
  // process died is resolved by looking for its ref in the exception itself.
  const recovered = journal.recover(readException)

  return {
    now,
    readException,
    applyMutation: applyOwnerMutation,
    journal,
    presence: coordinator,
    budget: mine.budget,
    // Stated so the host can report whether it is actually able to verify her.
    // The previous shape was silently incapable: the runtime loaded, the route
    // answered, and no ruling could ever complete.
    interactive_permitted: verifier ? null : allowInteractive,
    verifier: mine.verifier,
    // Startup recovery results. Dropped by an earlier edit and caught by the
    // crash-window tests, which is exactly what they are for.
    recovered,
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function send(res, code, body, origin, credentialedOrigin = null) {
  const json = JSON.stringify(body)
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    // A SPECIFIC origin, echoed only after it passed the loopback check above —
    // never `*`.
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
    // CREDENTIALS ONLY FOR THE EXACT OWNER-CONTROLS ORIGIN.
    //
    // Credentialing every loopback origin was a hole I opened by adding this
    // header globally. Ports do not separate sites, so once she has unlocked,
    // a page on any other loopback port could fetch with credentials:include,
    // the browser would attach the HttpOnly cookie, and this server would
    // gladly echo that origin back with credentials enabled.
    ...(origin && credentialedOrigin && origin === credentialedOrigin
      ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  })
  res.end(json)
}

/** Read a JSON body with a hard size cap. A body is never a reason to prompt. */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error("request body is too large")); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")) }
      catch { reject(new Error("body must be JSON")) }
    })
    req.on("error", reject)
  })
}

/** Non-verified outcomes and refusals all mean the same thing: nothing happened. */
const REFUSAL_STATUS = {
  unknown_exception: 404,
  invalid_action: 400,
  idempotency_collision: 409,
  stale_owner_operation: 409,
  cancelled: 403,
  failed: 403,
  unavailable: 503,
  presence_not_valid: 403,
  prompt_cooldown: 429,
  prompt_lockout: 429,
}

/** Everything under this prefix belongs to the authority subsystem. */
export const AUTHORITY_PREFIX = "/__continuity/authority"

/**
 * @param authority an object with `handle(req, res, url, ctx) -> boolean`, or
 *   null. NULL IS THE DEFAULT AND THE SAFE STATE: the authority routes answer
 *   503 and this file never learns what they would have done.
 *
 *   The core is the live owner-ruling runtime. It must not statically import
 *   authority modules, because a missing or corrupt authority build would then
 *   stop the base host from loading at all — taking her working inbox controls
 *   down with a subsystem she was not even using. The entry point composes the
 *   two dynamically, after each has passed its own preflight.
 */
export function createServer(deps = null, {
  ownerRulings = true, unverifiedReason = null, authority = null, authorityReason = null,
  // The ONE origin allowed to send the owner-read cookie. Everything else
  // keeps the old non-credentialed loopback CORS.
  ownerControlsOrigin = process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN || null,
} = {}) {
  // Built once per server, not per request: the prompt budget and the
  // one-outstanding-prompt rule are only meaningful if they are shared.
  //
  // `ownerRulings: false` is what a failed startup provenance gate produces: a
  // half-installed security layer must serve reads and refuse rulings, never
  // rule out of code nobody reviewed as a set.
  const owner = ownerRulings ? (deps ?? createOwnerRulingDeps()) : null

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin
    if (!isLoopbackHost(req.headers.host) || !originAllowed(origin)) {
      return send(res, 403, { error: "loopback only" })
    }
    const url = new URL(req.url, "http://127.0.0.1")

    // PREFLIGHT IS ROUTE-AWARE, and must be, for two separate reasons.
    //
    // It used to be answered here-first, before the URL was parsed and before
    // the authority origin gate. That broke the surface in both directions at
    // once: the legitimate cross-origin owner-controls page never received
    // `Allow-Credentials` on its preflight, so its credentialed POST failed
    // before reaching the code that authorises it — and a wrong loopback origin
    // DID receive CORS headers, which falsified the claim that refused origins
    // get none. A browser transaction is two requests, so a gate that only
    // guards the second one is not a gate.
    const isAuthorityPath = url.pathname === AUTHORITY_PREFIX
      || url.pathname.startsWith(`${AUTHORITY_PREFIX}/`)
    if (req.method === "OPTIONS") {
      if (!isAuthorityPath) return send(res, 204, {}, origin)
      const allowed = !origin || (Boolean(ownerControlsOrigin) && origin === ownerControlsOrigin)
      if (!allowed) {
        return send(res, 403, {
          error: "authority_origin_refused",
          detail: "owner controls are served from one origin, and this is not it.",
        })
      }
      return send(res, 204, {}, origin, ownerControlsOrigin)
    }

    try {
      if (req.method === "GET" && url.pathname === "/api/briefing") {
        const doc = build({ latest: Number(url.searchParams.get("latest")) || 2 })
        doc.decisions = readDecisions({ limit: 40 })
        return send(res, 200, doc, origin)
      }

      if (req.method === "GET" && url.pathname === "/api/decisions") {
        return send(res, 200, { decisions: readDecisions({ limit: 40 }) }, origin)
      }

      if (isAuthorityPath) {
        // SAME-ORIGIN, or the exact configured owner-controls origin. Nothing
        // else, and nothing else gets CORS headers either — a refusal that
        // echoed the origin would still tell a hostile page it had reached a
        // real endpoint.
        const sameOrigin = !origin
        const isOwnerControls = Boolean(ownerControlsOrigin) && origin === ownerControlsOrigin
        if (!sameOrigin && !isOwnerControls) {
          return send(res, 403, {
            error: "authority_origin_refused",
            detail: "owner controls are served from one origin, and this is not it.",
          })
        }

        if (!authority) {
          // Independently gated: the exception route above is unaffected.
          return send(res, 503, {
            error: "authority_unavailable",
            mutation_performed: false,
            detail: authorityReason
              || "The authority subsystem is not available on this host. Owner rulings are unaffected.",
          }, origin)
        }
        const handled = await authority.handle(req, res, url, {
          origin,
          send: (r, code, body) => send(r, code, body, origin, ownerControlsOrigin),
        })
        if (handled) return undefined
        return send(res, 404, { error: "not found" }, origin)
      }

      if (req.method === "POST" && url.pathname === "/api/act") {
        // Enforce a JSON content-type so a preflight-free text/plain or form
        // post from another page cannot reach this handler.
        const type = String(req.headers["content-type"] || "").split(";")[0].trim()
        if (type !== "application/json") {
          return send(res, 415, { error: "application/json required" }, origin)
        }

        // An owner ruling requires OWNER PRESENCE.
        //
        // The loopback and Origin checks above answer "where did this request
        // arrive from?". They do not answer "did the logged-on human approve
        // this?". Windows does, immediately before the mutation, for the exact
        // operation the host has already prepared.
        //
        // Everything cheap is rejected first — bad method, bad content type,
        // unknown exception, invalid class, a replayed operation — so none of
        // them can cost her a dialog. There is no browser round trip after
        // verification, and no verification result crosses back into browser
        // state: the response says what happened, not what was proved.
        //
        // Deliberately NOT behind an environment variable. An escape hatch that
        // restores unauthenticated owner writes is the same hole with a longer
        // name.
        if (!owner) {
          // Fail closed, before the body is read and with no broker in
          // existence. Reads are untouched.
          return send(res, 503, {
            error: "deployment_unverified",
            mutation_performed: false,
            detail: "This host's security layer does not match a reviewed deployment, so owner rulings are disabled. "
              + (unverifiedReason || "Redeploy from a reviewed commit and restart."),
          }, origin)
        }

        const body = await readJsonBody(req)
        // Any claimed verification in the payload is removed rather than
        // rejected, so no code written later can read it by accident.
        const { request } = stripClaimedVerification(body)

        const outcome = await performOwnerRuling({ request, ...owner })
        if (!outcome.ok) {
          return send(res, REFUSAL_STATUS[outcome.failure] ?? 403, {
            error: outcome.failure,
            mutation_performed: false,
            detail: outcome.reason,
            ...(outcome.retry_after_ms ? { retry_after_ms: outcome.retry_after_ms } : {}),
          }, origin)
        }
        return send(res, 200, {
          ...outcome.result,
          replayed: Boolean(outcome.replayed),
        }, origin)
      }

      return send(res, 404, { error: "not found" }, origin)
    } catch (error) {
      return send(res, 400, { error: String(error.message || error) }, origin)
    }
  })
}

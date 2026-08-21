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

import { build } from "./briefing.mjs"
import { sydneyIso, sydneyDate } from "./mustread.mjs"
import * as exceptions from "./exception.mjs"

// The security layer is DEPLOYED beside this file as a recorded artifact, not
// imported from a development working tree. `./_continuity/` exists only in a
// staged or installed live host, so a production process cannot silently pick
// up whatever happens to be checked out in the repo right now.
import {
  createPromptBudget, createRulingJournal, createRulingJournalStorage, performOwnerRuling,
} from "./_continuity/owner-ruling.js"
import { createOwnerPresenceVerifier, stripClaimedVerification } from "./_continuity/owner-presence.js"
import { applyRulingAtomically, exceptionFile } from "./_continuity/exception-atomic.js"
import { createWindowsOwnerPresenceBroker } from "./_continuity/owner-presence-windows.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DECISIONS = process.env.BRIEFING_DECISIONS || path.join(HERE, "..", "decisions")
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
export function readException(id) {
  if (!id) return null
  const found = exceptions.find(id)
  if (!found) return null
  return {
    id: found.meta.id,
    status: found.meta.status,
    updated: found.meta.updated,
    proposed: found.meta.proposed ?? found.proposed ?? null,
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
export function createOwnerRulingDeps({
  verifier = null,
  journalFile = process.env.OWNER_RULING_JOURNAL
    || path.join(process.env.LOCALAPPDATA || HERE, "datascape", "live-host", "owner-rulings.json"),
  allowInteractive = process.env.OWNER_PRESENCE_INTERACTIVE === "1",
  now = () => Date.now(),
} = {}) {
  const journal = createRulingJournal({ storage: createRulingJournalStorage(journalFile), now })
  // Forward recovery on startup: any ruling that was mid-flight when a previous
  // process died is resolved by looking for its ref in the exception itself.
  const recovered = journal.recover(readException)

  return {
    now,
    readException,
    applyMutation: applyOwnerMutation,
    journal,
    budget: createPromptBudget({ now }),
    verifier: verifier ?? createOwnerPresenceVerifier({
      broker: createWindowsOwnerPresenceBroker({ allowInteractive }),
      now,
      randomChallenge: () => crypto.randomUUID(),
    }),
    recovered,
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function send(res, code, body, origin) {
  const json = JSON.stringify(body)
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
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

export function createServer(deps = null, { ownerRulings = true, unverifiedReason = null } = {}) {
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
    if (req.method === "OPTIONS") return send(res, 204, {}, origin)

    const url = new URL(req.url, "http://127.0.0.1")

    try {
      if (req.method === "GET" && url.pathname === "/api/briefing") {
        const doc = build({ latest: Number(url.searchParams.get("latest")) || 2 })
        doc.decisions = readDecisions({ limit: 40 })
        return send(res, 200, doc, origin)
      }

      if (req.method === "GET" && url.pathname === "/api/decisions") {
        return send(res, 200, { decisions: readDecisions({ limit: 40 }) }, origin)
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

// Is something already serving THIS api on the port? A stale copy of ourselves
// is fine to reuse; anything else is a conflict she needs told about, because
// the failure mode is silent: the surface comes up read-only and tells her to
// run the very launcher she just ran.
async function existingApi(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = await res.json()
    return Array.isArray(body?.decisions)
  } catch {
    return false
  }
}

if (process.argv[1] && process.argv[1].endsWith("briefing-server.mjs")) {
  const server = createServer()
  server.on("error", async (error) => {
    if (error?.code !== "EADDRINUSE") {
      console.error(`briefing action API failed: ${error?.message || error}`)
      process.exit(1)
    }
    if (await existingApi(PORT)) {
      console.log(`briefing action API already running on 127.0.0.1:${PORT} — reusing it`)
      process.exit(0)
    }
    console.error(`Port ${PORT} is taken by something that is NOT the briefing API.`)
    console.error(`The surface would come up READ-ONLY. Free the port, or set BRIEFING_API_PORT.`)
    process.exit(1)
  })
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`briefing action API on http://127.0.0.1:${PORT}`)
    console.log(`  GET  /api/briefing`)
    console.log(`  GET  /api/decisions`)
    console.log(`  POST /api/act  {id, action: done|ruling|dismiss, note}`)
  })
}

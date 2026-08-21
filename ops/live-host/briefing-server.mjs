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
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { build } from "./briefing.mjs"
import { sydneyIso, sydneyDate } from "./mustread.mjs"
import * as exceptions from "./exception.mjs"

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
  // Spec §6. Each maps onto a status the exception inbox already understands —
  // no new lifecycle, no parallel queue.
  //
  // `approve` and `reply` move the item to `investigating` because the filing
  // lane now owns the next move; the item is no longer waiting on her, but it
  // is not finished either. Resolving here would drop the follow-up.
  approve: { status: "investigating", kind: "approved-proposed", verb: "APPROVED PROPOSED" },
  reply: { status: "investigating", kind: "custom", verb: "REPLIED" },
  // Defer keeps it blocked-on-owner and sets an absolute timestamp; it simply
  // stops being due-now until then. No reminder, no scheduler mutation.
  defer: { status: null, kind: "deferred", verb: "DEFERRED" },
  dismiss: { status: "resolved", kind: "dismissed", verb: "DISMISSED" },
}

// `deferred_until` — optional frontmatter, ISO-8601 with an explicit offset.
// Written through the exception layer so `updated` still bumps.
export function setDeferredUntil(id, iso) {
  const file = path.join(HERE, "..", "exceptions", `${id}.md`)
  const raw = fs.readFileSync(file, "utf8")
  const FRONT = new RegExp("^---\\r?\\n([\\s\\S]*?)\\r?\\n---")
  const match = raw.match(FRONT)
  if (!match) throw new Error(`${id} has no frontmatter`)
  const keep = match[1]
    .split(/\r?\n/)
    .filter((line) => !/^deferred_until:/.test(line))
  if (iso) keep.push(`deferred_until: ${iso}`)
  const rebuilt = "---" + "\n" + keep.join("\n") + "\n" + "---"
  fs.writeFileSync(file, raw.replace(match[0], rebuilt), "utf8")
}

export function act({ id, action, note = "", until = null }) {
  const spec = ACTIONS[action]
  if (!spec) throw new Error(`unknown action ${JSON.stringify(action)}`)
  if (!id) throw new Error("id is required")

  const found = exceptions.find(id)
  if (!found) throw new Error(`no exception ${id}`)
  const realId = found.meta.id

  const at = sydneyIso()
  const text = String(note || "").trim()

  if (action === "defer") {
    if (!until) throw new Error("defer needs an absolute `until` timestamp")
    const when = Date.parse(until)
    if (!Number.isFinite(when)) throw new Error("`until` must be a parseable ISO-8601 instant")
    // Persist the ABSOLUTE instant only — "Tonight" is a UI convenience and
    // must never reach the file.
    setDeferredUntil(realId, sydneyIso(new Date(when)))
  }

  // Her words, verbatim, stamped as hers and appended — never overwriting an
  // earlier ruling. The lane must be able to tell an owner ruling from another
  // loop's commentary.
  const amendment = `OWNER ${spec.verb} ${at} (via datascape/briefing)${text ? ` — ${text}` : ""}`
  exceptions.amend(realId, { note: amendment })
  if (spec.status) exceptions.setStatus(realId, spec.status, amendment)

  const entry = {
    at,
    id: realId,
    action,
    kind: spec.kind,
    note: text || null,
    deferredUntil: action === "defer" ? sydneyIso(new Date(Date.parse(until))) : null,
    title: found.meta.title,
    loop: found.meta.loop || null,
    resultingStatus: spec.status || found.meta.status,
  }
  recordDecision(entry)
  return entry
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

export function createServer() {
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

        // FAIL CLOSED — an owner ruling requires owner presence.
        //
        // The loopback and Origin checks above answer "where did this request
        // arrive from?". They do not answer "did the logged-on human approve
        // this?". This endpoint authenticates NO principal, so any local
        // process — including an agent driving the already-open browser — could
        // resolve, defer or dismiss her exceptions AS her.
        //
        // The wrapper that asks Windows to verify her is specified and its
        // substrate is built (`owner-presence.js`), but it is not wired yet.
        // Until it is, refusing is the correct behaviour: the alternative is
        // leaving an owner-impersonation path open because closing it is
        // inconvenient.
        //
        // Refused BEFORE the body is read, so a malformed or hostile payload
        // never reaches `act`, and no Windows prompt is involved — this path
        // instantiates no interactive broker at all.
        //
        // Reads are untouched: /api/briefing and /api/decisions still serve.
        //
        // Deliberately NOT behind an environment variable. An escape hatch that
        // restores unauthenticated owner writes is the same hole with a longer
        // name.
        return send(res, 403, {
          error: "owner_presence_required",
          mutation_performed: false,
          detail: "Owner rulings now require verification this host cannot yet perform. "
            + "Rule from the CLI meanwhile: "
            + "node D:/Projects/_ship_inbox/ops/exception.mjs set <id> resolved --note \"...\"",
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

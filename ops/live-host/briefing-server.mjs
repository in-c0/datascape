// The briefing host's ENTRY POINT — and its startup gate.
//
// `.tools/catchup.mjs` spawns exactly this path:
//
//   spawn(node, [<ops>/briefing-server.mjs])
//
// which is why the gate lives here rather than in a new launcher beside it. A
// launcher nothing invokes protects nothing; the previous round added one and
// the real spawn path walked straight past it into the mutation-bearing server.
//
// So this file is the shim at the address that is already called. The server
// itself moved to `_continuity/briefing-server-core.mjs`, and this file:
//
//   verifies the deployed artifact against the manifest the deploy recorded
//   verifies the exception store is still guarded
//     PASS -> dynamically imports the core and serves owner rulings
//     FAIL -> never imports it at all; serves an independent read-only server
//
// NOTHING SECURITY-BEARING IS IMPORTED AT THE TOP OF THIS FILE.
//
// That is structural, not stylistic. The core statically imports
// `_continuity/*`; if one of those files is missing after an interrupted
// deployment, importing the core throws while it loads — before any flag could
// be set. The gate has to run in a module that can load when the security layer
// cannot.
//
// The check is against the MANIFEST, not against Git. `deploy()` verified those
// hashes against `git cat-file blob <commit>:<path>` when it wrote them, so the
// commit's authority is already baked in — and a live host has no obligation to
// be sitting in a checkout with git on its PATH.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIEFING_API_PORT || 5319);

const STATE_DIR = () => process.env.LIVE_HOST_STATE
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "datascape", "live-host");

const DECISIONS = () => process.env.BRIEFING_DECISIONS || path.join(HERE, "..", "decisions");

const sha = (text) =>
  crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

/**
 * The guard marker the deployed exception store must still carry.
 *
 * V2. The V1 marker was `__continuity_owner_gate__`; the two are deliberately
 * not substrings of one another, so a host running the old guard reads as
 * unguarded here rather than passing on a prefix match.
 */
const GUARD_MARKER = "__continuity_owner_gate_v2__";

/**
 * Is what is on disk the file set this host was deployed with?
 *
 * Every artifact file present, every hash matching the manifest, and the
 * exception store still guarded. Any one of those failing means the security
 * layer is not the one somebody reviewed.
 */
export function preflightFromManifest({ liveDir = HERE, stateDir = STATE_DIR() } = {}) {
  const manifest = JSON.parse(read(path.join(stateDir, "deployed.json")) || "null");
  if (!manifest?.commit || !Array.isArray(manifest.files)) {
    return { ok: false, reason: "this host has no deployment manifest, so nothing here has been reviewed" };
  }

  const files = manifest.files.map((entry) => {
    const live = read(path.join(liveDir, entry.dest));
    return { dest: entry.dest, expected: entry.hash, present: live !== null, matches: live !== null && sha(live) === entry.hash };
  });
  const missing = files.filter((f) => !f.present).map((f) => f.dest);
  const drifted = files.filter((f) => f.present && !f.matches).map((f) => f.dest);

  const storeRaw = read(path.join(liveDir, manifest.exception_store?.file ?? "exception.mjs"));
  const storeGuarded = storeRaw !== null
    && storeRaw.includes(GUARD_MARKER)
    && Boolean(manifest.exception_store?.guarded_hash)
    && sha(storeRaw) === manifest.exception_store.guarded_hash;

  return {
    ok: missing.length === 0 && drifted.length === 0 && storeGuarded,
    deployed_from_commit: manifest.commit,
    deployed_at: manifest.deployed_at ?? null,
    artifact_expected: files.length,
    artifact_present: files.filter((f) => f.present).length,
    missing,
    drifted,
    exception_store_guarded: storeGuarded,
    reason: missing.length ? `the deployed security layer is incomplete: missing ${missing.join(", ")}`
      : drifted.length ? `deployed files do not match this host's manifest: ${drifted.join(", ")}`
      : storeGuarded ? null
      : "the exception store is not guarded, so the legacy CLI could still close owner-gated items",
  };
}

/**
 * The authority subsystem's gate, read from the same manifest.
 *
 * Kept here rather than imported from the deploy tool for the same reason the
 * base preflight is: this file must load on a host where the security layer
 * does not.
 */
export function manifestAuthorityGate({ liveDir = HERE, stateDir = STATE_DIR() } = {}) {
  const manifest = JSON.parse(read(path.join(stateDir, "deployed.json")) || "null");
  const recorded = manifest?.authority_files ?? null;
  if (!recorded || !Array.isArray(recorded) || recorded.length === 0) {
    return { ok: false, reason: "this host has no reviewed authority subsystem deployed" };
  }

  // EXACT CLOSURE, not "every file the manifest happened to list".
  //
  // Checking only the recorded entries passes a manifest that forgot a
  // dependency: authority-host.mjs imports a sibling, the manifest records only
  // the host, every recorded file hash-matches, and the gate opens on a module
  // whose import falls through to an unrecorded — possibly stale — file.
  //
  // So the live set must EQUAL the recorded set, and every authority-relative
  // import must resolve inside it. Imports into the already-reviewed
  // `_continuity` base artifact are fine; anything else is not.
  const expected = new Set(recorded.map((entry) => entry.dest));
  const actual = new Set(listLiveAuthorityFiles(liveDir));

  const missing = [...expected].filter((dest) => !actual.has(dest));
  if (missing.length) {
    return { ok: false, reason: `the authority artifact is incomplete: missing ${missing.join(", ")}` };
  }
  const stale = [...actual].filter((dest) => !expected.has(dest));
  if (stale.length) {
    return { ok: false, reason: `unrecorded authority code is present: ${stale.join(", ")}` };
  }
  const drifted = recorded.filter((entry) => {
    const live = read(path.join(liveDir, entry.dest));
    return live === null || sha(live) !== entry.hash;
  }).map((entry) => entry.dest);
  if (drifted.length) {
    return { ok: false, reason: `the authority artifact does not match this deployment: ${drifted.join(", ")}` };
  }

  const entry = manifest.authority_entry ?? "_authority/authority-host.mjs";
  if (!expected.has(entry)) {
    return { ok: false, reason: `the recorded authority entry ${entry} is not part of the recorded set` };
  }

  // Every authority-relative import must land inside the closed set.
  for (const dest of expected) {
    const source = read(path.join(liveDir, dest)) ?? "";
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(dest), match[1]));
      if (target.startsWith("_continuity/")) continue;
      if (!expected.has(target)) {
        return { ok: false, reason: `${dest} imports ${match[1]}, which is not part of the reviewed authority set` };
      }
    }
  }

  return { ok: true, entry, files: [...expected].sort() };
}

/** The authority code files actually present, as opposed to those recorded. */
function listLiveAuthorityFiles(liveDir) {
  const root = path.join(liveDir, "_authority");
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of entries) {
      const rel = `${prefix}${item.name}`;
      if (item.isDirectory()) { walk(path.join(dir, item.name), `${rel}/`); continue; }
      if (/\.(mjs|js|cjs)$/.test(item.name)) out.push(rel);
    }
  };
  walk(root, "_authority/");
  return out.sort();
}

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  const bare = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  if (bare === "localhost" || bare === "::1") return true;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  return parts[0] === "127";
}

function readDecisions({ limit = 40 } = {}) {
  const out = [];
  try {
    for (const file of fs.readdirSync(DECISIONS()).filter((f) => f.endsWith(".jsonl")).sort().reverse()) {
      for (const line of read(path.join(DECISIONS(), file))?.split(/\r?\n/) ?? []) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* a torn line must not take the log down */ }
      }
      if (out.length >= limit) break;
    }
  } catch { return []; }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out.slice(0, limit);
}

/**
 * The fail-closed server.
 *
 * Shares nothing with the mutation runtime — it knows no action vocabulary and
 * has no broker, so it cannot rule and cannot prompt. She can still read her
 * decisions; a degraded host must not also be a dark one.
 */
export function createReadOnlyServer(reason) {
  return http.createServer((req, res) => {
    const send = (code, body) => {
      const json = JSON.stringify(body);
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
        "Cache-Control": "no-store",
      });
      res.end(json);
    };
    if (!isLoopbackHost(req.headers.host)) return send(403, { error: "loopback only" });

    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/decisions") {
      return send(200, { decisions: readDecisions(), degraded: true });
    }
    return send(503, {
      error: "deployment_unverified",
      mutation_performed: false,
      detail: `This host's security layer does not match a reviewed deployment, so owner rulings are unavailable. ${reason ?? ""}`.trim(),
    });
  });
}

/**
 * Start the host.
 *
 * `makeDeps` is invoked with the core module AFTER the gate passes, so a caller
 * can supply its own dependencies without this file importing the security
 * runtime in order to describe them.
 */
export async function startLiveHost({
  liveDir = HERE, stateDir = STATE_DIR(), port = PORT, host = "127.0.0.1", makeDeps = null,
} = {}) {
  const gate = preflightFromManifest({ liveDir, stateDir });

  if (!gate.ok) {
    const server = createReadOnlyServer(gate.reason);
    await new Promise((resolve) => server.listen(port, host, resolve));
    return {
      mode: "read_only", gate, server, port: server.address().port,
      owner_rulings: false, security_runtime_imported: false,
      // Stated on this path too: a fail-closed host has no authority route
      // either, and a caller should not have to infer that from an absence.
      authority_available: false,
      authority_reason: "the base security layer is not verified, so no subsystem is served",
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  // Only now. On the failure path above these modules are never loaded, so a
  // missing or drifted one cannot crash the host before the gate has spoken.
  const url = pathToFileURL(path.resolve(liveDir, "_continuity", "briefing-server-core.mjs")).href;
  const core = await import(url);
  const deps = makeDeps ? await makeDeps(core) : core.createOwnerRulingDeps();

  // The AUTHORITY subsystem is gated separately and composed dynamically. A
  // broken or absent authority build must not be able to take her working
  // owner-ruling host down with it, so nothing here is imported unless its own
  // gate passes — and the core never references it at all.
  let authority = null;
  let authorityReason = null;
  const authorityGate = manifestAuthorityGate({ liveDir, stateDir });
  if (authorityGate.ok) {
    try {
      const mod = await import(pathToFileURL(path.resolve(liveDir, authorityGate.entry)).href);

      // THE TRANSACTION, composed here rather than inside the authority
      // subsystem, because the pieces it needs cross the artifact boundary:
      // `atomic` is the writer that touches her real exception files and lives
      // in `_continuity/`, while the journal and the record construction live
      // in `_authority/`. Importing across those directories from either side
      // is how a module ends up resolvable in the repo and absent in the
      // release, so the composition happens at the one point that can see both.
      let transaction = null;
      try {
        const txMod = await import(pathToFileURL(
          path.resolve(liveDir, "_authority", "authority-transaction.mjs")).href);
        const atomicMod = await import(pathToFileURL(
          path.resolve(liveDir, "_continuity", "exception-atomic.js")).href);
        // The inbox comes from the DEPLOYED exception store, not from a
        // constant here. Two places naming her exception directory is two
        // places that can disagree about which one the host is ruling on.
        const storeMod = await import(pathToFileURL(
          path.resolve(liveDir, "exception.mjs")).href);
        transaction = txMod.createAuthorityTransaction({
          fs,
          journalFile: path.join(stateDir, "authority-journal.json"),
          inbox: storeMod.INBOX,
          // The whole module: the adapter needs the writer, the path resolver
          // and the parser, and checks for all three rather than trusting one.
          atomic: atomicMod,
          now: deps.now,
          // No domain resolver yet: the real-data read surface is the next
          // step, and until it exists `prepare` refuses by name rather than
          // letting the browser nominate a lineage.
          resolveDomain: () => null,
        });
      } catch (error) {
        // NAMED, and surfaced in the startup state below. A host whose
        // unlock/status routes work while prepare and commit answer 501 is
        // partially available, and reporting it as simply "available" is the
        // same defect the topology gate was just corrected for.
        authorityReason = `the authority transaction could not be composed: ${error.message}`;
      }

      authority = mod.createAuthorityHost({
        presence: deps.presence,
        now: deps.now,
        ownerControlsOrigin: process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN || null,
        apiOrigin: `http://${host}:${port || PORT}`,
        transaction,
      });
      if (!authority.topology.ok) authorityReason = authority.topology.reason;
      // AVAILABILITY MUST FOLLOW THE TOPOLOGY GATE.
      //
      // Keeping the object and reporting `authority_available: true` while
      // every authority request answers 503 made the startup state disagree
      // with the running surface. The route failing closed is what protects
      // her; a status line that says the subsystem is up is what makes a
      // misconfigured host look healthy to whoever reads it next. The object is
      // still kept so the route can answer 503 with a reason rather than 404.
    } catch (error) {
      authority = null;
      authorityReason = `the authority subsystem failed to load: ${error.message}`;
    }
  } else {
    authorityReason = authorityGate.reason;
  }

  const server = core.createServer(deps, {
    authority, authorityReason,
    ownerControlsOrigin: process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN || null,
  });
  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    mode: "owner_rulings", gate, server, core, deps, port: server.address().port,
    owner_rulings: true, security_runtime_imported: true,
    authority_available: Boolean(authority) && authority.topology.ok === true,
    // Distinct from availability: the read/unlock surface can be live while the
    // mutation transaction is not composed. Stating both beats a single flag
    // that has to mean two things.
    authority_transaction: Boolean(authority?.operations?.includes("commit")),
    // Stated as data so it can be asserted against rather than described.
    authority_operations: authority?.operations ?? [],
    authority_reason: authorityReason,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// pathToFileURL, not a hand-built `file:///` + path. On POSIX the manual form
// produced `file:////home/...` — four slashes — so this test was false and the
// entry point silently did nothing when spawned. It only ever worked because
// Windows paths start with a drive letter.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const started = await startLiveHost();
  console.log(JSON.stringify({
    mode: started.mode,
    port: started.port,
    owner_rulings: started.owner_rulings,
    deployed_from_commit: started.gate.deployed_from_commit,
    exception_store_guarded: started.gate.exception_store_guarded ?? false,
    // Whether this host can complete an owner ruling at all. Reporting it makes
    // a silently-incapable host visible instead of merely disappointing.
    interactive_owner_verification: started.deps?.interactive_permitted ?? null,
    reason: started.gate.reason,
  }));
  if (started.mode === "read_only") {
    console.error(`Owner rulings are UNAVAILABLE on this host: ${started.gate.reason}`);
  }
}

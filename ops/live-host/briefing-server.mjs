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

/** The guard marker the deployed exception store must still carry. */
const GUARD_MARKER = "__continuity_owner_gate__";

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
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  // Only now. On the failure path above these modules are never loaded, so a
  // missing or drifted one cannot crash the host before the gate has spoken.
  const url = pathToFileURL(path.resolve(liveDir, "_continuity", "briefing-server-core.mjs")).href;
  const core = await import(url);
  const deps = makeDeps ? await makeDeps(core) : core.createOwnerRulingDeps();
  const server = core.createServer(deps);
  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    mode: "owner_rulings", gate, server, core, deps, port: server.address().port,
    owner_rulings: true, security_runtime_imported: true,
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
    reason: started.gate.reason,
  }));
  if (started.mode === "read_only") {
    console.error(`Owner rulings are UNAVAILABLE on this host: ${started.gate.reason}`);
  }
}

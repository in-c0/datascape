// The production launcher for the briefing host.
//
// This exists because `preflight()` and `createServer({ownerRulings:false})`
// were both correct and nothing connected them. The acceptance test built a
// disabled server by hand, which proved the flag worked and said nothing about
// what happens when the host actually starts on a broken deployment.
//
// Worse, it could not have worked as written: `briefing-server.mjs` STATICALLY
// imports `_continuity/*`. If one of those files is missing after an
// interrupted deployment, the module throws while loading — before any code
// that might have set `ownerRulings: false` exists to run.
//
// So the decision has to happen OUTSIDE the security-bearing import:
//
//   verify complete artifact
//   verify every expected hash
//   verify the guarded exception store
//     PASS -> import and start the verified host
//     FAIL -> never import the mutation runtime at all;
//             serve reads from an independent server that shares none of it
//
// Nothing security-relevant is imported at the top of this file. That is not
// stylistic: a top-level import here would run before the gate that decides
// whether it may run at all.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

import { liveDir as hostDir, preflight } from "./live-host-deploy.mjs";

const DECISIONS = () => process.env.BRIEFING_DECISIONS || path.join(hostDir(), "..", "decisions");

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
      for (const line of fs.readFileSync(path.join(DECISIONS(), file), "utf8").split(/\r?\n/)) {
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
 * Deliberately independent: it imports nothing from `_continuity/` and knows
 * nothing about owner rulings, so it can start on a host where the security
 * layer is missing, half-installed, or drifted. She can still read her
 * briefing's decisions; nothing can be ruled.
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
    // Everything else, including every owner ruling, is unavailable. No broker
    // exists in this process, so this path cannot produce a prompt.
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
 * `makeDeps` is invoked with the host module AFTER the gate passes, so a caller
 * can supply its own dependencies without this file importing the security
 * runtime to describe them.
 */
export async function startLiveHost({
  liveDir = hostDir(),
  port = Number(process.env.BRIEFING_API_PORT || 5319),
  host = "127.0.0.1",
  makeDeps = null,
} = {}) {
  const gate = preflight({ liveDir });

  if (!gate.ok) {
    const server = createReadOnlyServer(gate.reason);
    await new Promise((resolve) => server.listen(port, host, resolve));
    return {
      mode: "read_only",
      gate,
      server,
      port: server.address().port,
      // Stated so a caller cannot mistake a degraded host for a healthy one.
      owner_rulings: false,
      security_runtime_imported: false,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  // Only now. A dynamic import is the point: on the failure path above, these
  // modules are never loaded, so a missing or drifted one cannot crash the host
  // before the gate has spoken.
  const url = `file:///${path.resolve(liveDir, "briefing-server.mjs").split(path.sep).join("/")}`;
  const hostModule = await import(url);
  const deps = makeDeps ? await makeDeps(hostModule) : hostModule.createOwnerRulingDeps();
  const server = hostModule.createServer(deps);
  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    mode: "owner_rulings",
    gate,
    server,
    hostModule,
    deps,
    port: server.address().port,
    owner_rulings: true,
    security_runtime_imported: true,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === `file:///${process.argv[1].split(path.sep).join("/")}`;
if (invokedDirectly) {
  const started = await startLiveHost();
  console.log(JSON.stringify({
    mode: started.mode,
    port: started.port,
    owner_rulings: started.owner_rulings,
    deployed_from_commit: started.gate.deployed_from_commit,
    exception_store_guarded: started.gate.exception_store_guarded,
    reason: started.gate.reason,
  }, null, 2));
  if (started.mode === "read_only") {
    console.error("Owner rulings are UNAVAILABLE on this host:", started.gate.reason);
  }
}

// The release path, not the harness.
//
// Every property here is asserted against what `deploy()` actually produces and
// what `startLiveHost()` actually does with it. The previous two rounds proved
// mechanisms the release path never invoked — the acceptance world patched the
// exception store itself, and a disabled server was built by hand — so the
// reported zeros were true of the test and unproven of production.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { deployedWorld } from "../ops/prb-deploy-world.mjs";

// ---------------------------------------------------------------------------
// Deployment installs the owner guard into the host's own store
// ---------------------------------------------------------------------------

test("deploy: production deployment guards the real exception store", async () => {
  const world = await deployedWorld();
  try {
    assert.equal(world.deployed.ok, true, JSON.stringify(world.deployed));
    assert.equal(world.deployed.exception_store.already_guarded, false);
    assert.ok(world.deployed.exception_store.original_preimage_hash, "the pre-Continuity original is recorded");

    const installed = fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8");
    assert.ok(installed.includes("__continuity_owner_gate_v2__"),
      "copying a guard module beside an unpatched store guards nothing");
    assert.ok(!/from\s+["'][^"']*_continuity/.test(installed),
      "and the installed guard must leave the store relocatable");

    const manifest = JSON.parse(fs.readFileSync(path.join(world.state, "deployed.json"), "utf8"));
    assert.equal(manifest.exception_store.guarded_hash, world.deployed.exception_store.guarded_hash);
    assert.notEqual(manifest.exception_store.original_preimage_hash, manifest.exception_store.guarded_hash);
  } finally { await world.close(); }
});

test("deploy: the DEPLOYED legacy CLI cannot close an owner-gated item", async () => {
  const world = await deployedWorld();
  try {
    const id = world.fixture();
    // Loaded from the live host, after a real deployment. No test-side patching.
    const store = await world.store();

    for (const status of ["resolved", "investigating", "new"]) {
      assert.throws(() => store.setStatus(id, status),
        (error) => error.code === "owner_ruling_required",
        `the deployed store must refuse setStatus(${status}) on a blocked-on-owner item`);
    }
    // There is no fourth-argument escape hatch any more: a ruling ref was a
    // serializable string in a process-local Set, never bound to an exception
    // and never consumed — a reusable capability for anything in the host.
    assert.throws(() => store.setStatus(id, "resolved", "", "ruling:invented"),
      (error) => error.code === "owner_ruling_required");
    assert.equal(world.status(id), "blocked-on-owner");
    assert.equal(world.broker.calls.length, 0);

    // And ordinary lane work still passes, or the gate is just a wall that gets
    // switched off.
    const ordinary = world.fixture("2026-08-22-deployed-ordinary", { status: "new" });
    assert.equal(store.setStatus(ordinary, "investigating"), ordinary);
    assert.equal(world.status(ordinary), "investigating");
    const raising = world.fixture("2026-08-22-deployed-raise", { status: "investigating" });
    assert.equal(store.setStatus(raising, "blocked-on-owner"), raising);
  } finally { await world.close(); }
});

test("deploy: rollback restores the exception store's original bytes", async () => {
  const world = await deployedWorld();
  try {
    const rolled = world.deployMod.rollback({ toBackupSet: world.deployed.backup_set, dryRun: false });
    assert.equal(rolled.ok, true);
    const restored = fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8");
    assert.equal(restored, world.storeBefore, "rollback must restore the exact previous store bytes");
    assert.ok(!restored.includes("__continuity_owner_gate__"));

    // An unguarded store is not a servable host, so the gate must now refuse.
    assert.equal(world.deployMod.preflight({ liveDir: world.live }).ok, false);
  } finally { await world.close(); }
});

test("deploy: re-deploying over a guarded store keeps the ORIGINAL preimage", async () => {
  const world = await deployedWorld();
  try {
    const second = await world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
    assert.equal(second.ok, true);
    assert.equal(second.exception_store.already_guarded, true);
    assert.equal(second.exception_store.original_preimage_hash, world.deployed.exception_store.original_preimage_hash,
      "a rollback after a redeploy must restore the ORIGINAL store, not a patched one");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// The launcher decides before the security runtime is imported
// ---------------------------------------------------------------------------

test("launcher: nothing security-bearing is imported at the top of the entry point", () => {
  const source = fs.readFileSync(new URL("../ops/live-host/briefing-server.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const topLevel = source.match(/^import[\s\S]*?from\s+["'][^"']+["']/gm) ?? [];
  for (const line of topLevel) {
    assert.ok(!/briefing-server|_continuity|owner-ruling|owner-presence/.test(line),
      `the entry point must not import ${line} before the gate that decides whether it may run`);
  }
  // And the host is reached by dynamic import, after the gate.
  assert.match(source, /await import\(/);
});

test("launcher: a complete reviewed deployment serves owner rulings", async () => {
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    assert.equal(started.mode, "owner_rulings");
    assert.equal(started.gate.exception_store_guarded, true);
    assert.equal(started.gate.deployed_from_commit, world.commit);

    const id = world.fixture();
    const result = await world.act({ id, action: "reply_done", operation_id: "op-deployed-1" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(world.broker.calls.length, 1);
    assert.equal(world.amendments(id), 1);
    assert.equal(world.status(id), "resolved");
  } finally { await world.close(); }
});

for (const [label, damage, expectation] of [
  ["a missing security module", { remove: "_continuity/owner-ruling.js" }, /incomplete/],
  ["a mixed security module", { mix: "_continuity/owner-presence.js" }, /do not match this host.s manifest/],
  ["an unguarded exception store", { unguard: true }, /not guarded/],
]) {
  test(`launcher: ${label} makes the owner-mutation route unreachable`, async () => {
    const world = await deployedWorld({ damage });
    try {
      // The real launcher, on a real broken deployment. A static import of the
      // security layer would have thrown here before any flag could save it.
      const started = await world.launch();
      assert.equal(started.mode, "read_only", `${label} must not start an owner-ruling host`);
      assert.equal(started.owner_rulings, false);
      assert.equal(started.security_runtime_imported, false);
      assert.match(started.gate.reason, expectation);

      const id = world.fixture();
      const refused = await world.act({ id, action: "dismiss", operation_id: "op-broken" });
      assert.equal(refused.status, 503);
      assert.equal(refused.body.error, "deployment_unverified");
      assert.equal(refused.body.mutation_performed, false);
      assert.equal(world.amendments(id), 0);
      assert.equal(world.broker.calls.length, 0, "a fail-closed startup must not prompt her");

      // Reads still serve: a degraded host must not also be a dark one.
      const reads = await fetch(`http://127.0.0.1:${started.port}/api/decisions`);
      assert.equal(reads.status, 200);
      assert.equal((await reads.json()).degraded, true);
    } finally { await world.close(); }
  });
}

// ---------------------------------------------------------------------------
// The command catchup actually runs
// ---------------------------------------------------------------------------

/**
 * Spawn the live host exactly as `.tools/catchup.mjs` does:
 *
 *   spawn(node, [<ops>/briefing-server.mjs], {env: {BRIEFING_API_PORT}})
 *
 * No launcher, no module import, no test-side wiring. If the gate is not in
 * that file, this test cannot see it — which is the point.
 */
async function spawnLikeCatchup(world) {
  // PORT 0: the OS picks a free one and the host prints which. Fixed random
  // ports in a range collided between parallel test files often enough to make
  // this gate flaky, and a release gate that fails for the harness teaches
  // people to re-run it rather than read it.
  const child = spawn(process.execPath, [path.join(world.live, "briefing-server.mjs")], {
    env: {
      ...process.env,
      BRIEFING_API_PORT: "0",
      // Test-only disable: the production path is interactive-capable by
      // default, and a spawned test must never be able to prompt her.
      OWNER_PRESENCE_INTERACTIVE: "0",
      LIVE_HOST_STATE: world.state,
      EXCEPTION_INBOX: world.inbox,
      BRIEFING_DECISIONS: path.join(world.dir, "live", "decisions"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });

  // Wait for the status line, which carries the port it actually bound.
  const deadline = Date.now() + 15000;
  let port = null;
  while (Date.now() < deadline) {
    const line = out.trim().split("\n").filter(Boolean).pop();
    if (line) {
      try { port = JSON.parse(line).port ?? null; } catch { /* still streaming */ }
    }
    if (port) break;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, port, out: () => out, err: () => err, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

test("startup: the real spawned command gates before it can rule", async () => {
  const world = await deployedWorld();
  const proc = await spawnLikeCatchup(world);
  const port = proc.port;
  try {
    const status = JSON.parse(proc.out().trim().split("\n").filter(Boolean).pop() ?? "{}");
    assert.equal(status.mode, "owner_rulings", `${proc.out()}\n${proc.err()}`);
    assert.equal(status.exception_store_guarded, true);
    assert.equal(status.deployed_from_commit, world.commit,
      "the spawned entry point ran the preflight, not just the server");

    // The route exists and is gated by presence. The spawned process builds the
    // REAL broker with allowInteractive unset, so it can never show a dialog —
    // the ruling simply cannot complete without her.
    const id = world.fixture();
    const response = await fetch(`http://127.0.0.1:${port}/api/act`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "dismiss", operation_id: "op-spawned" }),
    });
    const body = await response.json();
    // Two different 503s live here and they must not be confused: a fail-closed
    // host answers `deployment_unverified`, while a healthy host with no
    // presence device answers `unavailable`. On Linux CI there is no Windows
    // Hello, so the healthy host legitimately reports the latter.
    assert.notEqual(body.error, "deployment_unverified", "a healthy host must not be fail-closed");
    assert.equal(body.mutation_performed, false, "no presence, no ruling");
    assert.equal(world.amendments(id), 0);
  } finally { proc.stop(); await world.close(); }
});

for (const [label, damage] of [
  ["a missing security module", { remove: "_continuity/owner-ruling.js" }],
  ["a missing core", { remove: "_continuity/briefing-server-core.mjs" }],
  ["an unguarded exception store", { unguard: true }],
]) {
  test(`startup: ${label} cannot rule through the real spawned command`, async () => {
    const world = await deployedWorld({ damage });
    const proc = await spawnLikeCatchup(world);
    const port = proc.port;
    try {
      const status = JSON.parse(proc.out().trim().split("\n").filter(Boolean).pop() ?? "{}");
      assert.equal(status.mode, "read_only", `${proc.out()}\n${proc.err()}`);
      assert.equal(status.owner_rulings, false);

      const id = world.fixture();
      const response = await fetch(`http://127.0.0.1:${port}/api/act`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "dismiss", operation_id: "op-broken-spawn" }),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).mutation_performed, false);
      assert.equal(world.amendments(id), 0);

      // Reads still serve.
      const reads = await fetch(`http://127.0.0.1:${port}/api/decisions`);
      assert.equal(reads.status, 200);
    } finally { proc.stop(); await world.close(); }
  });
}

test("startup: the core is not independently spawnable as a server", () => {
  // The old file both defined the server AND started one when run directly.
  // That second entry point is the thing catchup could have been pointed at.
  const core = fs.readFileSync(new URL("../ops/live-host/briefing-server-core.mjs", import.meta.url), "utf8");
  assert.ok(!/server\.listen\(/.test(core), "the core must not start a server of its own");
  assert.ok(!/import\.meta\.url === /.test(core), "the core must have no direct-run entry point");
});

// ---------------------------------------------------------------------------
// The guard transformation comes from the reviewed commit
// ---------------------------------------------------------------------------

test("deploy: a sabotaged working-tree guard cannot affect a reviewed deploy", async () => {
  const world = await deployedWorld();
  try {
    // Roll back to an unguarded store so a redeploy has real work to do.
    await world.deployMod.rollback({ toBackupSet: world.deployed.backup_set, dryRun: false });
    assert.ok(!fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8").includes("__continuity_owner_gate__"));

    // Now sabotage the guard in the WORKING TREE: it would install nothing.
    const guardPath = path.join(world.repo, "ops", "exception-guard-patch.mjs");
    const reviewed = fs.readFileSync(guardPath, "utf8");
    fs.writeFileSync(guardPath,
      "export const GUARD_MARKER = \"__continuity_owner_gate__\";\n"
      + "export function isPatched() { return true }\n"
      + "export function patchExceptionSource(source) { return { ok: true, already: true, source } }\n");

    const attempt = await world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
    assert.equal(attempt.ok, false, "an edited security transformation must stop the deploy");
    assert.equal(attempt.dirty_guard, true);
    assert.ok(!fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8").includes("__continuity_owner_gate_v2__"),
      "a refused deploy must write nothing");

    // Restore the tree, and the same commit deploys a genuinely guarded store.
    fs.writeFileSync(guardPath, reviewed);
    const clean = await world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
    assert.equal(clean.ok, true, JSON.stringify(clean));
    assert.ok(fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8").includes("__continuity_owner_gate_v2__"));
    // And the recorded provenance is the Git blob's hash, not the checkout's.
    assert.equal(clean.exception_store.guarded_hash, world.deployed.exception_store.guarded_hash);
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// A real ruling ref is not a capability
// ---------------------------------------------------------------------------

test("gate: a REAL ruling ref cannot be replayed through the legacy store", async () => {
  const world = await deployedWorld();
  try {
    await world.launch();

    // Perform a genuine verified ruling and keep its ref. `defer` is used on
    // purpose: it leaves the item blocked-on-owner, so the ref can be tried
    // against the very exception that produced it while that exception is still
    // gated. A ruling that resolved the item would make the retry an ordinary
    // lane transition and prove nothing.
    const ruled = world.fixture("2026-08-22-ref-source");
    const result = await world.act({
      id: ruled, action: "defer", until: "2026-08-24T09:00:00+10:00", operation_id: "op-ref-source",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const realRef = result.body.ruling_ref;
    assert.ok(realRef, "a verified ruling produces a ref");

    const store = await world.store();
    const other = world.fixture("2026-08-22-ref-target");

    // Same exception, real ref, reused. It was already spent on the ruling that
    // produced it — and it was never a credential to begin with.
    assert.throws(() => store.setStatus(ruled, "resolved", "", realRef),
      (error) => error.code === "owner_ruling_required");
    // A different exception, same real ref: the ref was never bound to one.
    assert.throws(() => store.setStatus(other, "resolved", "", realRef),
      (error) => error.code === "owner_ruling_required");
    // And an invented one, for completeness.
    assert.throws(() => store.setStatus(other, "resolved", "", "ruling:invented"),
      (error) => error.code === "owner_ruling_required");

    assert.equal(world.status(other), "blocked-on-owner", "nothing moved");
    assert.equal(world.amendments(other), 0);
    assert.equal(world.broker.calls.length, 1, "and none of it cost a prompt");
  } finally { await world.close(); }
});

test("gate: the installed guard accepts no credential at all", () => {
  // The rule now lives inline in the reviewed patch, not in an imported module,
  // so this reads the bytes that actually get installed.
  const patch = fs.readFileSync(new URL("../ops/exception-guard-patch.mjs", import.meta.url), "utf8");
  const body = patch.slice(patch.indexOf("const V2_BODY"), patch.indexOf("const SIGNATURE"));
  assert.ok(!/new Set\(/.test(body), "no registry of refs");
  assert.ok(!/ownerRuling|ruling_ref|rulingRef|arguments\[/.test(body), "no credential parameter to check");
  assert.ok(!/import\s|require\(/.test(body), "and nothing imported, so the store stays relocatable");
  assert.match(body, /__from === "blocked-on-owner" && status !== "blocked-on-owner"/,
    "the guard decides on the transition and nothing else");
});

test("portability: no module hand-builds a file:// URL", () => {
  // `file:///${p.split(sep).join("/")}` is right on Windows only, because a
  // Windows path starts with a drive letter. On POSIX it yields
  // `file:////home/...` and every comparison against import.meta.url silently
  // fails — which is how the entry point spawned, matched nothing, and exited
  // without starting anything on CI while passing on this machine.
  const dir = new URL("../ops/", import.meta.url);
  const offenders = [];
  const walk = (base) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), base);
      if (entry.isDirectory()) { walk(child); continue; }
      if (!/\.mjs$|\.js$/.test(entry.name)) continue;
      const source = fs.readFileSync(child, "utf8").replace(/^\s*\/\/.*$/gm, "");
      if (/`file:\/\/\/\$\{/.test(source)) offenders.push(entry.name);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "use pathToFileURL() — it is correct on both platforms");
});

// ---------------------------------------------------------------------------
// The production host must actually be able to verify her
// ---------------------------------------------------------------------------

test("presence: the production host permits interactive verification by default", () => {
  const core = fs.readFileSync(new URL("../ops/live-host/briefing-server-core.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Opt-IN was the defect: nothing set the variable, so the real spawn path
  // loaded the verified runtime and could never complete a ruling.
  assert.ok(!/OWNER_PRESENCE_INTERACTIVE\s*===\s*["']1["']/.test(core),
    "interactive verification must not depend on somebody remembering an env var");
  assert.match(core, /OWNER_PRESENCE_INTERACTIVE\s*!==\s*["']0["']/,
    "the production default is capable; the disable is explicit and test-only");

  // And the broker's own default stays safe.
  const broker = fs.readFileSync(
    new URL("../src/continuity/control/owner-presence-windows.js", import.meta.url), "utf8");
  assert.match(broker, /allowInteractive = false/, "the broker itself must still default to non-interactive");
});

test("presence: the interactive broker cannot exist before the gate passes", async () => {
  const world = await deployedWorld({ damage: { remove: "_continuity/owner-ruling.js" } });
  try {
    const started = await world.launch();
    assert.equal(started.mode, "read_only");
    // The core is where the broker is constructed. On a failed gate it is never
    // imported, so there is no path from a broken deployment to a device call —
    // which is stronger than constructing one and declining to use it.
    assert.equal(started.security_runtime_imported, false);
    assert.equal(started.core, undefined, "no core module, therefore no broker");
    assert.equal(world.broker.calls.length, 0);
  } finally { await world.close(); }
});

test("presence: a healthy production-shaped host mutates once on verified, never on cancelled", async () => {
  const world = await deployedWorld();
  try {
    await world.launch();

    world.broker.outcomeValue = "cancelled";
    const declined = world.fixture("2026-08-22-presence-cancelled");
    const refused = await world.act({ id: declined, action: "dismiss", operation_id: "op-presence-cancel" });
    assert.equal(refused.body.mutation_performed, false);
    assert.equal(world.amendments(declined), 0, "a cancelled verification must mutate nothing");

    world.broker.outcomeValue = "verified";
    world.advance(11000);
    const allowed = world.fixture("2026-08-22-presence-verified");
    const ruled = await world.act({ id: allowed, action: "dismiss", operation_id: "op-presence-verify" });
    assert.equal(ruled.status, 200, JSON.stringify(ruled.body));
    assert.equal(world.amendments(allowed), 1, "exactly once");
    assert.equal(world.status(allowed), "resolved");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// One owner-presence coordinator per host
// ---------------------------------------------------------------------------

test("presence: every route that can prompt shares ONE verifier and ONE budget", async () => {
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    assert.equal(started.mode, "owner_rulings");

    const stats = started.deps.presence.stats();
    assert.ok(stats.subsystems.includes("owner_rulings"));
    // Deliberately NOT asserting a reported instance count. A literal `1` in a
    // stats object is a constant dressed as a measurement — a second verifier
    // built anywhere else would not have changed it. Object identity is the
    // thing an implementation can actually fail.
    assert.equal(stats.verifier_instances, undefined, "no fake instance counter");
    assert.equal(stats.budget_instances, undefined);

    // A second subsystem takes a HANDLE, not a new device.
    const authority = started.deps.presence.forSubsystem("authority");
    assert.equal(authority.verifier, started.deps.verifier, "same verifier object");
    assert.equal(authority.budget, started.deps.budget, "same budget object");

    // And the budget really is shared: a refusal on one route cools down the
    // other, which is the property that makes lockout unevadable.
    const id = world.fixture("2026-08-22-shared-budget");
    world.broker.outcomeValue = "cancelled";
    assert.equal((await world.act({ id, action: "dismiss", operation_id: "op-shared-1" })).body.error, "cancelled");
    assert.equal(authority.budget.mayPrompt().ok, false,
      "the authority route must inherit the cooldown the exception route just incurred");
  } finally { await world.close(); }
});

test("presence: the deployed artifact ships the coordinator", async () => {
  const world = await deployedWorld();
  try {
    assert.ok(world.deployed.files.some((f) => f.dest === "_continuity/owner-presence-coordinator.js"),
      "a shared coordinator that is not deployed is not shared with anything");
    assert.equal(world.deployMod.preflight({ liveDir: world.live }).ok, true);
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// The authority subsystem is gated independently of the host
// ---------------------------------------------------------------------------

test("authority: a BROKEN subsystem returns 503 and leaves /api/act live", async () => {
  // Deployment now ships the authority group, so "absent" has to be created:
  // this is the shape a corrupt or interrupted authority install leaves.
  const world = await deployedWorld({ damage: { remove: "_authority/authority-read-session.js" } });
  try {
    const started = await world.launch();
    assert.equal(started.mode, "owner_rulings", "the base host is unaffected");
    assert.equal(started.authority_available, false);
    assert.ok(started.authority_reason, "and it says why");

    for (const route of ["/__continuity/authority", "/__continuity/authority/unlock_read"]) {
      const response = await fetch(`http://127.0.0.1:${started.port}${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 503, route);
      const body = await response.json();
      assert.equal(body.error, "authority_unavailable");
      assert.equal(body.mutation_performed, false);
    }

    // The whole point: her owner rulings still work while authority does not.
    const id = world.fixture("2026-08-22-authority-absent");
    const ruled = await world.act({ id, action: "reply_done", operation_id: "op-authority-absent" });
    assert.equal(ruled.status, 200, JSON.stringify(ruled.body));
    assert.equal(world.amendments(id), 1);
    assert.equal(world.broker.calls.length, 1);
  } finally { await world.close(); }
});

test("authority: the base core never references an authority module", () => {
  const core = fs.readFileSync(new URL("../ops/live-host/briefing-server-core.mjs", import.meta.url), "utf8");
  const imports = core.match(/^import[\s\S]*?from\s+["'][^"']+["']/gm) ?? [];
  // A static import of authority runtime would mean a corrupt authority build
  // stops the live owner-ruling host from loading at all.
  assert.deepEqual(imports.filter((line) => /_authority|authority-host/.test(line)), []);
  assert.ok(!/_authority\//.test(core.replace(/^\s*\/\/.*$/gm, "")),
    "the core knows a URL prefix, not a module");
});

// ---------------------------------------------------------------------------
// The authority host, from deployed bytes
// ---------------------------------------------------------------------------

test("authority: unlock requires verified presence and hands back no token", async () => {
  const world = await deployedWorld();
  try {
    // Imported from the LIVE host, where authority-host.mjs sits beside its
    // session module. In the repo they live in different directories, so a
    // repo-path import would be testing a layout production never has.
    const mod = await import(pathToFileURL(
      path.join(world.live, "_authority", "authority-host.mjs")).href);

    let outcome = "verified";
    const calls = [];
    const verification = { outcome: "verified", operation_ref: "authority:unlock_read" };
    const presence = {
      forSubsystem: (name) => ({
        name,
        verifier: {
          verify: async ({ purpose, operationRef }) => {
            calls.push({ purpose, operationRef });
            return outcome === "verified" ? verification : { outcome, reason: `device said ${outcome}` };
          },
          authorizes: () => ({ ok: true }),
        },
        budget: { mayPrompt: () => ({ ok: true }), recordOutcome: () => {} },
        now: () => 1_000_000,
      }),
    };
    const host = mod.createAuthorityHost({
      presence, now: () => 1_000_000,
      ownerControlsOrigin: "http://127.0.0.1:5313", apiOrigin: "http://127.0.0.1:5319",
    });

    const drive = async () => {
      const headers = [];
      let payload = null;
      const res = { setHeader: (k, v) => headers.push([k, v]) };
      const ctx = { origin: null, send: (r, code, body) => { payload = { code, body }; return true; } };
      const req = {
        method: "POST", headers: { "content-type": "application/json" },
        on(event, fn) { if (event === "end") fn(); return req; },
      };
      await host.handle(req, res, new URL("http://127.0.0.1/__continuity/authority/unlock_read"), ctx);
      return { headers, payload };
    };

    const ok = await drive();
    const cookie = ok.headers.find(([k]) => k === "Set-Cookie")?.[1];
    assert.ok(cookie, "the session is handed over as a cookie");
    assert.equal(ok.payload.code, 200);
    assert.equal(ok.payload.body.unlocked, true);
    assert.ok(ok.payload.body.expires_at, "the surface is told when its window closes");

    const token = cookie.split(";")[0].split("=")[1];
    assert.ok(!JSON.stringify(ok.payload.body).includes(token),
      "the browser is never trusted with the token itself");
    assert.match(calls[0].purpose, /Unlock DataScape owner controls/);

    // A refused verification unlocks nothing.
    outcome = "cancelled";
    const refused = await drive();
    assert.equal(refused.payload.code, 403);
    assert.equal(refused.payload.body.unlocked, false);
    assert.equal(refused.headers.length, 0, "and sets no cookie");
  } finally { await world.close(); }
});

test("authority: an unauthenticated request reaches no authority operation", async () => {
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    assert.equal(started.authority_available, true, "the subsystem is deployed and gated open");

    // No cookie: every route beyond unlock/status is 401, not a 501 that would
    // tell an unauthenticated caller what exists.
    const response = await fetch(`http://127.0.0.1:${started.port}/__continuity/authority/context`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "no_read_session");
    assert.equal(world.broker.calls.length, 0, "and it costs her no prompt");

    // Status is readable and tells nobody anything secret.
    const status = await fetch(`http://127.0.0.1:${started.port}/__continuity/authority/status`);
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.open, false);
    assert.ok(!JSON.stringify(body).includes("session"), "no session material in a public status");
  } finally { await world.close(); }
});

test("presence: the authority runtime constructs no verifier or budget of its own", async () => {
  const world = await deployedWorld();
  try {
    // Measured against the DEPLOYED authority bytes: a subsystem that called
    // the factories directly would have its own device and its own budget,
    // whatever the coordinator reports about itself.
    for (const file of ["_authority/authority-host.mjs", "_authority/authority-read-session.js"]) {
      const source = fs.readFileSync(path.join(world.live, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.ok(!/createOwnerPresenceVerifier\s*\(/.test(source), `${file} constructs a verifier`);
      assert.ok(!/createPromptBudget\s*\(/.test(source), `${file} constructs a prompt budget`);
      assert.ok(!/createWindowsOwnerPresenceBroker\s*\(/.test(source), `${file} constructs a broker`);
    }

    // And the host builds exactly one coordinator on the way up.
    const core = fs.readFileSync(path.join(world.live, "_continuity", "briefing-server-core.mjs"), "utf8")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.equal((core.match(/createOwnerPresenceCoordinator\(/g) ?? []).length, 1,
      "one coordinator factory call in the production startup path");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// The authority gate needs an exact closure, not the manifest's word for it
// ---------------------------------------------------------------------------

test("authority: an omitted dependency makes the subsystem unavailable", async () => {
  const world = await deployedWorld();
  try {
    // The failure the recorded-entries-only check would have missed: every
    // recorded file hash-matches, but the manifest forgot a sibling the entry
    // imports, so the gate would open on a module whose import falls through.
    const manifestPath = path.join(world.state, "deployed.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.authority_files = manifest.authority_files
      .filter((f) => f.dest === "_authority/authority-host.mjs");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const started = await world.launch();
    assert.equal(started.authority_available, false);
    assert.match(started.authority_reason, /unrecorded authority code is present/);
    assert.equal(started.mode, "owner_rulings", "/api/act is unaffected");
  } finally { await world.close(); }
});

test("authority: an extra stale file makes the subsystem unavailable", async () => {
  const world = await deployedWorld();
  try {
    fs.writeFileSync(path.join(world.live, "_authority", "left-behind.mjs"),
      "export const stale = 1\n");
    const started = await world.launch();
    assert.equal(started.authority_available, false);
    assert.match(started.authority_reason, /unrecorded authority code/);
    assert.equal(started.mode, "owner_rulings");
  } finally { await world.close(); }
});

test("authority: hash drift makes the subsystem unavailable", async () => {
  const world = await deployedWorld();
  try {
    fs.writeFileSync(path.join(world.live, "_authority", "authority-read-session.js"),
      "export const tampered = 1\n");
    const started = await world.launch();
    assert.equal(started.authority_available, false);
    assert.match(started.authority_reason, /does not match this deployment/);
    assert.equal(started.mode, "owner_rulings");

    // In every one of these three cases her rulings still work.
    const id = world.fixture("2026-08-22-drift-still-rules");
    const ruled = await world.act({ id, action: "reply_done", operation_id: "op-drift" });
    assert.equal(ruled.status, 200, JSON.stringify(ruled.body));
  } finally { await world.close(); }
});

test("authority: deployment removes stale authority code and rollback restores the world", async () => {
  const world = await deployedWorld();
  try {
    // A file from an imagined earlier authority release.
    fs.writeFileSync(path.join(world.live, "_authority", "old-release.mjs"), "export const old = 1\n");

    const redeploy = await world.deployMod.deploy({
      commit: world.commit, dryRun: false, liveDir: world.live,
    });
    assert.equal(redeploy.ok, true, JSON.stringify(redeploy));
    assert.deepEqual(redeploy.removed_authority, ["_authority/old-release.mjs"],
      "stale authority code must not survive a release");
    assert.equal(fs.existsSync(path.join(world.live, "_authority", "old-release.mjs")), false);

    // Rolling back restores what was there — including the stale file, which
    // WAS the previous world — and deletes anything this release introduced.
    const rolled = world.deployMod.rollback({ toBackupSet: redeploy.backup_set, dryRun: false });
    assert.equal(rolled.ok, true);
    assert.equal(fs.readFileSync(path.join(world.live, "_authority", "old-release.mjs"), "utf8"),
      "export const old = 1\n", "the previous authority world comes back exactly");
  } finally { await world.close(); }
});

test("authority: rollback deletes authority files that had no predecessor", async () => {
  const world = await deployedWorld();
  try {
    // The world's first deploy introduced the authority set; before it there
    // was no _authority directory at all. Rolling that deploy back must leave
    // none behind, or candidate authority code sits beside rolled-back base
    // code.
    assert.ok(fs.existsSync(path.join(world.live, "_authority", "authority-host.mjs")));

    const rolled = world.deployMod.rollback({ toBackupSet: world.deployed.backup_set, dryRun: false });
    assert.equal(rolled.ok, true);
    // Derived from the artifact set rather than listed by hand, so adding an
    // authority module does not silently leave this assertion stale.
    assert.deepEqual(rolled.deleted_authority.sort(),
      world.deployMod.AUTHORITY_ARTIFACT.map((e) => e.dest).sort());
    assert.equal(fs.existsSync(path.join(world.live, "_authority", "authority-host.mjs")), false);

    // And the host comes up fail-closed, with authority simply absent.
    const started = await world.launch();
    assert.equal(started.mode, "read_only");
    assert.equal(started.authority_available, false);
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// Read-unlock boundaries
// ---------------------------------------------------------------------------

async function authorityWorld(outcomeRef = { value: "verified" }, consumeRef = { ok: true }) {
  const world = await deployedWorld();
  const mod = await import(pathToFileURL(
    path.join(world.live, "_authority", "authority-host.mjs")).href);
  const calls = [];
  const presence = {
    forSubsystem: (name) => ({
      name,
      verifier: {
        verify: async ({ operationRef }) => {
          calls.push(operationRef);
          return outcomeRef.value === "verified"
            ? { outcome: "verified", operation_ref: operationRef }
            : { outcome: outcomeRef.value, reason: `device said ${outcomeRef.value}` };
        },
        // The load-bearing half: it refuses a spent, copied, fabricated or
        // wrong-operation verification.
        authorizes: () => consumeRef,
      },
      budget: { mayPrompt: () => ({ ok: true }), recordOutcome: () => {} },
      now: () => 1_000_000,
    }),
  };
  const host = mod.createAuthorityHost({
      presence, now: () => 1_000_000,
      ownerControlsOrigin: "http://127.0.0.1:5313", apiOrigin: "http://127.0.0.1:5319",
    });

  const drive = async (route, { method = "POST", cookie = null } = {}) => {
    const headers = [];
    let payload = null;
    const res = { setHeader: (k, v) => headers.push([k, v]) };
    const ctx = { origin: null, send: (r, code, body) => { payload = { code, body }; return true; } };
    const req = {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      on(event, fn) { if (event === "end") fn(); return req; },
    };
    await host.handle(req, res, new URL(`http://127.0.0.1/__continuity/authority/${route}`), ctx);
    const set = headers.find(([k]) => k === "Set-Cookie")?.[1] ?? null;
    return { payload, cookie: set, token: set ? set.split(";")[0] : null };
  };
  return { world, host, drive, calls };
}

test("unlock: a verified presence that cannot be CONSUMED opens no session", async () => {
  const consume = { ok: false, reason: "already used or did not originate here" };
  const { world, drive } = await authorityWorld({ value: "verified" }, consume);
  try {
    const attempt = await drive("unlock_read");
    assert.equal(attempt.payload.code, 403);
    assert.equal(attempt.payload.body.error, "presence_not_valid");
    assert.equal(attempt.payload.body.unlocked, false);
    assert.equal(attempt.cookie, null, "no session cookie is handed out");

    // And the session really is not open — status agrees.
    const status = await drive("status", { method: "GET" });
    assert.equal(status.payload.body.open, false);
  } finally { await world.close(); }
});

test("lock_read: unauthenticated callers cannot kill her window", async () => {
  const { world, drive } = await authorityWorld();
  try {
    const opened = await drive("unlock_read");
    assert.equal(opened.payload.body.unlocked, true);

    // Any local process could previously clear this. Once mutations exist that
    // is a prompt-habituation path, not a nuisance.
    const uninvited = await drive("lock_read");
    assert.equal(uninvited.payload.code, 401);
    assert.equal((await drive("status", { method: "GET", cookie: opened.token })).payload.body.open, true,
      "her session survived");

    // A rotated-away session must not be able to clear the one that replaced it.
    const rotated = await drive("unlock_read");
    const stale = await drive("lock_read", { cookie: opened.token });
    assert.equal(stale.payload.code, 401, "S1 cannot clear S2");
    assert.equal((await drive("status", { method: "GET", cookie: rotated.token })).payload.body.open, true);

    // The holder can.
    const mine = await drive("lock_read", { cookie: rotated.token });
    assert.equal(mine.payload.code, 200);
    assert.equal((await drive("status", { method: "GET", cookie: rotated.token })).payload.body.open, false);
  } finally { await world.close(); }
});

test("status: one browser's unlock is not disclosed to the machine", async () => {
  const { world, drive } = await authorityWorld();
  try {
    const opened = await drive("unlock_read");

    // With the cookie: her own window, and only the expiry.
    const mine = await drive("status", { method: "GET", cookie: opened.token });
    assert.equal(mine.payload.body.open, true);
    assert.ok(mine.payload.body.expires_at);
    assert.ok(!JSON.stringify(mine.payload.body).includes(opened.token.split("=")[1]),
      "never the id");

    // Without it: nothing. Reporting the host-global session told every local
    // process whether owner controls were unlocked and when that window closed.
    const stranger = await drive("status", { method: "GET" });
    assert.equal(stranger.payload.body.open, false);
    assert.equal(stranger.payload.body.expires_at, undefined,
      "another browser's expiry must not be disclosed");
  } finally { await world.close(); }
});

test("authority preflight: the operator gate and the runtime gate agree", async () => {
  for (const damage of [
    { extra: "_authority/left-over.mjs" },
    { omit: "_authority/authority-read-session.js" },
  ]) {
    const world = await deployedWorld();
    try {
      if (damage.extra) fs.writeFileSync(path.join(world.live, damage.extra), "export const x = 1\n");
      if (damage.omit) {
        const manifestPath = path.join(world.state, "deployed.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.authority_files = manifest.authority_files.filter((f) => f.dest !== damage.omit);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }

      // Two things called "authority preflight" that can disagree is how a
      // governance report says PASS while production says FAIL.
      const operator = await world.deployMod.authorityPreflight({ liveDir: world.live, stateDir: world.state });
      const started = await world.launch();
      assert.equal(operator.ok, false, JSON.stringify(damage));
      assert.equal(started.authority_available, false, JSON.stringify(damage));
      assert.equal(operator.ok, started.authority_available, "the two gates must return one verdict");
      assert.equal(started.mode, "owner_rulings", "/api/act unaffected either way");
    } finally { await world.close(); }
  }
});

test("preflight provenance: a dirty checkout cannot change the deployed verdict", async () => {
  const world = await deployedWorld();
  try {
    const clean = await world.deployMod.authorityPreflight({ liveDir: world.live, stateDir: world.state });
    assert.equal(clean.ok, true, JSON.stringify(clean));
    assert.equal(clean.gate_source, "deployed");

    // Sabotage the WORKING TREE's copy of the gate so it would pass anything.
    // Delegating to the checkout shared source semantics only while the tree
    // happened to match the release — the same provenance class already fixed
    // for the guard transformation.
    const repoGate = path.join(world.repo, "ops", "live-host", "briefing-server.mjs");
    fs.writeFileSync(repoGate,
      "export function manifestAuthorityGate() { return { ok: true, entry: 'anything' } }\n");

    // Now break the deployed authority world. The checkout would say fine.
    fs.writeFileSync(path.join(world.live, "_authority", "smuggled.mjs"), "export const x = 1\n");

    const verdict = await world.deployMod.authorityPreflight({ liveDir: world.live, stateDir: world.state });
    assert.equal(verdict.ok, false, "the deployed gate is the one that answers");
    assert.match(verdict.reason, /unrecorded authority code/);

    // And the runtime agrees, which is the whole point of one implementation.
    const started = await world.launch();
    assert.equal(started.authority_available, false);
    assert.equal(verdict.ok, started.authority_available);
  } finally { await world.close(); }
});

test("cookie transport: only the owner-controls origin is credentialed", async () => {
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    const owner = "http://127.0.0.1:5313";
    const authority = `http://127.0.0.1:${started.port}/__continuity/authority/status`;

    // The configured owner-controls origin: credentialed, so the cookie can
    // travel at all.
    const mine = await fetch(authority, { headers: { Origin: owner } });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("access-control-allow-origin"), owner);
    assert.equal(mine.headers.get("access-control-allow-credentials"), "true");
    assert.notEqual(mine.headers.get("access-control-allow-origin"), "*",
      "credentials and a wildcard origin are mutually exclusive, and for good reason");

    // The case adding that header created: another loopback PORT is same-site
    // for cookie purposes, so credentialing every loopback origin would have
    // let a page there fetch with credentials:include and have the browser
    // attach her cookie. The authority routes refuse it outright, and send it
    // no CORS headers at all — a refusal that echoed the origin would still
    // tell a hostile page it had reached a real endpoint.
    const neighbour = await fetch(authority, { headers: { Origin: "http://127.0.0.1:7777" } });
    assert.equal(neighbour.status, 403);
    assert.equal((await neighbour.json()).error, "authority_origin_refused");
    assert.equal(neighbour.headers.get("access-control-allow-credentials"), null);
    assert.equal(neighbour.headers.get("access-control-allow-origin"), null);

    // localhost is a different HOST, so it is not the owner-controls origin
    // either, however loopback it looks.
    const localhost = await fetch(authority, { headers: { Origin: "http://localhost:5313" } });
    assert.equal(localhost.status, 403);

    // Legacy non-credentialed loopback reads are untouched.
    const legacy = await fetch(`http://127.0.0.1:${started.port}/api/decisions`, {
      headers: { Origin: "http://127.0.0.1:7777" },
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get("access-control-allow-credentials"), null);
  } finally { await world.close(); }
});

test("preflight: the credentialed OPTIONS + POST roundtrip both succeed", async () => {
  // A browser transaction is TWO requests. The preflight used to be answered
  // before the URL was parsed, so it never carried `Allow-Credentials` and the
  // legitimate credentialed POST failed before reaching the code that
  // authorises it. Testing the POST alone could never have caught that.
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    const owner = "http://127.0.0.1:5313";
    const url = `http://127.0.0.1:${started.port}/__continuity/authority/unlock_read`;

    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: owner,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), owner);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true",
      "without this the browser never sends the real request");

    // And the request the preflight was for is reachable with the same origin.
    const real = await fetch(url, {
      method: "POST",
      headers: { Origin: owner, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.notEqual(real.status, 403, "the origin gate must not refuse the origin it just approved");
    assert.equal(real.headers.get("access-control-allow-credentials"), "true");
  } finally { await world.close(); }
});

test("preflight: a wrong loopback origin gets NO CORS headers on OPTIONS either", async () => {
  // The claim "refused authority origins receive no CORS headers at all" was
  // false for OPTIONS while preflight was handled globally — which is the half
  // of the transaction a hostile page reaches first.
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    const url = `http://127.0.0.1:${started.port}/__continuity/authority/unlock_read`;

    for (const origin of ["http://127.0.0.1:7777", "http://localhost:5313"]) {
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
      assert.equal(preflight.status, 403, origin);
      assert.equal(preflight.headers.get("access-control-allow-origin"), null, origin);
      assert.equal(preflight.headers.get("access-control-allow-credentials"), null, origin);
    }

    // Negative control: the NON-authority routes keep their legacy loopback
    // preflight, so this test is measuring the authority gate and not a server
    // that stopped answering OPTIONS at all.
    const legacy = await fetch(`http://127.0.0.1:${started.port}/api/decisions`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:7777", "Access-Control-Request-Method": "GET" },
    });
    assert.equal(legacy.status, 204);
    assert.equal(legacy.headers.get("access-control-allow-origin"), "http://127.0.0.1:7777");
    assert.equal(legacy.headers.get("access-control-allow-credentials"), null);
  } finally { await world.close(); }
});

test("transaction: the commit route is served, authenticated, and refuses browser authority", async () => {
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    const base = `http://127.0.0.1:${started.port}/__continuity/authority`;
    assert.equal(started.authority_available, true);

    // Unauthenticated: 401, and no hint about what exists behind it.
    const anon = await fetch(`${base}/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: "op-1", preview_receipt: "r-1" }),
    });
    assert.equal(anon.status, 401);
    assert.equal(world.broker.calls.length, 0, "and it costs her no prompt");

    // Authenticated, via a real verified unlock.
    world.broker.answer = "verified";
    const unlock = await fetch(`${base}/unlock_read`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(unlock.status, 200);
    const cookie = unlock.headers.getSetCookie().join("; ");

    // The commit wire is two identifiers. Anything authoritative is REFUSED by
    // name, over HTTP, not merely in the unit under it.
    const promptsBefore = world.broker.calls.length;
    const overspecified = await fetch(`${base}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        operation_id: "op-1", preview_receipt: "r-1",
        authority_domain: "somebody-elses-blocker", scope_refs: ["scope:everything"],
      }),
    });
    assert.equal(overspecified.status, 400);
    const refused = await overspecified.json();
    assert.equal(refused.failure, "browser_authoritative_field");
    assert.deepEqual(refused.fields.sort(), ["authority_domain", "scope_refs"]);
    assert.equal(world.broker.calls.length, promptsBefore,
      "a refused wire must not reach a verification");
  } finally { await world.close(); }
});

test("transaction: the private exception adapter is not addressable", async () => {
  // The invariant that replaces the temporary "authority-host imports adapter:
  // 0". The adapter IS imported now — it has to be, the transaction resolves
  // her blockers — so the property that matters is that nothing outside the
  // journal can reach it.
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    const base = `http://127.0.0.1:${started.port}/__continuity/authority`;
    world.broker.answer = "verified";
    const unlock = await fetch(`${base}/unlock_read`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const cookie = unlock.headers.getSetCookie().join("; ");

    // No route addresses it, authenticated or not.
    for (const route of ["resolve", "exceptions", "adapter", "resolve_exception"]) {
      const response = await fetch(`${base}/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ exception_id: "anything", ruling_ref: "ruling:invented" }),
      });
      assert.equal(response.status, 501, route);
      assert.equal((await response.json()).error, "not_implemented", route);
    }

    // And the host states its own operation surface, which does not include it.
    const mod = await import(pathToFileURL(
      path.join(world.live, "_authority", "authority-host.mjs")).href);
    const host = mod.createAuthorityHost({
      presence: { forSubsystem: () => ({ verifier: {}, budget: {} }) },
      ownerControlsOrigin: "http://127.0.0.1:5313",
      apiOrigin: "http://127.0.0.1:5319",
      transaction: { operations: {}, receipts: {}, currentRevision: () => null, prepare: () => ({ ok: false }) },
    });
    // An EXACT list, so a route added by accident fails here rather than
    // quietly widening what the browser can ask for.
    assert.deepEqual(host.operations.sort(), [
      "blocker", "catalogue", "commit", "context", "current",
      "lock_read", "prepare", "status", "suggestions", "unlock_read",
    ]);
    for (const name of host.operations) {
      assert.ok(!/resolve|exception|adapter/.test(name), `${name} must not address the adapter`);
    }

    // And no ruling was made along the way.
    assert.equal(world.broker.calls.length, 1, "only the unlock asked her anything");
  } finally { await world.close(); }
});

test("reads: the surface serves REAL exception data for a stable domain", async () => {
  const world = await deployedWorld();
  try {
    const LOOP = "datascape/authority-under-test";
    world.fixture("2026-08-22-authority-domain", {
      loop: LOOP, evidence: "five lanes have no authoritative goal",
      proposed: "designate one goal envelope or one bounded task",
    });
    // A blocker in a DIFFERENT loop, so a surface that ignored the loop would
    // become ambiguous and fail rather than quietly pass.
    world.fixture("2026-08-22-unrelated", { loop: "sumzup/publish" });

    const started = await world.launch({ authorityLoop: LOOP });
    const base = `http://127.0.0.1:${started.port}/__continuity/authority`;
    world.broker.answer = "verified";
    const unlock = await fetch(`${base}/unlock_read`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const cookie = unlock.headers.getSetCookie().join("; ");

    const read = async (op) => {
      const r = await fetch(`${base}/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      });
      return { status: r.status, body: await r.json() };
    };

    const context = await read("context");
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.authority_domain, "2026-08-22-authority-domain");
    assert.equal(context.body.blocker.evidence, "five lanes have no authoritative goal");
    assert.equal(context.body.current, null, "no authority has been granted yet");

    // The catalogue is DERIVED from the loops that exist, not a fixture list.
    const refs = context.body.catalogue.map((c) => c.ref);
    assert.ok(refs.includes(`scope:${LOOP}`));
    assert.ok(refs.includes("scope:sumzup/publish"));

    // Suggestions are empty and SAY they are empty. An invented suggestion on
    // an authority screen is a machine proposing its own autonomy.
    assert.deepEqual(context.body.suggestions, []);
    assert.match(context.body.suggestions_reason, /no owner-authored suggestions/);

    // The read surface hands over what it was asked for, not the whole file.
    const serialised = JSON.stringify(context.body);
    assert.ok(!serialised.includes("Owner steps"), "the owner-steps section must not travel");
    assert.ok(!serialised.includes("fingerprint"), "internal dedupe keys must not travel");

    // Unauthenticated: nothing at all.
    const anon = await fetch(`${base}/context`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(anon.status, 401);
  } finally { await world.close(); }
});

test("reads: an unconfigured domain refuses by name and never guesses", async () => {
  const world = await deployedWorld();
  try {
    world.fixture("2026-08-22-one", { loop: "datascape/two-candidates" });
    const started = await world.launch({ authorityLoop: null });
    const base = `http://127.0.0.1:${started.port}/__continuity/authority`;
    const unlock = await fetch(`${base}/unlock_read`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const cookie = unlock.headers.getSetCookie().join("; ");
    const response = await fetch(`${base}/context`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).failure, "no_authority_loop");
  } finally { await world.close(); }
});

test("reads: two candidates in one loop REFUSE rather than picking by file order", async () => {
  const world = await deployedWorld();
  try {
    world.fixture("2026-08-22-one", { loop: "datascape/two-candidates" });
    world.fixture("2026-08-22-two", { loop: "datascape/two-candidates" });
    const started = await world.launch({ authorityLoop: "datascape/two-candidates" });
    const base = `http://127.0.0.1:${started.port}/__continuity/authority`;
    const unlock = await fetch(`${base}/unlock_read`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const cookie = unlock.headers.getSetCookie().join("; ");
    const response = await fetch(`${base}/context`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}",
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.failure, "ambiguous_authority_domain");
    assert.deepEqual(body.candidates.sort(), ["2026-08-22-one", "2026-08-22-two"]);

    // And prepare refuses for the same reason: an ambiguous domain must not be
    // resolvable by asking a different route.
    const prepared = await fetch(`${base}/prepare`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}",
    });
    assert.equal(prepared.status, 409);
    assert.equal((await prepared.json()).failure, "ambiguous_authority_domain");
  } finally { await world.close(); }
});

test("topology: an incompatible host reports the subsystem UNAVAILABLE", async () => {
  // The startup state used to say `authority_available: true` while every
  // authority request answered 503. The route failing closed is what protects
  // her; a status line claiming the subsystem is up is what makes a
  // misconfigured host look healthy to whoever reads it next.
  const world = await deployedWorld();
  try {
    const started = await world.launch({ ownerControlsOrigin: "http://localhost:5313" });
    assert.equal(started.authority_available, false,
      "a host whose every authority route 503s is not an available subsystem");
    assert.match(started.authority_reason, /not same-site|owner-controls origin/);

    // The route agrees, and /api/act is untouched — the two halves of failing
    // closed without taking her inbox controls down.
    const authority = await fetch(
      `http://127.0.0.1:${started.port}/__continuity/authority/status`);
    assert.equal(authority.status, 503);
    assert.equal((await authority.json()).error, "owner_controls_origin_incompatible");

    const decisions = await fetch(`http://127.0.0.1:${started.port}/api/decisions`);
    assert.equal(decisions.status, 200, "her inbox controls stay live");
  } finally { await world.close(); }
});

test("topology: an incompatible owner-controls origin fails closed", async () => {
  const world = await deployedWorld();
  try {
    const mod = await import(pathToFileURL(
      path.join(world.live, "_authority", "authority-host.mjs")).href);
    const presence = { forSubsystem: () => ({ verifier: {}, budget: {}, now: () => 0 }) };

    // The topology the launcher actually produces today.
    const mismatched = mod.createAuthorityHost({
      presence, now: () => 0,
      ownerControlsOrigin: "http://localhost:5313", apiOrigin: "http://127.0.0.1:5319",
    });
    assert.equal(mismatched.topology.ok, false);
    assert.match(mismatched.topology.reason, /not same-site/);

    // And an unconfigured host does not quietly start an authority route it
    // cannot keep a session for.
    const unset = mod.createAuthorityHost({
      presence, now: () => 0, ownerControlsOrigin: null, apiOrigin: "http://127.0.0.1:5319",
    });
    assert.equal(unset.topology.ok, false);
    assert.match(unset.topology.reason, /no owner-controls origin is configured/);

    // A host that starts happily and then cannot authenticate is worse than one
    // that says so, so every authority route answers 503 by name.
    let payload = null;
    const ctx = { origin: null, send: (r, code, body) => { payload = { code, body }; return true; } };
    await mismatched.handle({ method: "GET", headers: {} }, {},
      new URL("http://127.0.0.1/__continuity/authority/status"), ctx);
    assert.equal(payload.code, 503);
    assert.equal(payload.body.error, "owner_controls_origin_incompatible");
  } finally { await world.close(); }
});


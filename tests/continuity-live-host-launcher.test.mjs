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
async function spawnLikeCatchup(world, port) {
  const child = spawn(process.execPath, [path.join(world.live, "briefing-server.mjs")], {
    env: {
      ...process.env,
      BRIEFING_API_PORT: String(port),
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

  // Wait for it to answer, or to die.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/decisions`, { signal: AbortSignal.timeout(500) });
      if (probe.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, out: () => out, err: () => err, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

test("startup: the real spawned command gates before it can rule", async () => {
  const world = await deployedWorld();
  const port = 5390 + Math.floor(Math.random() * 300);
  const proc = await spawnLikeCatchup(world, port);
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
    const port = 5390 + Math.floor(Math.random() * 300);
    const proc = await spawnLikeCatchup(world, port);
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

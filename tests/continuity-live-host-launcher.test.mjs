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

import { deployedWorld } from "../ops/prb-deploy-world.mjs";

// ---------------------------------------------------------------------------
// Deployment installs the owner guard into the host's own store
// ---------------------------------------------------------------------------

test("deploy: production deployment guards the real exception store", async () => {
  const world = await deployedWorld();
  try {
    assert.equal(world.deployed.ok, true, JSON.stringify(world.deployed));
    assert.equal(world.deployed.exception_store.already_guarded, false);
    assert.ok(world.deployed.exception_store.preimage_hash, "the original bytes are recorded");

    const installed = fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8");
    assert.ok(installed.includes("__continuity_owner_gate__"),
      "copying owner-gate.js beside an unpatched store guards nothing");

    const manifest = JSON.parse(fs.readFileSync(path.join(world.state, "deployed.json"), "utf8"));
    assert.equal(manifest.exception_store.guarded_hash, world.deployed.exception_store.guarded_hash);
    assert.notEqual(manifest.exception_store.preimage_hash, manifest.exception_store.guarded_hash);
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
    assert.throws(() => store.setStatus(id, "resolved", "", "ruling:invented"),
      (error) => error.code === "unverified_ruling_ref");
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
    const second = world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
    assert.equal(second.ok, true);
    assert.equal(second.exception_store.already_guarded, true);
    assert.equal(second.exception_store.preimage_hash, world.deployed.exception_store.preimage_hash,
      "a rollback after a redeploy must restore the ORIGINAL store, not a patched one");
  } finally { await world.close(); }
});

// ---------------------------------------------------------------------------
// The launcher decides before the security runtime is imported
// ---------------------------------------------------------------------------

test("launcher: nothing security-bearing is imported at the top of the launcher", () => {
  const source = fs.readFileSync(new URL("../ops/live-host-launcher.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const topLevel = source.match(/^import[\s\S]*?from\s+["'][^"']+["']/gm) ?? [];
  for (const line of topLevel) {
    assert.ok(!/briefing-server|_continuity|owner-ruling|owner-presence/.test(line),
      `the launcher must not import ${line} before the gate that decides whether it may run`);
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
  ["a mixed security module", { mix: "_continuity/owner-presence.js" }, /does not match its reviewed commit/],
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

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sha = (t) => crypto.createHash("sha256").update(t.replace(/\r\n/g, "\n")).digest("hex");

/**
 * An isolated world. The real live host is never touched by these tests — the
 * whole point of the mechanism is that deployment is deliberate, so a test that
 * wrote to it would be the exact failure it guards against.
 */
async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "livehost-"));
  const live = path.join(dir, "live", "briefing-server.mjs");
  const source = path.join(dir, "src", "briefing-server.mjs");
  const manifest = path.join(dir, "src", "deployed.json");
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });

  process.env.LIVE_HOST_PATH = live;
  process.env.LIVE_HOST_SOURCE = source;
  process.env.LIVE_HOST_MANIFEST = manifest;
  // Fresh module instance so it reads this world's env.
  const mod = await import(`../ops/live-host-deploy.mjs?w=${Math.random().toString(36).slice(2)}`);
  return { dir, live, source, manifest, mod };
}

test("live-host: a drifted deployment is detected, not assumed", async () => {
  const { live, source, mod } = await world();
  fs.writeFileSync(source, "export const version = 1\n");
  fs.writeFileSync(live, "export const version = 1\n");
  assert.equal(mod.verifyDeployment().matches_reviewed_source, true);

  // Somebody edits the live file directly — the situation this mechanism exists
  // to make visible.
  fs.writeFileSync(live, "export const version = 1 // hand-edited\n");
  const drifted = mod.verifyDeployment();
  assert.equal(drifted.ok, false);
  assert.equal(drifted.matches_reviewed_source, false);
  assert.notEqual(drifted.live_hash, drifted.expected_hash);
});

test("live-host: a missing canonical source is reported, never treated as fine", async () => {
  const { live, mod } = await world();
  fs.writeFileSync(live, "export const version = 1\n");
  const status = mod.verifyDeployment();
  assert.equal(status.ok, false);
  assert.match(status.reason, /no canonical versioned source/);
});

test("live-host: reporting and dry runs never write", async () => {
  const { live, source, mod } = await world();
  fs.writeFileSync(source, "export const version = 2\n");
  fs.writeFileSync(live, "export const version = 1\n");

  const dry = mod.deploy({ dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.changes, true);
  assert.equal(fs.readFileSync(live, "utf8"), "export const version = 1\n", "a dry run must not deploy");
});

test("live-host: deploy is reproducible from a commit and rollback restores it", async () => {
  const { live, source, manifest, mod } = await world();
  const v1 = "export const version = 1\n";
  const v2 = "export const version = 2 // security fix\n";

  fs.writeFileSync(live, v1);
  fs.writeFileSync(source, v2);

  const deployed = mod.deploy({ commit: "abc1234", at: "2026-08-22T10:00:00+10:00", dryRun: false });
  assert.equal(deployed.ok, true);
  assert.equal(fs.readFileSync(live, "utf8"), v2);
  assert.equal(mod.verifyDeployment().matches_reviewed_source, true);
  assert.equal(mod.verifyDeployment().deployed_from_commit, "abc1234",
    "the deployed code must be traceable to a commit");

  // The previous version was kept, so a rollback target exists even for a file
  // that predates this mechanism.
  const rollback = mod.rollback({ toHash: sha(v1), dryRun: false });
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(live, "utf8"), v1, "rollback must restore the exact previous bytes");

  // And a rollback to something never seen fails rather than inventing one.
  assert.equal(mod.rollback({ toHash: "0".repeat(64), dryRun: false }).ok, false);
  assert.ok(JSON.parse(fs.readFileSync(manifest, "utf8")).rolled_back_to);
});

test("live-host: the real canonical source matches the file actually running", async () => {
  // No env override: this checks the REAL pairing, read-only.
  delete process.env.LIVE_HOST_PATH;
  delete process.env.LIVE_HOST_SOURCE;
  delete process.env.LIVE_HOST_MANIFEST;
  const mod = await import(`../ops/live-host-deploy.mjs?real=${Math.random().toString(36).slice(2)}`);
  const status = mod.verifyDeployment();

  // Skip rather than fail when the live host is not present — CI has no
  // _ship_inbox, and a test that fails there would teach people to ignore it.
  if (!status.live_hash) {
    assert.equal(status.ok, false);
    return;
  }
  assert.equal(status.matches_reviewed_source, true,
    "the security-relevant live code must be reproducible from this repo");
});

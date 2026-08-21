import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Read once, with no env overrides, purely for the artifact list.
const { ARTIFACT } = await import("../ops/live-host-deploy.mjs");

/**
 * An isolated world with a REAL git repository.
 *
 * The mechanism's whole claim is "these bytes came from this commit", so a test
 * that faked git would test nothing. The real live host is never touched —
 * deployment is deliberate, and a test that wrote to it would be the exact
 * failure it guards against.
 */
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "livehost-"));
  const repo = path.join(dir, "repo");
  const live = path.join(dir, "live");
  const state = path.join(dir, "state");
  fs.mkdirSync(path.join(repo, "ops", "live-host"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "continuity", "control"), { recursive: true });
  fs.mkdirSync(live, { recursive: true });

  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "lane@datascape.local");
  git("config", "user.name", "lane");
  git("config", "commit.gpgsign", "false");

  const write = (rel, text) => {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // Derived from the module's own artifact set, so adding a file to the
  // security layer cannot leave this world seeding a stale list.
  const sources = Object.fromEntries(
    ARTIFACT.map((entry, i) => [entry.source, `export const part${i} = 1\n`]),
  );
  for (const [rel, text] of Object.entries(sources)) write(rel, text);
  git("add", "-A");
  git("commit", "-qm", "v1");
  const v1 = git("rev-parse", "HEAD").trim();

  return { dir, repo, live, state, git, write, v1, sources };
}

/** The seeded bytes of one artifact source, so assertions never hardcode them. */
function sourceFor(w, source) {
  return w.sources[source];
}

async function load({ repo, live, state }) {
  process.env.LIVE_HOST_REPO = repo;
  process.env.LIVE_HOST_DIR = live;
  process.env.LIVE_HOST_STATE = state;
  return import(`../ops/live-host-deploy.mjs?w=${Math.random().toString(36).slice(2)}`);
}

test("live-host: an arbitrary string as commit creates no provenance", async () => {
  const w = world();
  const mod = await load(w);

  for (const claim of ["abc1234", "reviewed", "HEAD~99", ""]) {
    const attempt = mod.deploy({ commit: claim, dryRun: false });
    assert.equal(attempt.ok, false, `"${claim}" must not deploy`);
  }
  assert.equal(fs.existsSync(path.join(w.live, "briefing-server.mjs")), false,
    "a failed provenance check must write nothing");
});

test("live-host: deploy installs the exact bytes of a commit, and the whole file set", async () => {
  const w = world();
  const mod = await load(w);

  const dry = mod.deploy({ commit: w.v1, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.changes, true);
  assert.equal(fs.existsSync(path.join(w.live, "briefing-server.mjs")), false, "a dry run must not deploy");

  const deployed = mod.deploy({ commit: w.v1, at: "2026-08-22T10:00:00+10:00", dryRun: false });
  assert.equal(deployed.ok, true);
  assert.equal(deployed.files.length, ARTIFACT.length, "the security layer ships with the server, not separately");
  // The orchestrator ships beside the server, not separately.
  assert.equal(fs.readFileSync(path.join(w.live, "_continuity", "owner-ruling.js"), "utf8"),
    sourceFor(w, "src/continuity/control/owner-ruling.js"));

  const status = mod.verifyDeployment();
  assert.equal(status.matches_reviewed_source, true);
  assert.equal(status.deployed_from_commit, w.v1);
});

test("live-host: a dirty working tree that matches the live file is NOT reviewed source", async () => {
  const w = world();
  const mod = await load(w);
  mod.deploy({ commit: w.v1, dryRun: false });

  // Edit the tree and hand-edit the live file to match it. Under a working-tree
  // comparison this reads as a clean match — which is exactly the false
  // reassurance the git-object check exists to remove.
  const edited = "export const server = 1 // hand-edited\n";
  w.write("ops/live-host/briefing-server.mjs", edited);
  fs.writeFileSync(path.join(w.live, "briefing-server.mjs"), edited);

  const status = mod.verifyDeployment();
  assert.equal(status.matches_reviewed_source, false,
    "matching an uncommitted edit is not provenance");
  assert.deepEqual(status.working_tree_drift, ["ops/live-host/briefing-server.mjs"]);
});

test("live-host: drift in ANY artifact file fails verification, not just the server", async () => {
  const w = world();
  const mod = await load(w);
  mod.deploy({ commit: w.v1, dryRun: false });
  assert.equal(mod.verifyDeployment().ok, true);

  // The orchestrator is where the security property lives; a mechanism that
  // only watched the server would miss the file that decides the ruling.
  fs.writeFileSync(path.join(w.live, "_continuity", "owner-ruling.js"), "export const ruling = 666\n");
  const drifted = mod.verifyDeployment();
  assert.equal(drifted.ok, false);
  assert.equal(drifted.files.find((f) => f.dest === "_continuity/owner-ruling.js").matches, false);
  assert.equal(drifted.files.find((f) => f.dest === "briefing-server.mjs").matches, true);
});

test("live-host: rollback restores the exact previous bytes and drops the reviewed claim", async () => {
  const w = world();
  const mod = await load(w);
  mod.deploy({ commit: w.v1, dryRun: false });

  w.write("ops/live-host/briefing-server.mjs", "export const server = 2 // security fix\n");
  w.git("add", "-A");
  w.git("commit", "-qm", "v2");
  const v2 = w.git("rev-parse", "HEAD").trim();

  const second = mod.deploy({ commit: v2, dryRun: false });
  assert.equal(second.ok, true);
  assert.match(fs.readFileSync(path.join(w.live, "briefing-server.mjs"), "utf8"), /security fix/);

  const rolled = mod.rollback({ toBackupSet: second.backup_set, dryRun: false });
  assert.equal(rolled.ok, true);
  assert.equal(fs.readFileSync(path.join(w.live, "briefing-server.mjs"), "utf8"),
    sourceFor(w, "ops/live-host/briefing-server.mjs"),
    "rollback must restore the exact previous bytes");
  // Known-good is not known-reviewed.
  assert.equal(mod.verifyDeployment().matches_reviewed_source, false);
  assert.equal(mod.rollback({ toBackupSet: "never-existed", dryRun: false }).ok, false);
});

test("live-host: host state never lands inside the repository", async () => {
  const w = world();
  const mod = await load(w);
  mod.deploy({ commit: w.v1, dryRun: false });

  assert.ok(!path.resolve(mod.STATE_DIR).startsWith(path.resolve(w.repo) + path.sep),
    "the manifest and backups are private host state, not repository content");
  // And nothing appeared in the tree that `git add -A` would sweep up.
  assert.equal(w.git("status", "--porcelain").trim(), "");
});

test("live-host: the real live host still matches its reviewed commit", async () => {
  // No overrides: this checks the REAL pairing, read-only. The live host runs
  // the merged fail-closed build; PR B is held, so this must NOT be the
  // candidate.
  for (const key of ["LIVE_HOST_REPO", "LIVE_HOST_DIR", "LIVE_HOST_STATE"]) delete process.env[key];
  const mod = await import(`../ops/live-host-deploy.mjs?real=${Math.random().toString(36).slice(2)}`);

  let merged = null;
  try {
    merged = execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/master^{commit}"], { encoding: "utf8" }).trim();
  } catch { /* no remote ref here */ }
  // Skip rather than fail where the live host or the ref is absent — CI has no
  // _ship_inbox, and a test that fails there would teach people to ignore it.
  if (!merged || !fs.existsSync(path.join(mod.LIVE_DIR, "briefing-server.mjs"))) return;

  const status = mod.verifyAgainstCommit({ commit: merged, only: ["briefing-server.mjs"] });
  assert.equal(status.ok, true,
    "the security-relevant live code must be reproducible from the merged commit");
});

test("live-host: the startup gate refuses a partial or mismatched artifact set", async () => {
  const w = world();
  const mod = await load(w);
  mod.deploy({ commit: w.v1, dryRun: false });
  assert.equal(mod.preflight().ok, true);

  // A deploy interrupted between files: the server is new, one security module
  // never arrived.
  fs.rmSync(path.join(w.live, "_continuity", "owner-ruling.js"));
  const incomplete = mod.preflight();
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.artifact_complete, false);
  assert.equal(incomplete.artifact_present, ARTIFACT.length - 1);

  // And a MIXED set — every file present, one of them from somewhere else — is
  // just as unservable as a missing one.
  fs.writeFileSync(path.join(w.live, "_continuity", "owner-ruling.js"), "export const smuggled = 1\n");
  const mixed = mod.preflight();
  assert.equal(mixed.ok, false);
  assert.equal(mixed.artifact_complete, true, "complete, and still not reviewed");
  assert.deepEqual(mixed.mismatched, ["_continuity/owner-ruling.js"]);
});

// live-host:deploy — reproducible deployment for the unversioned live host
// (spec V6.1.6-A.2.1.1, hardened by A.2 PR B).
//
// `_ship_inbox/ops/briefing-server.mjs` is the process that serves her briefing
// and performs owner rulings. It is not under version control anywhere, so a
// security-critical change to it has no canonical source and no rollback.
//
// This does not move `_ship_inbox` into the repo, which would violate its
// architecture. It gives the SECURITY-RELEVANT layer a canonical versioned
// source here, plus a verifiable deployment.
//
// TWO THINGS CHANGED IN PR B, both because the first version proved less than
// it appeared to:
//
//  1. "Reviewed source" now means a GIT OBJECT, not the working-tree file.
//     Reading the file on disk proved "live equals whatever is checked out
//     right now", which a dirty tree satisfies trivially. Expectations are read
//     with `git cat-file blob <commit>:<path>`, so an uncommitted edit that
//     happens to match the live file does NOT make it reviewed, and passing an
//     arbitrary string as `commit` produces no provenance at all.
//
//  2. Deployment is a FILE SET, not one file. The verified owner-mutation
//     orchestrator and the owner-presence runtime ship beside the server as
//     `_continuity/`, so production never imports its security layer from a
//     mutable development working tree.
//
// Manifest and backups live OUTSIDE the repository. They are private host
// state: which machine is running which build is not a fact about the source,
// and it must never be a candidate for `git add -A`.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.env.LIVE_HOST_REPO || process.cwd();

/** Where the live host runs. */
export const LIVE_DIR = process.env.LIVE_HOST_DIR || "D:/Projects/_ship_inbox/ops";

/**
 * Private host state — deliberately not under the repo.
 * `%LOCALAPPDATA%/datascape/live-host` on Windows, `~/.local/state/...` elsewhere.
 */
export const STATE_DIR = process.env.LIVE_HOST_STATE
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "datascape", "live-host");

const MANIFEST = () => path.join(STATE_DIR, "deployed.json");
const BACKUPS = () => path.join(STATE_DIR, "backups");

/**
 * The reviewed artifact: every file whose bytes the security property depends
 * on, with the repo path it comes from and where it lands in the live host.
 */
export const ARTIFACT = [
  { dest: "briefing-server.mjs", source: "ops/live-host/briefing-server.mjs" },
  { dest: "_continuity/owner-ruling.js", source: "src/continuity/control/owner-ruling.js" },
  { dest: "_continuity/owner-presence.js", source: "src/continuity/control/owner-presence.js" },
  { dest: "_continuity/owner-presence-windows.js", source: "src/continuity/control/owner-presence-windows.js" },
];

/**
 * Host dependencies: not ours to version, but they decide whether an owner
 * ruling actually lands, so their bytes are recorded as deployment evidence.
 */
export const HOST_DEPENDENCIES = ["exception.mjs", "briefing.mjs", "mustread.mjs"];

export const sha = (text) =>
  crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
};

/** Resolve a ref to a real commit. An arbitrary string resolves to nothing. */
export function resolveCommit(commit) {
  if (!commit) return null;
  const resolved = git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  return resolved ? resolved.trim() : null;
}

/** The bytes of one path AS OF a commit. Never the working tree. */
export function gitBlob(commit, repoPath) {
  return git(["cat-file", "blob", `${commit}:${repoPath}`]);
}

/** Do the working-tree copies of the artifact differ from the commit? Evidence only. */
export function workingTreeDrift(commit) {
  const drifted = [];
  for (const entry of ARTIFACT) {
    const committed = gitBlob(commit, entry.source);
    const working = read(path.join(REPO, entry.source));
    if (committed === null || working === null || sha(committed) !== sha(working)) drifted.push(entry.source);
  }
  return drifted;
}

/**
 * Materialize the exact reviewed bytes of a commit into a directory.
 *
 * This is the only way bytes ever reach a live host. There is no path from the
 * working tree to a deployment.
 */
export function stage({ commit, dir }) {
  const resolved = resolveCommit(commit);
  if (!resolved) return { ok: false, reason: `not a commit in this repository: ${commit}` };

  const files = [];
  for (const entry of ARTIFACT) {
    const bytes = gitBlob(resolved, entry.source);
    if (bytes === null) {
      return { ok: false, reason: `${entry.source} does not exist at ${resolved.slice(0, 12)}` };
    }
    const target = path.join(dir, entry.dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    files.push({ dest: entry.dest, source: entry.source, hash: sha(bytes) });
  }
  return { ok: true, commit: resolved, dir, files };
}

/** Hash the host's own dependencies as they exist right now. */
function hostDependencyEvidence(liveDir) {
  return HOST_DEPENDENCIES.map((name) => {
    const bytes = read(path.join(liveDir, name));
    return { name, present: bytes !== null, hash: bytes === null ? null : sha(bytes) };
  });
}

/**
 * What is actually running right now, and is every byte of it reproducible
 * from the commit the manifest names?
 */
export function verifyDeployment({ liveDir = LIVE_DIR } = {}) {
  const manifest = JSON.parse(read(MANIFEST()) || "null");

  if (!manifest?.commit) {
    return {
      ok: false, matches_reviewed_source: false, live_hash: null,
      deployed_from_commit: null,
      reason: "no deployment manifest — this host has never been deployed by this mechanism",
    };
  }
  const resolved = resolveCommit(manifest.commit);
  if (!resolved) {
    return {
      ok: false, matches_reviewed_source: false, live_hash: null,
      deployed_from_commit: manifest.commit,
      reason: `the manifest names a commit this repository does not have: ${manifest.commit}`,
    };
  }

  const files = ARTIFACT.map((entry) => {
    const expectedBytes = gitBlob(resolved, entry.source);
    const liveBytes = read(path.join(liveDir, entry.dest));
    const recorded = (manifest.files || []).find((f) => f.dest === entry.dest);
    return {
      dest: entry.dest,
      source: entry.source,
      // The expectation comes from the git object. A dirty working tree that
      // happens to match the live file cannot make this true.
      expected_hash: expectedBytes === null ? null : sha(expectedBytes),
      manifest_hash: recorded?.hash ?? null,
      live_hash: liveBytes === null ? null : sha(liveBytes),
      matches: expectedBytes !== null && liveBytes !== null
        && sha(expectedBytes) === sha(liveBytes)
        // The manifest must agree too, or the record of what was deployed is
        // not the record of what is running.
        && recorded?.hash === sha(expectedBytes),
    };
  });

  const matches = files.every((f) => f.matches);
  const primary = files.find((f) => f.dest === "briefing-server.mjs");

  return {
    ok: matches,
    matches_reviewed_source: matches,
    deployed_from_commit: resolved,
    deployed_at: manifest.deployed_at ?? null,
    live_hash: primary?.live_hash ?? null,
    expected_hash: primary?.expected_hash ?? null,
    files,
    // Reported, not enforced: an edit in the tree does not change what is
    // running, but somebody reading this should know the two have diverged.
    working_tree_drift: workingTreeDrift(resolved),
    host_dependencies: hostDependencyEvidence(liveDir),
    reason: matches ? null : "at least one deployed file does not match its reviewed commit",
  };
}

/**
 * Read-only: does the live host match a NAMED commit, manifest or not?
 *
 * Needed for the host deployed by the previous single-file mechanism, and for
 * any check that wants to ask about a specific commit rather than trust the
 * manifest's claim about itself.
 */
export function verifyAgainstCommit({ commit, liveDir = LIVE_DIR, only = null } = {}) {
  const resolved = resolveCommit(commit);
  if (!resolved) return { ok: false, reason: `not a commit in this repository: ${commit}` };

  const wanted = only ? ARTIFACT.filter((e) => only.includes(e.dest)) : ARTIFACT;
  const files = wanted.map((entry) => {
    const expected = gitBlob(resolved, entry.source);
    const live = read(path.join(liveDir, entry.dest));
    return {
      dest: entry.dest,
      expected_hash: expected === null ? null : sha(expected),
      live_hash: live === null ? null : sha(live),
      matches: expected !== null && live !== null && sha(expected) === sha(live),
    };
  });
  return { ok: files.every((f) => f.matches), commit: resolved, files };
}

/**
 * Deploy the exact bytes of a commit over the live host.
 *
 * Backs up every file it is about to replace first, so a rollback target exists
 * even for files that arrived before this mechanism did.
 */
export function deploy({ commit, at = null, dryRun = true, liveDir = LIVE_DIR } = {}) {
  const resolved = resolveCommit(commit);
  if (!resolved) return { ok: false, reason: `not a commit in this repository: ${commit}` };

  const staged = [];
  for (const entry of ARTIFACT) {
    const bytes = gitBlob(resolved, entry.source);
    if (bytes === null) return { ok: false, reason: `${entry.source} does not exist at ${resolved.slice(0, 12)}` };
    const target = path.join(liveDir, entry.dest);
    const live = read(target);
    staged.push({ ...entry, bytes, target, live, hash: sha(bytes), live_hash: live === null ? null : sha(live) });
  }

  const changes = staged.some((f) => f.live_hash !== f.hash);
  if (dryRun) {
    return {
      ok: true, dry_run: true, commit: resolved, changes,
      files: staged.map((f) => ({ dest: f.dest, hash: f.hash, live_hash: f.live_hash, would_write: f.target })),
      working_tree_drift: workingTreeDrift(resolved),
    };
  }

  const backupSet = `${resolved.slice(0, 12)}-${sha(staged.map((f) => f.live_hash).join("|")).slice(0, 8)}`;
  const backupDir = path.join(BACKUPS(), backupSet);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const file of staged) {
    if (file.live !== null) {
      const backup = path.join(backupDir, file.dest);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, file.live);
    }
    fs.mkdirSync(path.dirname(file.target), { recursive: true });
    // Temp + rename: a reader sees the old file or the new one, never half of
    // either — the same discipline the authority journal uses.
    const tmp = `${file.target}.tmp`;
    fs.writeFileSync(tmp, file.bytes);
    fs.renameSync(tmp, file.target);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST(), JSON.stringify({
    commit: resolved,
    deployed_at: at,
    files: staged.map((f) => ({ dest: f.dest, source: f.source, hash: f.hash })),
    previous: { backup_set: backupSet, files: staged.map((f) => ({ dest: f.dest, hash: f.live_hash })) },
    host_dependencies: hostDependencyEvidence(liveDir),
  }, null, 2));

  return { ok: true, dry_run: false, commit: resolved, backup_set: backupSet, files: staged.map((f) => ({ dest: f.dest, hash: f.hash })) };
}

/** Restore a previous known-good file set by its backup id. */
export function rollback({ toBackupSet, at = null, dryRun = true, liveDir = LIVE_DIR } = {}) {
  const backupDir = path.join(BACKUPS(), String(toBackupSet || ""));
  if (!toBackupSet || !fs.existsSync(backupDir)) {
    return { ok: false, reason: `no backup set ${toBackupSet}` };
  }
  const restore = ARTIFACT
    .map((entry) => ({ ...entry, bytes: read(path.join(backupDir, entry.dest)) }))
    .filter((entry) => entry.bytes !== null);
  if (!restore.length) return { ok: false, reason: `backup set ${toBackupSet} contains nothing to restore` };

  if (dryRun) {
    return { ok: true, dry_run: true, would_restore: restore.map((f) => ({ dest: f.dest, hash: sha(f.bytes) })) };
  }

  for (const file of restore) {
    const target = path.join(liveDir, file.dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, file.bytes);
    fs.renameSync(tmp, target);
  }
  const manifest = JSON.parse(read(MANIFEST()) || "{}");
  fs.writeFileSync(MANIFEST(), JSON.stringify({
    ...manifest,
    // A rollback deliberately leaves no reviewed-commit claim: restored bytes
    // are known-good, not known-reviewed, and pretending otherwise would make
    // `matches_reviewed_source` mean two different things.
    commit: null,
    rolled_back_to: toBackupSet,
    rolled_back_at: at,
    files: restore.map((f) => ({ dest: f.dest, hash: sha(f.bytes) })),
  }, null, 2));
  return { ok: true, dry_run: false, restored: restore.map((f) => ({ dest: f.dest, hash: sha(f.bytes) })) };
}

// Run directly: report only. Deployment is an explicit, non-default act.
const invokedDirectly = process.argv[1]
  && import.meta.url === `file:///${process.argv[1].split(path.sep).join("/")}`;
if (invokedDirectly) {
  const status = verifyDeployment();
  console.log(JSON.stringify({
    live_host_dir: LIVE_DIR,
    host_state_dir: STATE_DIR,
    state_inside_repository: path.resolve(STATE_DIR).startsWith(path.resolve(REPO) + path.sep),
    ...status,
    // Stated rather than implied: reporting never writes.
    write_performed: "NO",
  }, null, 2));
  process.exit(status.ok ? 0 : 1);
}

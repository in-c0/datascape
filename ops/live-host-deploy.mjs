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
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import { GUARD_V2_MARKER, classifyGuard, stripGuard } from "./exception-guard-patch.mjs";

// Read at CALL time, not at import time. Capturing these when the module first
// loaded meant whichever caller imported it first fixed the paths for everyone
// afterwards — a launcher that imported this module before its environment was
// arranged would silently verify a different host than the one it was starting.
const repoDir = () => process.env.LIVE_HOST_REPO || process.cwd();

/** Where the live host runs. */
const liveDir_ = () => process.env.LIVE_HOST_DIR || "D:/Projects/_ship_inbox/ops";
export const liveDir = liveDir_;

/**
 * Private host state — deliberately not under the repo.
 * `%LOCALAPPDATA%/datascape/live-host` on Windows, `~/.local/state/...` elsewhere.
 */
export const stateDir = () => process.env.LIVE_HOST_STATE
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "datascape", "live-host");

const MANIFEST = () => path.join(stateDir(), "deployed.json");
const BACKUPS = () => path.join(stateDir(), "backups");

/**
 * The reviewed artifact: every file whose bytes the security property depends
 * on, with the repo path it comes from and where it lands in the live host.
 */
export const ARTIFACT = [
  // The entry point catchup already spawns. It gates, then imports the core.
  { dest: "briefing-server.mjs", source: "ops/live-host/briefing-server.mjs" },
  { dest: "_continuity/briefing-server-core.mjs", source: "ops/live-host/briefing-server-core.mjs" },
  { dest: "_continuity/owner-ruling.js", source: "src/continuity/control/owner-ruling.js" },
  { dest: "_continuity/owner-presence.js", source: "src/continuity/control/owner-presence.js" },
  { dest: "_continuity/owner-ruling-policy.js", source: "src/continuity/control/owner-ruling-policy.js" },
  { dest: "_continuity/exception-atomic.js", source: "src/continuity/control/exception-atomic.js" },
  { dest: "_continuity/owner-presence-windows.js", source: "src/continuity/control/owner-presence-windows.js" },
  { dest: "_continuity/owner-presence-coordinator.js", source: "src/continuity/control/owner-presence-coordinator.js" },
];

/**
 * The AUTHORITY artifact — a separate reviewed group, deployed to `_authority/`.
 *
 * Separate because a broken authority build must not be able to stop the base
 * owner-ruling host from loading. Its files are hash-recorded independently, and
 * the entry point gates them independently, so "authority is broken" and "the
 * host is broken" stay different sentences.
 *
 * The gate was built and tested while this group was empty, deliberately, so
 * the failure path shipped before the thing it gates.
 */
export const AUTHORITY_ARTIFACT = [
  { dest: "_authority/authority-host.mjs", source: "ops/live-host/authority-host.mjs" },
  { dest: "_authority/authority-read-session.js", source: "src/continuity/control/authority-read-session.js" },
  { dest: "_authority/authority-exception-adapter.js", source: "src/continuity/control/authority-exception-adapter.js" },
];

/** The one module the host imports to reach the authority subsystem. */
export const AUTHORITY_ENTRY = "_authority/authority-host.mjs";

/**
 * Host dependencies: not ours to version, but they decide whether an owner
 * ruling actually lands, so their bytes are recorded as deployment evidence.
 */
export const HOST_DEPENDENCIES = ["exception.mjs", "briefing.mjs", "mustread.mjs"];

/**
 * The host's exception store, which deployment PATCHES rather than replaces.
 *
 * Copying `owner-gate.js` beside an unpatched store guards nothing: the store's
 * own CLI calls its own internal `setStatus`. The acceptance world patched it
 * and proved the bypass closed there — which said nothing about the release
 * path, because deployment never touched it. It does now.
 */
export const GUARDED_STORE = "exception.mjs";

/** Where the reviewed guard transformation lives in the repository. */
export const GUARD_SOURCE = "ops/exception-guard-patch.mjs";

/**
 * Files a previous release installed that this one no longer ships.
 *
 * Removed only AFTER the store transformation succeeds. The live store's V1
 * guard imports `_continuity/owner-gate.js`, so deleting it before the store is
 * migrated would leave a window where the module every lane loads points at a
 * file that is gone.
 */
export const RETIRED_ARTIFACT = ["_continuity/owner-gate.js"];

export const sha = (text) =>
  crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: repoDir(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
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
    const working = read(path.join(repoDir(), entry.source));
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
export function verifyDeployment({ liveDir = liveDir_() } = {}) {
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
 * Load the guard transformation AS OF a commit.
 *
 * The artifact bytes already came from `git cat-file`, but the transformation
 * that produces the guarded store did not — it was the working tree's copy,
 * imported at the top of this file, and the manifest recorded the working
 * tree's hash as if it were provenance. An edited checkout could therefore
 * change what a "reviewed" deployment actually installed.
 *
 * So the reviewed bytes are materialized to a temp file and imported from
 * there. Nothing in the working tree participates in the transformation.
 */
async function reviewedGuard(commit) {
  const bytes = gitBlob(commit, GUARD_SOURCE);
  if (bytes === null) return { ok: false, reason: `${GUARD_SOURCE} does not exist at ${commit.slice(0, 12)}` };

  const working = read(path.join(repoDir(), GUARD_SOURCE));
  if (working !== null && sha(working) !== sha(bytes)) {
    // Refuse rather than quietly proceed. Materializing from the blob already
    // makes the edit harmless, but an operator deploying from a tree whose
    // security transformation they have modified is almost certainly not
    // deploying what they believe they are.
    return {
      ok: false,
      reason: `the working-tree ${GUARD_SOURCE} differs from ${commit.slice(0, 12)}; `
        + "commit or restore it before deploying a security transformation",
      dirty: true,
    };
  }

  const file = path.join(os.tmpdir(), `continuity-guard-${sha(bytes).slice(0, 16)}.mjs`);
  fs.writeFileSync(file, bytes);
  const module = await import(pathToFileURL(file).href);
  return { ok: true, patch: module.patchExceptionSource, hash: sha(bytes) };
}

/**
 * Every code file currently sitting in the live `_authority/` directory.
 *
 * The actual set, not the manifest's idea of it — the two disagreeing is the
 * failure this exists to detect.
 */
export function listAuthorityFiles(liveDir = liveDir_()) {
  const root = path.join(liveDir, "_authority");
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), `${rel}/`); continue; }
      if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(rel);
    }
  };
  walk(root, "_authority/");
  return out.sort();
}

/** The live store's bytes, and whether the owner gate is installed in them. */
export function guardedStoreState({ liveDir = liveDir_() } = {}) {
  const raw = read(path.join(liveDir, GUARDED_STORE));
  if (raw === null) return { present: false, patched: false, version: "absent", hash: null };
  const guard = classifyGuard(raw);
  return {
    present: true,
    // Only the CURRENT reviewed guard counts as guarded. A V1 store is patched
    // and still wrong: it makes the store non-relocatable.
    patched: guard.version === "v2",
    version: guard.version,
    hash: sha(raw),
    marker: GUARD_V2_MARKER,
  };
}

/**
 * Read-only: does the live host match a NAMED commit, manifest or not?
 *
 * Needed for the host deployed by the previous single-file mechanism, and for
 * any check that wants to ask about a specific commit rather than trust the
 * manifest's claim about itself.
 */
export function verifyAgainstCommit({ commit, liveDir = liveDir_(), only = null } = {}) {
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
 * The AUTHORITY subsystem's own gate.
 *
 * Deliberately separate from `preflight()`. A caller asks this question after
 * the base gate has already passed, and a "no" here disables one route rather
 * than the host.
 */
export function authorityPreflight({ liveDir = liveDir_() } = {}) {
  const manifest = JSON.parse(read(MANIFEST()) || "null");
  const recorded = manifest?.authority_files ?? null;

  if (!AUTHORITY_ARTIFACT.length) {
    return { ok: false, reason: "no authority artifact is part of this release yet", files: [], expected: 0 };
  }
  if (!recorded) {
    return { ok: false, reason: "this deployment recorded no authority artifact", files: [], expected: AUTHORITY_ARTIFACT.length };
  }

  const files = AUTHORITY_ARTIFACT.map((entry) => {
    const live = read(path.join(liveDir, entry.dest));
    const expected = recorded.find((f) => f.dest === entry.dest);
    return {
      dest: entry.dest,
      present: live !== null,
      matches: live !== null && Boolean(expected) && sha(live) === expected.hash,
    };
  });
  const missing = files.filter((f) => !f.present).map((f) => f.dest);
  const drifted = files.filter((f) => f.present && !f.matches).map((f) => f.dest);

  return {
    ok: missing.length === 0 && drifted.length === 0,
    files, missing, drifted, expected: AUTHORITY_ARTIFACT.length,
    reason: missing.length ? `authority artifact incomplete: missing ${missing.join(", ")}`
      : drifted.length ? `authority artifact does not match this deployment: ${drifted.join(", ")}`
      : null,
  };
}

/**
 * The startup gate.
 *
 * Deployment replaces the artifact files one at a time, so a machine or process
 * failure mid-deploy can leave an old server beside a new orchestrator, or a
 * `_continuity/` set with a file missing. Nothing previously refused to run in
 * that state — the host would simply start and serve owner rulings out of a
 * half-installed security layer.
 *
 * A launcher calls this before deciding whether the owner-mutation route may
 * exist at all. The server itself never needs to know about Git.
 */
export function preflight({ liveDir = liveDir_() } = {}) {
  const status = verifyDeployment({ liveDir });
  const present = (status.files ?? []).filter((f) => f.live_hash !== null).length;
  const complete = present === ARTIFACT.length;

  // The guarded store is security-bearing too. A host whose exception store
  // reverted to its unpatched form has a live impersonation route, however
  // perfect the rest of the artifact is.
  const manifest = JSON.parse(read(MANIFEST()) || "null");
  const store = guardedStoreState({ liveDir });
  const expectedStore = manifest?.exception_store?.guarded_hash ?? null;
  const storeOk = store.present && store.patched && expectedStore !== null && store.hash === expectedStore;

  return {
    ok: Boolean(status.ok) && complete && storeOk,
    exception_store_guarded: storeOk,
    exception_store_hash: store.hash,
    exception_store_expected_hash: expectedStore,
    artifact_complete: complete,
    artifact_expected: ARTIFACT.length,
    artifact_present: present,
    matches_reviewed_source: Boolean(status.matches_reviewed_source),
    deployed_from_commit: status.deployed_from_commit ?? null,
    mismatched: (status.files ?? []).filter((f) => !f.matches).map((f) => f.dest),
    reason: (() => {
      if (!complete) return `the deployed security layer is incomplete: ${present}/${ARTIFACT.length} files`;
      if (!status.ok) return status.reason;
      if (!storeOk) {
        if (store.version === "v1") {
          return "the exception store still carries the V1 imported guard, which makes it non-relocatable";
        }
        return store.patched
          ? "the guarded exception store does not match the hash this deployment recorded"
          : "the exception store is not guarded, so the legacy CLI could still close owner-gated items";
      }
      return null;
    })(),
  };
}

/**
 * Deploy the exact bytes of a commit over the live host.
 *
 * Backs up every file it is about to replace first, so a rollback target exists
 * even for files that arrived before this mechanism did.
 */
export async function deploy({ commit, at = null, dryRun = true, liveDir = liveDir_() } = {}) {
  const resolved = resolveCommit(commit);
  if (!resolved) return { ok: false, reason: `not a commit in this repository: ${commit}` };

  const staged = [];
  for (const entry of [...ARTIFACT, ...AUTHORITY_ARTIFACT]) {
    const bytes = gitBlob(resolved, entry.source);
    if (bytes === null) return { ok: false, reason: `${entry.source} does not exist at ${resolved.slice(0, 12)}` };
    const target = path.join(liveDir, entry.dest);
    const live = read(target);
    staged.push({ ...entry, bytes, target, live, hash: sha(bytes), live_hash: live === null ? null : sha(live) });
  }

  const changes = staged.some((f) => f.live_hash !== f.hash);
  if (dryRun) {
    const dryGuard = await reviewedGuard(resolved);
    if (!dryGuard.ok) return { ok: false, dry_run: true, reason: dryGuard.reason, dirty_guard: Boolean(dryGuard.dirty) };
    return {
      ok: true, dry_run: true, commit: resolved, changes,
      files: staged.filter((f) => !f.dest.startsWith("_authority/"))
        .map((f) => ({ dest: f.dest, hash: f.hash, live_hash: f.live_hash, would_write: f.target })),
      authority_files: staged.filter((f) => f.dest.startsWith("_authority/"))
        .map((f) => ({ dest: f.dest, hash: f.hash, live_hash: f.live_hash, would_write: f.target })),
      would_guard_exception_store: !guardedStoreState({ liveDir }).patched,
      working_tree_drift: workingTreeDrift(resolved),
    };
  }

  // The host's own store is patched, not replaced. Refuse to deploy at all if
  // the guard cannot be installed — a deployment that silently leaves the
  // legacy CLI open is exactly the gap this closes.
  const storePath = path.join(liveDir, GUARDED_STORE);
  const storeRaw = read(storePath);
  if (storeRaw === null) return { ok: false, reason: `the host exception store is missing at ${storePath}` };
  const currentGuard = classifyGuard(storeRaw);
  if (currentGuard.version === "ambiguous") {
    return { ok: false, reason: `the live store cannot be classified: ${currentGuard.reason}`, store_version: "ambiguous" };
  }

  const reviewed = await reviewedGuard(resolved);
  if (!reviewed.ok) return { ok: false, reason: reviewed.reason, dirty_guard: Boolean(reviewed.dirty) };
  const guard = reviewed.patch(storeRaw);
  if (!guard.ok) return { ok: false, reason: `the owner guard could not be installed: ${guard.reason}` };

  const priorManifest = JSON.parse(read(MANIFEST()) || "null");
  const priorStore = priorManifest?.exception_store ?? {};
  // TWO DISTINCT FACTS, deliberately not collapsed:
  //
  //   original_preimage_hash — what this store looked like before Continuity
  //                            ever guarded it. Carried forward forever.
  //   previous_release_hash  — the bytes this deploy is replacing, i.e. one
  //                            release back.
  //
  // The first version derived the preimage from "is it already guarded?", which
  // was fine for a redeploy and wrong for a MIGRATION: a V1 store is not
  // already-guarded in the V2 sense, so its bytes would have been recorded as
  // the original and a later rollback would have restored a patched file
  // calling itself untouched.
  let originalPreimageHash = priorStore.original_preimage_hash ?? priorStore.preimage_hash ?? null;
  if (!originalPreimageHash) {
    if (currentGuard.version === "unpatched") {
      originalPreimageHash = sha(storeRaw);
    } else {
      // A guarded store whose manifest history is gone. Persisting null here
      // would record "we do not know what this file originally was" as though
      // it were a fact about the release, and every later rollback would
      // inherit that blank. Derive it with the reviewed inverse transform
      // instead, and refuse if the guard is not one we can reverse exactly.
      const clean = stripGuard(storeRaw);
      if (!clean.ok) {
        return {
          ok: false,
          failure: "original_preimage_unrecoverable",
          reason: `the store is ${currentGuard.version} and no manifest records its original bytes: ${clean.reason}`,
        };
      }
      originalPreimageHash = sha(clean.source);
    }
  }
  const previousReleaseHash = sha(storeRaw);

  const backupSet = `${resolved.slice(0, 12)}-${sha(staged.map((f) => f.live_hash).join("|")).slice(0, 8)}`;
  const backupDir = path.join(BACKUPS(), backupSet);
  fs.mkdirSync(backupDir, { recursive: true });

  // Back up the store's exact previous bytes before touching it, and anything
  // this release retires, so a rollback restores the whole previous world.
  const storeBackup = path.join(backupDir, GUARDED_STORE);
  if (!fs.existsSync(storeBackup)) fs.writeFileSync(storeBackup, storeRaw);
  for (const dest of RETIRED_ARTIFACT) {
    const bytes = read(path.join(liveDir, dest));
    if (bytes === null) continue;
    const target = path.join(backupDir, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
  }

  // The WHOLE previous authority world, whatever was in it. Recorded by name so
  // a rollback can tell "this file existed before" from "this file is ours and
  // had no predecessor" — the second must be DELETED on rollback, or a
  // rolled-back host ends up with candidate authority code sitting beside old
  // base code.
  const previousAuthority = listAuthorityFiles(liveDir);
  for (const dest of previousAuthority) {
    const bytes = read(path.join(liveDir, dest));
    if (bytes === null) continue;
    const target = path.join(backupDir, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
  }
  fs.writeFileSync(path.join(backupDir, "authority-world.json"), JSON.stringify(previousAuthority, null, 2));

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

  // Atomically install the guarded store.
  const storeTmp = `${storePath}.tmp`;
  fs.writeFileSync(storeTmp, guard.source);
  fs.renameSync(storeTmp, storePath);

  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(MANIFEST(), JSON.stringify({
    commit: resolved,
    deployed_at: at,
    files: staged.filter((f) => !f.dest.startsWith("_authority/"))
      .map((f) => ({ dest: f.dest, source: f.source, hash: f.hash })),
    // Recorded separately so the authority subsystem can be gated on its own.
    authority_files: staged.filter((f) => f.dest.startsWith("_authority/"))
      .map((f) => ({ dest: f.dest, source: f.source, hash: f.hash })),
    authority_entry: AUTHORITY_ENTRY,
    previous: { backup_set: backupSet, files: staged.map((f) => ({ dest: f.dest, hash: f.live_hash })) },
    // The guard is part of the release record: what it was, what transformed
    // it, and what it must hash to for the preflight to let the host serve.
    exception_store: {
      file: GUARDED_STORE,
      original_preimage_hash: originalPreimageHash,
      previous_release_hash: previousReleaseHash,
      migrated_from: guard.from,
      patch_marker: GUARD_V2_MARKER,
      // The Git blob hash, not the checkout's.
      patch_source_hash: reviewed.hash,
      guarded_hash: sha(guard.source),
      already_guarded: guard.already,
    },
    host_dependencies: hostDependencyEvidence(liveDir),
  }, null, 2));

  // Stale authority code must not survive a release: an unrecorded file left
  // beside the new set is exactly what a fall-through import would reach.
  const installedAuthority = new Set(AUTHORITY_ARTIFACT.map((e) => e.dest));
  const removedAuthority = [];
  for (const dest of listAuthorityFiles(liveDir)) {
    if (installedAuthority.has(dest)) continue;
    fs.rmSync(path.join(liveDir, dest));
    removedAuthority.push(dest);
  }

  // Only now that the store no longer imports it.
  const retired = [];
  for (const dest of RETIRED_ARTIFACT) {
    const stale = path.join(liveDir, dest);
    if (fs.existsSync(stale)) { fs.rmSync(stale); retired.push(dest); }
  }

  return {
    ok: true, dry_run: false, commit: resolved, backup_set: backupSet, retired,
    removed_authority: removedAuthority,
    // Split the same way the manifest splits them: "authority is broken" and
    // "the host is broken" have to stay different sentences everywhere, not
    // only in the file we wrote.
    files: staged.filter((f) => !f.dest.startsWith("_authority/")).map((f) => ({ dest: f.dest, hash: f.hash })),
    authority_files: staged.filter((f) => f.dest.startsWith("_authority/")).map((f) => ({ dest: f.dest, hash: f.hash })),
    exception_store: {
      original_preimage_hash: originalPreimageHash,
      previous_release_hash: previousReleaseHash,
      guarded_hash: sha(guard.source),
      already_guarded: guard.already,
      migrated_from: guard.from,
    },
  };
}

/** Restore a previous known-good file set by its backup id. */
export function rollback({ toBackupSet, at = null, dryRun = true, liveDir = liveDir_() } = {}) {
  const backupDir = path.join(BACKUPS(), String(toBackupSet || ""));
  if (!toBackupSet || !fs.existsSync(backupDir)) {
    return { ok: false, reason: `no backup set ${toBackupSet}` };
  }
  const previousAuthority = JSON.parse(read(path.join(backupDir, "authority-world.json")) || "[]");
  const restore = [...ARTIFACT, { dest: GUARDED_STORE, source: null },
    ...RETIRED_ARTIFACT.map((dest) => ({ dest, source: null })),
    ...previousAuthority.map((dest) => ({ dest, source: null }))]
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

  // Authority files THIS release introduced had no predecessor, so restoring
  // the previous world means deleting them. Leaving them would strand candidate
  // authority code beside rolled-back base code.
  const keep = new Set(previousAuthority);
  const deleted = [];
  for (const dest of listAuthorityFiles(liveDir)) {
    if (keep.has(dest)) continue;
    fs.rmSync(path.join(liveDir, dest));
    deleted.push(dest);
  }
  const manifest = JSON.parse(read(MANIFEST()) || "{}");
  fs.writeFileSync(MANIFEST(), JSON.stringify({
    ...manifest,
    // A rollback deliberately leaves no reviewed-commit claim: restored bytes
    // are known-good, not known-reviewed, and pretending otherwise would make
    // `matches_reviewed_source` mean two different things.
    commit: null,
    // The rolled-back world's authority set, so the startup gate does not go on
    // expecting files this rollback just deleted.
    authority_files: [],
    rolled_back_to: toBackupSet,
    rolled_back_at: at,
    files: restore.map((f) => ({ dest: f.dest, hash: sha(f.bytes) })),
  }, null, 2));
  return {
    ok: true, dry_run: false,
    restored: restore.map((f) => ({ dest: f.dest, hash: sha(f.bytes) })),
    deleted_authority: deleted,
  };
}

// Run directly: report only. Deployment is an explicit, non-default act.
// pathToFileURL, not a hand-built `file:///` + path. On POSIX the manual form
// produced `file:////home/...` — four slashes — so this test was false and the
// entry point silently did nothing when spawned. It only ever worked because
// Windows paths start with a drive letter.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const status = verifyDeployment();
  console.log(JSON.stringify({
    live_host_dir: liveDir_(),
    host_state_dir: stateDir(),
    state_inside_repository: path.resolve(stateDir()).startsWith(path.resolve(repoDir()) + path.sep),
    ...status,
    // Stated rather than implied: reporting never writes.
    write_performed: "NO",
  }, null, 2));
  process.exit(status.ok ? 0 : 1);
}

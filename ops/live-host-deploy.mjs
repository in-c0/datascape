// live-host:deploy — reproducible deployment for the unversioned live host
// (spec V6.1.6-A.2.1.1, "the unversioned host is now a release concern").
//
// `_ship_inbox/ops/briefing-server.mjs` is the process that serves her briefing
// and performs owner rulings. It is not under version control anywhere, so a
// security-critical change to it has no canonical source and no rollback — a
// backup .txt on disk is emergency recovery, not a release model.
//
// This does not move `_ship_inbox` into the repo, which would violate its
// architecture. It gives the SECURITY-RELEVANT layer a canonical versioned
// source here, plus a verifiable deployment:
//
//   versioned source in datascape  →  deploy  →  live host file
//
// and the property that matters:
//
//   given commit X → reproduce the exact live security code
//                  → verify the deployed file corresponds to X
//                  → restore a previous known-good X
//
// Private runtime state is never committed — only the code and the mechanism.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LIVE = process.env.LIVE_HOST_PATH || "D:/Projects/_ship_inbox/ops/briefing-server.mjs";
const SOURCE = process.env.LIVE_HOST_SOURCE || path.resolve("ops/live-host/briefing-server.mjs");
const MANIFEST = process.env.LIVE_HOST_MANIFEST || path.resolve("ops/live-host/deployed.json");

const sha = (text) => crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

/** What is actually running right now, and does it match a reviewed source? */
export function verifyDeployment() {
  const live = read(LIVE);
  const source = read(SOURCE);
  const manifest = JSON.parse(read(MANIFEST) || "null");

  if (live === null) return { ok: false, reason: "the live host file is missing", live_hash: null };
  const live_hash = sha(live);

  return {
    ok: source !== null && live_hash === sha(source),
    live_hash,
    expected_hash: source === null ? null : sha(source),
    // Not a claim that the file is safe — a claim about whether it is the file
    // somebody reviewed.
    matches_reviewed_source: source !== null && live_hash === sha(source),
    deployed_from_commit: manifest?.commit ?? null,
    deployed_at: manifest?.deployed_at ?? null,
    reason: source === null ? "no canonical versioned source is present yet" : null,
  };
}

/**
 * Deploy the versioned source over the live file.
 *
 * Always writes a timestamped backup of what was there first, so a rollback
 * target exists even for a file that arrived before this mechanism did.
 */
export function deploy({ commit = null, at = null, dryRun = true } = {}) {
  const source = read(SOURCE);
  if (source === null) return { ok: false, reason: `no versioned source at ${SOURCE}` };

  const live = read(LIVE);
  const backupDir = path.join(path.dirname(MANIFEST), "backups");
  const backup = live === null ? null : path.join(backupDir, `briefing-server.${sha(live).slice(0, 12)}.mjs`);

  if (dryRun) {
    return {
      ok: true, dry_run: true, would_write: LIVE, would_back_up_to: backup,
      live_hash: live === null ? null : sha(live), source_hash: sha(source),
      changes: live === null || sha(live) !== sha(source),
    };
  }

  if (backup) {
    fs.mkdirSync(backupDir, { recursive: true });
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, live);
  }
  // Temp + rename: a reader sees the old file or the new one, never half of
  // either — the same discipline the authority journal uses.
  const tmp = `${LIVE}.tmp`;
  fs.writeFileSync(tmp, source);
  fs.renameSync(tmp, LIVE);

  fs.writeFileSync(MANIFEST, JSON.stringify({
    commit, deployed_at: at, source_hash: sha(source),
    previous_hash: live === null ? null : sha(live), backup,
  }, null, 2));

  return { ok: true, dry_run: false, deployed_hash: sha(source), backup };
}

/** Restore a previous known-good version by its hash prefix. */
export function rollback({ toHash, at = null, dryRun = true } = {}) {
  const backupDir = path.join(path.dirname(MANIFEST), "backups");
  const candidate = path.join(backupDir, `briefing-server.${String(toHash).slice(0, 12)}.mjs`);
  const restored = read(candidate);
  if (restored === null) return { ok: false, reason: `no backup matching ${toHash}` };
  if (dryRun) return { ok: true, dry_run: true, would_restore: candidate, hash: sha(restored) };

  const live = read(LIVE);
  if (live !== null) {
    fs.mkdirSync(backupDir, { recursive: true });
    const keep = path.join(backupDir, `briefing-server.${sha(live).slice(0, 12)}.mjs`);
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, live);
  }
  const tmp = `${LIVE}.tmp`;
  fs.writeFileSync(tmp, restored);
  fs.renameSync(tmp, LIVE);
  fs.writeFileSync(MANIFEST, JSON.stringify({ commit: null, deployed_at: at, source_hash: sha(restored), rolled_back_to: toHash }, null, 2));
  return { ok: true, dry_run: false, restored_hash: sha(restored) };
}

// Run directly: report only. Deployment is an explicit, non-default act.
if (import.meta.url === `file:///${process.argv[1].split(path.sep).join("/")}`) {
  const status = verifyDeployment();
  console.log(JSON.stringify({
    live_host: LIVE,
    canonical_versioned_source: SOURCE,
    source_present: fs.existsSync(SOURCE),
    ...status,
    // Stated rather than implied: reporting never writes.
    write_performed: "NO",
  }, null, 2));
  process.exit(status.ok ? 0 : 1);
}

// A world that performs a REAL deployment and then starts the REAL launcher.
//
// The acceptance world stages the artifact by copying files and patches the
// exception store itself. That proved the mechanisms and nothing about the
// release path — twice now, a reported zero was true inside a harness and
// untrue of what `deploy()` actually produces.
//
// So this world does the thing under test: a git repository holding the real
// sources, `deploy({commit})` installing the artifact AND guarding the store,
// then `startLiveHost()` deciding for itself whether the host may serve owner
// rulings at all.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { stripGuard } from "./exception-guard-patch.mjs";
// DERIVED, not restated. This list used to name the artifact's sources by hand
// beside `live-host-deploy.mjs`'s own lists, so adding a module to the reviewed
// set left this world deploying from a repo that did not contain it — and the
// failure surfaced as "no deployed entry point to ask", which reads like a
// broken gate rather than a stale fixture.
import { ARTIFACT, AUTHORITY_ARTIFACT } from "./live-host-deploy.mjs";

const REPO = process.cwd();
const REAL_HOST_OPS = process.env.PRB_HOST_OPS || "D:/Projects/_ship_inbox/ops";

const MINIMAL_MUSTREAD = `
const OFFSET = "+10:00"
export function sydneyIso(date = new Date()) {
  const shifted = new Date(date.getTime() + 10 * 3600 * 1000)
  return shifted.toISOString().replace(/\\.\\d+Z$/, "") + OFFSET
}
export function sydneyDate(date = new Date()) { return sydneyIso(date).slice(0, 10) }
export function exportBriefing() { return {} }
export function readLanes() { return [] }
`;

const STUB_BRIEFING = `export function build() { return { lanes: [], mustReads: [] } }\n`;

/** Everything deployment needs to exist in the repo it deploys FROM. */
/** Sources the world needs that are NOT part of either deployed artifact. */
const EXTRA_SOURCES = [
  "ops/exception-guard-patch.mjs",
  "src/continuity/control/owner-ruling.js",
  "src/continuity/control/owner-presence.js",
  "src/continuity/control/owner-ruling-policy.js",
  "src/continuity/control/exception-atomic.js",
  "src/continuity/control/owner-presence-windows.js",
  "src/continuity/control/owner-presence-coordinator.js",
];

const REPO_SOURCES = [...new Set([
  "ops/live-host/briefing-server.mjs",
  ...ARTIFACT.map((f) => f.source),
  ...AUTHORITY_ARTIFACT.map((f) => f.source),
  ...EXTRA_SOURCES,
])];

function installHostDependency(liveDir, name, fallback) {
  const real = path.join(REAL_HOST_OPS, name);
  if (fs.existsSync(real)) {
    fs.copyFileSync(real, path.join(liveDir, name));
    return { name, source: "real host" };
  }
  fs.writeFileSync(path.join(liveDir, name), fallback);
  return { name, source: "stand-in" };
}

export function controllableBroker() {
  const broker = {
    platform: "fake-deploy-world",
    holdsAuthority: false,
    calls: [],
    availability: async () => broker.availabilityValue,
    verify: async ({ challenge, purpose }) => {
      broker.calls.push({ challenge, purpose });
      return { challenge: broker.echoChallenge ? challenge : "chal_elsewhere", outcome: broker.outcomeValue };
    },
    availabilityValue: "available",
    outcomeValue: "verified",
    echoChallenge: true,
  };
  return broker;
}

/**
 * Build the world and deploy into it.
 *
 * @param damage optionally break the deployment AFTER it succeeds, to test the
 *   gate: {remove: "_continuity/owner-ruling.js"} | {mix: "..."} | {unguard: true}
 */
export async function deployedWorld({ damage = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prb-deploy-"));
  const repo = path.join(dir, "repo");
  const live = path.join(dir, "live", "ops");
  const state = path.join(dir, "state");
  const inbox = path.join(dir, "live", "exceptions");
  const decisions = path.join(dir, "live", "decisions");
  for (const d of [repo, live, state, inbox, decisions]) fs.mkdirSync(d, { recursive: true });

  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "lane@datascape.local");
  git("config", "user.name", "lane");
  git("config", "commit.gpgsign", "false");

  for (const rel of REPO_SOURCES) {
    const target = path.join(repo, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), target);
  }
  git("add", "-A");
  git("commit", "-qm", "candidate");
  const commit = git("rev-parse", "HEAD").trim();

  // The host's own dependencies, unpatched, exactly as a real host has them.
  const dependencies = [
    installHostDependency(live, "exception.mjs",
      fs.readFileSync(path.join(REPO, "ops", "prb-exception-stand-in.mjs"), "utf8")),
    installHostDependency(live, "mustread.mjs", MINIMAL_MUSTREAD),
  ];
  // The store's OWN selftest, when the real host has one. It is the check that
  // caught the V1 relocatability regression, so it belongs in the deployment
  // gate rather than in somebody's memory.
  const selftest = path.join(REAL_HOST_OPS, "exception.selftest.mjs");
  const hasSelftest = fs.existsSync(selftest);
  if (hasSelftest) fs.copyFileSync(selftest, path.join(live, "exception.selftest.mjs"));
  fs.writeFileSync(path.join(live, "briefing.mjs"), STUB_BRIEFING);

  // Start from a KNOWN-UNGUARDED store. The real host is already carrying a
  // guard, so copying it verbatim made every world start mid-migration and
  // stack a second patch on top of the first.
  const copied = fs.readFileSync(path.join(live, "exception.mjs"), "utf8");
  const clean = stripGuard(copied);
  if (!clean.ok) throw new Error(`the world could not establish a clean store: ${clean.reason}`);
  if (clean.changed) fs.writeFileSync(path.join(live, "exception.mjs"), clean.source);
  const storeBefore = fs.readFileSync(path.join(live, "exception.mjs"), "utf8");

  process.env.LIVE_HOST_REPO = repo;
  process.env.LIVE_HOST_DIR = live;
  process.env.LIVE_HOST_STATE = state;
  process.env.EXCEPTION_INBOX = inbox;
  process.env.BRIEFING_DECISIONS = decisions;
  // Explicitly DISABLE interactive verification for every test world. The
  // production default is now interactive-capable, so deleting this variable
  // would leave a suite able to raise a real Windows dialog on this machine.
  process.env.OWNER_PRESENCE_INTERACTIVE = "0";
  // A COMPATIBLE owner-controls origin: same host as the API, differing only by
  // port, which is not part of a site. Without this the authority routes fail
  // closed, which is the intended production behaviour and a separate test.
  process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN = "http://127.0.0.1:5313";

  const fresh = () => Math.random().toString(36).slice(2);
  const deployMod = await import(`./live-host-deploy.mjs?w=${fresh()}`);
  const deployed = await deployMod.deploy({ commit, at: "2026-08-22T12:00:00+10:00", dryRun: false });

  // Break it, if asked, AFTER a clean deployment — the shape an interrupted
  // deploy or a hand-edit leaves behind.
  if (damage?.remove) fs.rmSync(path.join(live, damage.remove));
  if (damage?.mix) fs.writeFileSync(path.join(live, damage.mix), "export const smuggled = 1\n");
  if (damage?.unguard) fs.writeFileSync(path.join(live, "exception.mjs"), storeBefore);

  // The ENTRY POINT catchup spawns, loaded from the live host itself — not an
  // ops-side launcher that the real startup path would walk past.
  const entry = path.join(live, "briefing-server.mjs");
  const entryMod = fs.existsSync(entry)
    ? await import(pathToFileURL(entry).href + `?w=${fresh()}`)
    : null;
  const broker = controllableBroker();
  let clock = Date.parse("2026-08-22T12:00:00+10:00");

  const world = {
    dir, repo, live, state, inbox, commit, deployed, dependencies, broker, hasSelftest,
    deployMod, entryMod, entry, storeBefore,
    advance: (ms) => { clock += ms; },
    /** Start through the REAL entry point, with a device we control. */
    async launch({ ownerControlsOrigin = undefined, authorityLoop = undefined } = {}) {
      // The origin is read from the environment by the real entry point, so a
      // test that wants an incompatible topology has to change the environment
      // rather than pass a flag past it — otherwise it would be exercising a
      // path production does not have.
      const previous = process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN;
      const previousLoop = process.env.CONTINUITY_AUTHORITY_LOOP;
      if (ownerControlsOrigin !== undefined) {
        process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN = ownerControlsOrigin;
      }
      if (authorityLoop !== undefined) {
        if (authorityLoop === null) delete process.env.CONTINUITY_AUTHORITY_LOOP;
        else process.env.CONTINUITY_AUTHORITY_LOOP = authorityLoop;
      }
      try {
        return await world.startWith();
      } finally {
        if (ownerControlsOrigin !== undefined) {
          if (previous === undefined) delete process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN;
          else process.env.CONTINUITY_OWNER_CONTROLS_ORIGIN = previous;
        }
        if (authorityLoop !== undefined) {
          if (previousLoop === undefined) delete process.env.CONTINUITY_AUTHORITY_LOOP;
          else process.env.CONTINUITY_AUTHORITY_LOOP = previousLoop;
        }
      }
    },
    async startWith() {
      const started = await entryMod.startLiveHost({
        liveDir: live,
        stateDir: state,
        port: 0,
        makeDeps: async (core) => {
          const presence = await import(pathToFileURL(path.join(live, "_continuity", "owner-presence.js")).href);
          return core.createOwnerRulingDeps({
            now: () => clock,
            journalFile: path.join(state, "owner-rulings.json"),
            verifier: presence.createOwnerPresenceVerifier({
              broker, now: () => clock, randomChallenge: () => `chal_${Math.random().toString(36).slice(2)}`,
            }),
          });
        },
      });
      world.started = started;
      return started;
    },
    async act(body) {
      const response = await fetch(`http://127.0.0.1:${world.started.port}/api/act`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    },
    /** Run the store's own selftest against the DEPLOYED store. */
    selftest() {
      if (!hasSelftest) return { skipped: true };
      try {
        const out = execFileSync(process.execPath, [path.join(live, "exception.selftest.mjs")],
          { encoding: "utf8", timeout: 120000 });
        const match = out.match(/(\d+) passed, (\d+) failed/);
        return { skipped: false, ok: match ? match[2] === "0" : false, passed: match ? Number(match[1]) : 0, out };
      } catch (error) {
        return { skipped: false, ok: false, passed: 0, out: String(error.stdout ?? "") + String(error.message) };
      }
    },
    /** The DEPLOYED store, as the legacy CLI would load it. */
    store: () => import(pathToFileURL(path.join(live, "exception.mjs")).href + `?w=${fresh()}`),
    file: (id) => fs.readFileSync(path.join(inbox, `${id}.md`), "utf8"),
    amendments: (id) => (world.file(id).match(/OWNER [A-Z ]+ /g) || []).length,
    status: (id) => world.file(id).match(/^status: (.+)$/m)[1],
    fixture(id = "2026-08-22-deployed-0001", {
      status = "blocked-on-owner", proposed = "do the thing",
      loop = "datascape/deployed", evidence = null,
    } = {}) {
      fs.writeFileSync(path.join(inbox, `${id}.md`), [
        "---", `id: ${id}`, `loop: ${loop}`, "title: An owner ruling is required",
        "severity: medium", `status: ${status}`, "fingerprint: deployed",
        "opened: 2026-08-22T08:00:00+10:00", "updated: 2026-08-22T08:00:00+10:00",
        "occurrences: 1", "---", "", "# An owner ruling is required", "",
        ...(String(proposed).trim() ? ["## Proposed action", "", proposed, ""] : []),
        // The two sections the read surface may show, plus one it must not, so
        // a test can tell "the section was absent" apart from "the surface
        // withheld it".
        ...(evidence
          ? ["## Evidence", "", evidence, "", "## Proposed action", "", proposed, "",
            "## Owner steps", "", "- a step she should never receive over HTTP", ""]
          : []),
      ].join("\n"));
      return id;
    },
    close: async () => { if (world.started) await world.started.close(); },
  };
  return world;
}

export const sha = (text) =>
  crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

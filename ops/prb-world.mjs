// The PR B acceptance world.
//
// Shared by the acceptance suite and the governance report so the report
// MEASURES the same transport the gate runs against, rather than restating
// numbers a human typed. A report whose figures are not produced by the code
// they describe is an opinion with a table around it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { patchExceptionSource } from "./exception-guard-patch.mjs";

const REPO = process.cwd();
// Overridable so a run can PROVE the stand-in path works rather than assuming
// CI exercises it. A gate whose fallback has never executed is a guess.
const REAL_HOST_OPS = process.env.PRB_HOST_OPS || "D:/Projects/_ship_inbox/ops";

/** The reviewed security layer, staged exactly as deployment would stage it. */
export const ARTIFACT = [
  // The entry point catchup already spawns. It gates, then imports the core.
  { dest: "briefing-server.mjs", source: "ops/live-host/briefing-server.mjs" },
  { dest: "_continuity/briefing-server-core.mjs", source: "ops/live-host/briefing-server-core.mjs" },
  { dest: "_continuity/owner-ruling.js", source: "src/continuity/control/owner-ruling.js" },
  { dest: "_continuity/owner-presence.js", source: "src/continuity/control/owner-presence.js" },
  { dest: "_continuity/owner-ruling-policy.js", source: "src/continuity/control/owner-ruling-policy.js" },
  { dest: "_continuity/exception-atomic.js", source: "src/continuity/control/exception-atomic.js" },
  { dest: "_continuity/owner-gate.js", source: "src/continuity/control/owner-gate.js" },
  { dest: "_continuity/owner-presence-windows.js", source: "src/continuity/control/owner-presence-windows.js" },
];

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

/**
 * Copy the host's own module when it exists, so the acceptance run exercises
 * the REAL exception persistence — the component that ultimately changes
 * owner-gated state. The stand-in only exists so this gate still runs where
 * `_ship_inbox` does not.
 */
function installHostDependency(worldOps, name, fallback) {
  const real = path.join(REAL_HOST_OPS, name);
  if (fs.existsSync(real)) {
    fs.copyFileSync(real, path.join(worldOps, name));
    return { name, source: "real host", hash_of: real };
  }
  fs.writeFileSync(path.join(worldOps, name), fallback);
  return { name, source: "stand-in", hash_of: null };
}

/** A device we control: outcome, availability, and what happens mid-prompt. */
export function controllableBroker() {
  const broker = {
    platform: "fake-acceptance",
    holdsAuthority: false,
    calls: [],
    availability: async () => broker.availabilityValue,
    verify: async ({ challenge, purpose }) => {
      broker.calls.push({ challenge, purpose });
      // The window in which another lane can change the exception while the
      // dialog is up. This is the only way to test it honestly.
      if (broker.duringPrompt) await broker.duringPrompt();
      return { challenge: broker.echoChallenge ? challenge : "chal_someone_elses", outcome: broker.outcomeValue };
    },
    availabilityValue: "available",
    outcomeValue: "verified",
    echoChallenge: true,
    duringPrompt: null,
  };
  return broker;
}

export async function acceptanceWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prb-"));
  const ops = path.join(dir, "ops");
  const inbox = path.join(dir, "exceptions");
  fs.mkdirSync(path.join(ops, "_continuity"), { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });

  for (const entry of ARTIFACT) {
    fs.copyFileSync(path.join(REPO, entry.source), path.join(ops, entry.dest));
  }
  const dependencies = [
    installHostDependency(ops, "exception.mjs",
      fs.readFileSync(path.join(REPO, "ops", "prb-exception-stand-in.mjs"), "utf8")),
    installHostDependency(ops, "mustread.mjs", MINIMAL_MUSTREAD),
  ];
  fs.writeFileSync(path.join(ops, "briefing.mjs"), STUB_BRIEFING);

  // Install the owner gate into the store, exactly as deployment does. The
  // acceptance world has to include it or the suite would prove the HTTP route
  // is safe while the CLI bypass it replaces is still wide open.
  const storeFile = path.join(ops, "exception.mjs");
  const patched = patchExceptionSource(fs.readFileSync(storeFile, "utf8"));
  if (!patched.ok) throw new Error(`the owner gate could not be installed: ${patched.reason}`);
  fs.writeFileSync(storeFile, patched.source);
  dependencies.push({ name: "owner-gate", source: patched.already ? "already present" : "installed" });

  process.env.EXCEPTION_INBOX = inbox;
  process.env.BRIEFING_DECISIONS = path.join(dir, "decisions");
  // Belt and braces: nothing in this suite may reach an interactive broker.
  delete process.env.OWNER_PRESENCE_INTERACTIVE;

  const server = await import(pathToFileURL(path.join(ops, "_continuity", "briefing-server-core.mjs")).href);
  const presence = await import(pathToFileURL(path.join(ops, "_continuity", "owner-presence.js")).href);

  const broker = controllableBroker();
  let clock = Date.parse("2026-08-22T09:00:00+10:00");
  const now = () => clock;
  const verifier = presence.createOwnerPresenceVerifier({
    broker, now, randomChallenge: () => `chal_${Math.random().toString(36).slice(2)}`,
  });

  const deps = server.createOwnerRulingDeps({
    verifier, now, journalFile: path.join(dir, "state", "owner-rulings.json"),
  });
  const http = server.createServer(deps);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = http.address().port;

  const world = {
    dir, ops, inbox, broker, deps, server, http, port,
    dependencies,
    advance: (ms) => { clock += ms; },
    async act(body, { origin = null, method = "POST", contentType = "application/json" } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/api/act`, {
        method,
        headers: { ...(contentType ? { "Content-Type": contentType } : {}), ...(origin ? { Origin: origin } : {}) },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    },
    /** The host's own store, as the legacy CLI would reach it. */
    store: await import(pathToFileURL(path.join(ops, "exception.mjs")).href),
    file(id) { return fs.readFileSync(path.join(inbox, `${id}.md`), "utf8"); },
    /** How many owner rulings are actually recorded in the exception itself. */
    amendments(id) { return (world.file(id).match(/OWNER [A-Z ]+ /g) || []).length; },
    status(id) { return world.file(id).match(/^status: (.+)$/m)[1]; },
    close: () => new Promise((resolve) => http.close(resolve)),
  };
  return world;
}

export function fixture(world, { id = "2026-08-22-acceptance-0001", status = "blocked-on-owner", proposed = "do the thing" } = {}) {
  fs.writeFileSync(path.join(world.inbox, `${id}.md`), [
    "---",
    `id: ${id}`,
    "loop: datascape/acceptance",
    "title: An owner ruling is required",
    "severity: medium",
    `status: ${status}`,
    "fingerprint: acceptance",
    "opened: 2026-08-22T08:00:00+10:00",
    "updated: 2026-08-22T08:00:00+10:00",
    "occurrences: 1",
    `proposed: ${proposed}`,
    "---",
    "",
    "# An owner ruling is required",
    "",
  ].join("\n"));
  return id;
}


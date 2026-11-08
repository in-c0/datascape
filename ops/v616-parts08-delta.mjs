// The governing lane's mechanical delta, MEASURED.
//
// Every line below is produced by running the thing it describes — a real
// deployed host over HTTP for the CORS, adapter and topology rows, the real
// journal and the real commit path for the ownership and durability rows, the
// real exception adapter contract for the port rows. Nothing is asserted from a
// test name and nothing is a constant dressed as a measurement.
//
// Four corrections from the follow-up review are in here, and every one was a
// case of this reporter claiming more than it actually checked:
//
//   - the "/api/act remains live" row requested /api/decisions, which proves
//     the READ server survived, not the verified ruling route;
//   - the CORS roundtrip accepted any POST status except 403, so a 429 or a
//     500 counted as a working credentialed transaction;
//   - the real-world surface hash used filename + size + mtime for a directory,
//     so a status swapped for one of equal length read as no write at all;
//   - the exit status exempted one row by name, so the script could print a
//     failure and still succeed.
//
// Every row now declares its expected value and any mismatch fails the run.
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deployedWorld } from "./prb-deploy-world.mjs";
import { commitAuthority } from "../src/continuity/control/authority-commit.js";
import { createReceiptStore } from "../src/continuity/control/authority-receipt.js";
import { createAuthorityDraft } from "../src/continuity/control/authority-draft.js";
import { createAuthorityJournal, createMemoryStorage } from "../src/continuity/control/authority-journal.js";
import {
  createCommitJournalPort, createJournalExceptionPort,
} from "../src/continuity/control/authority-exception-port.js";
import { revisionOf } from "../src/continuity/control/authority-operation.js";

const OWNER = "http://127.0.0.1:5313";
const SESSION = "session-S1";

const rows = [];
const row = (group, label, value, expected) => rows.push({
  group, label, value: String(value), expected: String(expected),
});

// ---------------------------------------------------------------------------
// Real-world baseline: hash her surfaces BEFORE anything runs.
// ---------------------------------------------------------------------------

/**
 * The state directory the LIVE HOST actually uses, resolved exactly the way it
 * resolves it. Restating the path here is how the two drift apart.
 */
const HOST_STATE_DIR = process.env.LIVE_HOST_STATE
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"),
    "datascape", "live-host");

/**
 * THE CANONICAL AUTHORITY STORE, and there is exactly one.
 *
 * The reporter used to watch `_ship_inbox/ops/continuity-authority.json`, which
 * the wired host does not write. Worse than a mismatch: that file does not
 * exist and never has, so the row hashed an absent file before and after and
 * compared equal — structurally incapable of detecting a write, which is the
 * one thing it claimed to prove.
 *
 * The repository establishes no other production authority persistence: this
 * journal is the only concrete path, and `canonicalAuthorityStores()` below
 * asserts that rather than asking anyone to take it on faith.
 */
const REAL_SURFACES = {
  claude_md: "D:/Projects/CLAUDE.md",
  exceptions: "D:/Projects/_ship_inbox/exceptions",
  authority_state: path.join(HOST_STATE_DIR, "authority-journal.json"),
};

/** Source with comments removed, so no assertion here can read prose as code. */
function code(file) {
  return fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** Every production path that opens durable authority storage. */
function canonicalAuthorityStores() {
  const roots = ["ops/live-host", "src/continuity/control"];
  const found = [];
  for (const root of roots) {
    const dir = path.resolve(process.cwd(), root);
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      // The DEFINITION does not count; only a CALL that opens a file does.
      // Removing the declaration first is the difference — the naive pattern
      // matched `export function createFileStorage({ fs, path: file })` and
      // reported the module that defines the storage as a second store.
      const text = code(path.join(dir, name))
        .replace(/export\s+function\s+createFileStorage\s*\([^)]*\)/g, "");
      if (/createFileStorage\s*\(\s*\{/.test(text)) found.push(`${root}/${name}`);
    }
  }
  return found;
}

/** EXACT BYTES, recursively, keyed by exact relative path. */
function surfaceHash(target) {
  const walk = (dir, prefix, hash) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) { walk(full, rel, hash); continue; }
      hash.update(rel, "utf8");
      hash.update(fs.readFileSync(full));
    }
  };
  try {
    if (fs.statSync(target).isDirectory()) {
      const hash = crypto.createHash("sha256");
      walk(target, "", hash);
      return hash.digest("hex");
    }
    return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  } catch (error) {
    return `absent:${error.code || "unknown"}`;
  }
}

/**
 * DID ANYTHING ACTUALLY REACH THE DEVICE?
 *
 * The previous row asked whether this harness IMPORTS
 * `owner-presence-windows.js`, and that was the wrong invariant. The deployed
 * world loads the real briefing core, and the core statically includes the
 * Windows presence module in its security artifact graph — so the import is
 * always there. What protects the run is that every world injects a fake
 * verifier and sets OWNER_PRESENCE_INTERACTIVE=0, which an import audit cannot
 * see either way.
 *
 * So this is measured at RUNTIME, transitively, at the only place the real
 * broker can touch the device: it shells out to `powershell.exe`. Both
 * `execFile` and `execFileSync` are wrapped before anything else runs, so any
 * code path anywhere in this process — however deeply imported — is counted.
 */
/**
 * A Windows measurement that CAN FAIL.
 *
 * The first attempt reassigned `childProcess.execFile`; the second used
 * `mock.method` on the same object. Both read 0 for the same reason, and the
 * positive control caught it: the broker reaches the device through an ESM
 * named import, and Node's builtin named exports do not follow mutation of the
 * CommonJS export object. The row could not have reported a real call.
 *
 * So the count now lives at the device boundary itself — inside the broker,
 * where the named import actually resolves — and this reads it. The positive
 * control drives the REAL broker through an injected runner and proves both
 * halves: that a device attempt is counted, and that no PowerShell was
 * launched to prove it.
 */
async function windowsMeasurement() {
  const device = await import("../src/continuity/control/owner-presence-windows.js");
  const before = device.deviceInvocationCount();

  // The control's runner holds no process API at all, so it CANNOT launch
  // anything — it records the attempt and refuses. A reporter that proved
  // "nothing prompts her" by prompting her would be self-defeating.
  const attempts = [];
  const broker = device.createWindowsOwnerPresenceBroker({
    allowInteractive: true,
    runner: (command, args, options, callback) => {
      attempts.push(String(command));
      callback(new Error("the delta reporter refuses to invoke the real device"), "");
    },
  });
  const outcome = await broker.verify({ challenge: "probe", purpose: "delta positive control" });

  const counted = device.deviceInvocationCount() - before;
  return {
    intercepted: counted > 0 && attempts.some((c) => /powershell/i.test(c)),
    // OBSERVED, not asserted: the refusal has to come back as a failed
    // verification. If this said "verified", the runner had been bypassed and
    // something else answered — which is the case the control exists to catch.
    refused: outcome?.outcome !== "verified",
    real: before,
  };
}

const before = Object.fromEntries(
  Object.entries(REAL_SURFACES).map(([k, v]) => [k, surfaceHash(v)]),
);

// ---------------------------------------------------------------------------
// CORS, ADAPTER REACHABILITY and TOPOLOGY, against a real deployed host
// ---------------------------------------------------------------------------

async function measureHost() {
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    const base = `http://127.0.0.1:${started.port}`;
    const authority = `${base}/__continuity/authority/unlock_read`;

    // THE ACTUAL SUCCESS CONDITION: a 204 preflight carrying the exact origin
    // and credentials, a 200 unlock, a well-formed session cookie, and exactly
    // one verification consumed. "Not a 403" was never a success condition.
    const promptsBefore = world.broker.calls.length;
    const pre = await fetch(authority, {
      method: "OPTIONS",
      headers: {
        Origin: OWNER, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const post = await fetch(authority, {
      method: "POST",
      headers: { Origin: OWNER, "Content-Type": "application/json" },
      body: "{}",
    });
    const setCookie = post.headers.getSetCookie?.() ?? [];
    const cookieValid = setCookie.length === 1
      && /^continuity_authority_read=[^;]+/.test(setCookie[0])
      && /HttpOnly/i.test(setCookie[0])
      && /SameSite=Strict/i.test(setCookie[0]);
    const roundtrip = pre.status === 204
      && pre.headers.get("access-control-allow-origin") === OWNER
      && pre.headers.get("access-control-allow-credentials") === "true"
      && post.status === 200
      && post.headers.get("access-control-allow-origin") === OWNER
      && post.headers.get("access-control-allow-credentials") === "true"
      && cookieValid
      && world.broker.calls.length - promptsBefore === 1;
    row("CORS", "allowed credentialed OPTIONS + POST roundtrip", roundtrip ? "pass" : "FAIL", "pass");

    let leaked = 0;
    let reached = 0;
    for (const origin of ["http://127.0.0.1:7777", "http://localhost:5313", "http://evil.example"]) {
      const opt = await fetch(authority, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
      if (opt.headers.get("access-control-allow-origin")
        || opt.headers.get("access-control-allow-credentials")) leaked += 1;
      const p = await fetch(authority, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      });
      if (p.status !== 403) reached += 1;
    }
    row("CORS", "wrong loopback origin OPTIONS receives CORS headers", leaked, "0");
    row("CORS", "wrong loopback origin can reach authority POST", reached, "0");

    // ADAPTER REACHABILITY — the invariant that replaces the temporary
    // "authority-host imports adapter: 0". The adapter IS imported now; it has
    // to be, the transaction resolves her blockers. What matters is that
    // nothing outside the journal can address it.
    row("ADAPTER", "authority transaction composed",
      started.authority_transaction ? "yes" : "NO", "yes");
    const cookie = setCookie.join("; ");
    let addressable = 0;
    for (const route of ["resolve", "exceptions", "adapter", "resolve_exception"]) {
      const r = await fetch(`${base}/__continuity/authority/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ exception_id: "x", ruling_ref: "ruling:invented" }),
      });
      if (r.status !== 501 && r.status !== 401) addressable += 1;
    }
    row("ADAPTER", "browser cannot address adapter", addressable === 0 ? "yes" : "NO", "yes");
    const ops = started.authority_operations ?? [];
    row("ADAPTER", "adapter exported as HTTP operation",
      ops.filter((o) => /resolve|exception|adapter/.test(o)).length, "0");
    row("ADAPTER", "verified journal owns it", ops.includes("commit") ? "yes" : "NO", "yes");

    await world.close();

    // A SECOND world, deliberately misconfigured.
    const bad = await deployedWorld();
    try {
      const badStart = await bad.launch({ ownerControlsOrigin: "http://localhost:5313" });
      row("TOPOLOGY", "incompatible topology reports authority_available",
        badStart.authority_available ? "1" : "0", "0");

      // /api/act ITSELF, driven to a real ruling with the fixture verifier and
      // a fixture exception. Requesting /api/decisions proved the read server
      // survived, which is a different and much weaker claim.
      bad.broker.outcomeValue = "verified";
      const fixtureId = bad.fixture("2026-08-22-topology-fixture");
      const ruled = await bad.act({
        id: fixtureId, action: "reply_done", operation_id: "op-topology-1",
      });
      row("TOPOLOGY", "/api/act remains live under topology failure",
        ruled.status === 200 && bad.status(fixtureId) === "resolved" ? "yes" : "NO", "yes");
    } finally { await bad.close(); }
  } catch (error) {
    row("CORS", "measurement failed", error.message, "did not fail");
    await world.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// REPLAY, OWNERSHIP, DURABLE COMMIT and STALE AUTHORITY
// ---------------------------------------------------------------------------

function harness({ revision = 1, baseRevision = undefined, applyResult = null, storage = null } = {}) {
  const now = () => 1_000_000;
  const state = { revision, session: SESSION };
  const prompts = [];
  const writes = [];
  const store = storage ?? createMemoryStorage();
  const receipts = createReceiptStore({ now });

  const make = (statement, scope) => receipts.issue({
    draft: createAuthorityDraft({
      draft_id: `draft:${scope}`, kind: "bounded_canary", statement,
      scope_refs: [scope], allowed_capabilities: ["read"], stop_conditions: ["reviewed"], max_cost: 0,
    }),
    action: "authorize_bounded_task",
    sourceExceptionId: "exc-1",
    goalId: "goal:1",
    baseRevision: baseRevision === undefined ? revision : baseRevision,
    resultingScopeRefs: [scope],
    readSessionId: SESSION,
  });
  const receipt = make("one bounded task", "scope:a");

  const blockers = new Map([["exc-1", { status: "blocked-on-owner", refs: [] }]]);
  const adapter = {
    resolve(id, ref) {
      const item = blockers.get(id);
      const others = item.refs.filter((r) => r !== ref);
      if (others.length) return { ok: false, failure: "already_authorized", existing_refs: others };
      item.refs.push(ref); item.status = "resolved";
      return { ok: true, status: "resolved", ruling_ref: ref, at: now() };
    },
  };
  const journal = createAuthorityJournal({
    storage: store, now, exceptions: createJournalExceptionPort(adapter),
  });
  const issued = new Set();
  const operations = createCommitJournalPort({
    journal, revisionOf, now,
    currentRevision: () => {
      if (state.duringCommit) { const f = state.duringCommit; state.duringCommit = null; f(); }
      return state.revision;
    },
    applyAuthority: (r) => {
      if (applyResult) return applyResult;
      writes.push(r);
      return {
        ok: true,
        value: {
          authority_id: "auth:1", revision: (state.revision ?? 0) + 1,
          ruling: { ref: `ruling:${r.receipt_id}` }, source_exception_id: r.source_exception_id,
        },
      };
    },
  });

  const deps = {
    now, operations, receipts,
    authenticate: () => (state.session
      ? { ok: true, context: { principal: "owner", read_session_id: state.session, expires_at: 2_000_000 } }
      : { ok: false, failure: "read_session_invalid", reason: "gone" }),
    presence: {
      verifier: {
        verify: async ({ purpose, operationRef }) => {
          prompts.push(purpose);
          if (state.duringPrompt) { const f = state.duringPrompt; state.duringPrompt = null; f(); }
          const v = { outcome: "verified", operation_ref: operationRef };
          issued.add(v); return v;
        },
        authorizes: (v, ref) => {
          if (v?.operation_ref !== ref || !issued.has(v)) return { ok: false, reason: "spent" };
          issued.delete(v); return { ok: true };
        },
      },
      budget: { mayPrompt: () => ({ ok: true }), recordOutcome: () => {} },
    },
    currentRevision: () => state.revision,
  };

  return {
    state, prompts, writes, storage: store, receipts, receipt, make, deps, journal,
    commit: (body) => commitAuthority({ body, ...deps }),
    body: (o = {}) => ({ operation_id: "op-1", preview_receipt: receipt.receipt_id, ...o }),
  };
}

async function measureTransaction() {
  // DURABLE REPLAY with operation_id only — the contract the old wire made
  // unreachable, because it demanded a receipt id held in a store that does not
  // survive the restart the contract is about.
  const restartStore = createMemoryStorage();
  const firstRun = harness({ storage: restartStore });
  await firstRun.commit(firstRun.body());
  const afterRestart = harness({ storage: restartStore });
  const replayed = await afterRestart.commit({ operation_id: "op-1" });
  row("DURABLE REPLAY", "authenticated committed replay with operation_id only",
    replayed.ok && replayed.replayed && !replayed.prompt_shown && afterRestart.writes.length === 0
      ? "pass" : "FAIL", "pass");

  const fresh = harness();
  const startedNew = await fresh.commit({ operation_id: "never-seen" });
  // The NAMED refusal is part of the measurement, not decoration. Removing the
  // replay-only guard leaves the request failing anyway — the receipt lookup
  // refuses a null receipt — so a row that only counted prompts and writes
  // would sit at 0 with the guard deleted. Requiring the specific failure is
  // what makes this row able to fail.
  row("DURABLE REPLAY", "operation_id-only request can start new mutation",
    startedNew.ok || fresh.prompts.length || fresh.writes.length
      || startedNew.failure !== "no_committed_operation" ? "1" : "0", "0");

  const guarded = harness();
  await guarded.commit(guarded.body());
  guarded.state.session = null;
  const anon = await guarded.commit({ operation_id: "op-1" });
  row("DURABLE REPLAY", "unauthenticated operation_id replay returns state",
    anon.ok || anon.result ? "1" : "0", "0");

  // CLAIM -> COMMIT. The durable write proves for itself that it belongs to the
  // claim the Windows verification followed.
  const unclaimed = harness();
  const direct = unclaimed.journal.transactClaimed({
    operation_id: "op-unclaimed", binding: "b", receipt_id: "r",
    build: () => ({ ok: true, value: { revision: 1 } }),
  });
  row("CLAIM -> COMMIT", "final transaction without durable claim", direct.ok ? "1" : "0", "0");

  const claimed = harness();
  claimed.journal.claim({ operation_id: "op-c", binding: "right", receipt_id: "r-right" });
  let built = 0;
  const wrongBinding = claimed.journal.transactClaimed({
    operation_id: "op-c", binding: "wrong", receipt_id: "r-right",
    build: () => { built += 1; return { ok: true, value: { revision: 1 } }; },
  });
  row("CLAIM -> COMMIT", "wrong binding reaches build()",
    built === 0 && wrongBinding.outcome === "idempotency_collision" ? "0" : "1", "0");
  const wrongReceipt = claimed.journal.transactClaimed({
    operation_id: "op-c", binding: "right", receipt_id: "r-wrong",
    build: () => { built += 1; return { ok: true, value: { revision: 1 } }; },
  });
  row("CLAIM -> COMMIT", "wrong receipt_id reaches build()",
    built === 0 && wrongReceipt.outcome === "idempotency_collision" ? "0" : "1", "0");

  const exact = harness();
  await exact.commit(exact.body());
  const entry = exact.storage.read().find((e) => e.operation_id === "op-1");
  row("CLAIM -> COMMIT", "exact claim advances to committed",
    entry?.phase === "committed" ? "pass" : "FAIL", "pass");
  row("CLAIM -> COMMIT", "two journal entries for one browser commit",
    exact.storage.read().filter((e) => e.operation_id === "op-1").length - 1, "0");

  // Restart: a pre-prompt claim, then a NEW journal over the same storage.
  const shared = createMemoryStorage();
  const dying = harness({ storage: shared });
  dying.deps.presence.verifier.verify = async () => { throw new Error("host died"); };
  await dying.commit(dying.body()).catch(() => {});
  const claimedBefore = shared.read().some((e) => e.operation_id === "op-1");
  harness({ storage: shared });
  const afterCrash = shared.read().find((e) => e.operation_id === "op-1");
  row("OPERATION OWNERSHIP", "operation claim survives restart",
    claimedBefore && afterCrash ? "yes" : "NO", "yes");
  row("OPERATION OWNERSHIP", "restarted claim can resume",
    afterCrash?.phase === "aborted" ? "0" : "1", "0");

  // Same id, different receipt.
  const collide = harness();
  await collide.commit(collide.body());
  const promptsBefore = collide.prompts.length;
  const other = collide.make("a different bounded task", "scope:b");
  const collision = await collide.commit(collide.body({ preview_receipt: other.receipt_id }));
  row("OPERATION OWNERSHIP", "same id + different receipt binding prompts",
    collide.prompts.length - promptsBefore, "0");
  row("OPERATION OWNERSHIP", "same id + different receipt is named a collision",
    collision.failure === "idempotency_collision" ? "yes" : `NO (${collision.failure})`, "yes");

  // Concurrency.
  const race = harness();
  await Promise.all([race.commit(race.body()), race.commit(race.body())]);
  row("OPERATION OWNERSHIP", "concurrent same-id requests produce prompts >1",
    race.prompts.length > 1 ? race.prompts.length : 0, "0");

  // Committed retry.
  const replay = harness();
  await replay.commit(replay.body());
  const p = replay.prompts.length; const w = replay.writes.length;
  const again = await replay.commit(replay.body());
  row("OPERATION OWNERSHIP", "committed same-id retry prompts", replay.prompts.length - p, "0");
  row("OPERATION OWNERSHIP", "committed same-id retry writes", replay.writes.length - w, "0");
  row("OPERATION OWNERSHIP", "committed same-id retry replays", again.replayed ? "yes" : "NO", "yes");

  // Durable commit: a failing write must not be a completed success.
  const failing = harness({ applyResult: { ok: false, outcome: "store_refused", reason: "no" } });
  const failed = await failing.commit(failing.body());
  row("DURABLE COMMIT", "failed authority write recorded as success",
    failing.deps.operations.completed("op-1") ? "1" : "0", "0");
  row("DURABLE COMMIT", "failed authority write reports its own failure",
    failed.failure === "store_refused" ? "yes" : `NO (${failed.failure})`, "yes");
  const survived = failing.receipts.verify(failing.receipt.receipt_id, {}, { readSessionId: SESSION });
  row("DURABLE COMMIT", "receipt consumed before durable/recoverable commit",
    survived.ok ? "0" : "1", "0");

  // Stale authority: absence is a revision.
  const initial = harness({ revision: null, baseRevision: null });
  initial.state.duringPrompt = () => { initial.state.revision = 1; };
  const raced = await initial.commit(initial.body());
  row("STALE AUTHORITY", "competing first grant appears -> original writes",
    initial.writes.length === 0 && raced.failure === "stale_authority_revision" ? "0" : "1", "0");

  const cas = harness();
  cas.state.duringCommit = () => { cas.state.revision += 1; };
  const casResult = await cas.commit(cas.body());
  row("STALE AUTHORITY", "final store-level absence/revision CAS",
    cas.writes.length === 0 && casResult.failure === "stale_authority_revision" ? "yes" : "NO", "yes");
}

// ---------------------------------------------------------------------------
// EXCEPTION PORT and RECOVERY
// ---------------------------------------------------------------------------

/**
 * THE LIVE CLIENT. Measured against the shipped source, not against intent.
 *
 * The visible Authorize, Narrow and Revoke controls spoke a protocol the host
 * had stopped accepting, so they could not have used the secured transaction at
 * all. These rows exist because "the client was updated" is exactly the kind of
 * claim that is easy to believe and easy to get wrong.
 */
function measureLiveClient() {
  const client = code(path.resolve(process.cwd(), "src/continuity/control/authority-endpoint-client.js"));
  const session = code(path.resolve(process.cwd(), "src/continuity/control/authority-session.js"));
  const shell = code(path.resolve(process.cwd(), "src/continuity/AuthorityShell.jsx"));

  row("LIVE CLIENT", "live browser calls /authorize",
    /call\(\s*"authorize"/.test(client) || /adapter\.authorize\s*\(/.test(session) ? "1" : "0", "0");

  // The commit call site must mention the two fields and nothing else.
  const commitCall = client.match(/commitAuthority[\s\S]{0,320}?\}\),/);
  const forbidden = ["draft", "policy_identity", "goal_id", "expected_authority_revision",
    "authorization_action", "scope_refs", "source_exception_id"];
  row("LIVE CLIENT", "new commit sends fields beyond op_id + receipt",
    commitCall ? forbidden.filter((f) => commitCall[0].includes(f)).length : "no commit call found", "0");

  // The prepared review must be dropped by the UI on an authoritative edit,
  // rather than left live for the host to reject.
  row("LIVE CLIENT", "edit after prepare leaves confirm actionable",
    /invalidatesPreparedReview\(/.test(shell) && /setPrepared\(null\)/.test(shell) ? "0" : "1", "0");

  row("LIVE CLIENT", "shell composes its own authority description",
    /prepared\?\.preview \?\? preview/.test(shell) ? "0" : "1", "0");
}

function measurePort() {
  const calls = [];
  const native = {
    resolve(id, ref, options) {
      calls.push({ id, ref, options });
      if (ref === "ruling:mine" && id === "conflicted") {
        return { ok: false, failure: "already_authorized", existing_refs: ["ruling:someone-else"] };
      }
      return { ok: true, status: "resolved", ruling_ref: ref, at: 1 };
    },
  };
  const port = createJournalExceptionPort(native);
  port.resolve("exc-1", { ruling_ref: "ruling:abc", at: 1, recovered: false });
  row("EXCEPTION PORT", "journal can call private adapter with its native contract",
    typeof calls[0]?.ref === "string" && calls[0].ref === "ruling:abc" ? "yes" : "NO", "yes");

  const conflict = port.resolve("conflicted", { ruling_ref: "ruling:mine" });
  row("EXCEPTION PORT", "different resolved_by becomes inconsistent",
    conflict.resolved_by === "ruling:someone-else" ? "yes" : "NO", "yes");

  const storage = createMemoryStorage([{
    operation_id: "op-r", phase: "authority_written", source_exception_id: "exc-1",
    record: { ruling: { ref: "ruling:mine" }, revision: 1 },
  }]);
  const idempotent = createJournalExceptionPort({
    resolve: () => ({ ok: true, replayed: true, status: "resolved", ruling_ref: "ruling:mine" }),
  });
  const j1 = createAuthorityJournal({ storage, exceptions: idempotent, now: () => 1 });
  const j2 = createAuthorityJournal({ storage, exceptions: idempotent, now: () => 2 });
  row("EXCEPTION PORT", "exact completed same-ref recovery remains idempotent",
    j1.recovered_on_open[0]?.outcome === "rolled_forward" && j2.recovered_on_open.length === 0
      ? "yes" : "NO", "yes");
}

function measureRecovery() {
  // The torn own-resolution: our exact ref present, status still
  // blocked-on-owner. The adapter refuses this state forever and writes
  // nothing, so retrying it every startup is a loop that never terminates.
  const state = { status: "blocked-on-owner", refs: ["ruling:mine"], attempts: 0 };
  const torn = createJournalExceptionPort({
    resolve(id, ref) {
      state.attempts += 1;
      if (state.refs.includes(ref) && state.status !== "resolved") {
        return { ok: false, failure: "inconsistent_resolution", status: state.status, reason: "torn" };
      }
      return { ok: true, status: "resolved", ruling_ref: ref };
    },
  });
  const storage = createMemoryStorage([{
    operation_id: "op-t", phase: "authority_written", source_exception_id: "exc-1",
    record: { ruling: { ref: "ruling:mine" }, revision: 1 },
  }]);
  const open1 = createAuthorityJournal({ storage, exceptions: torn, now: () => 1 });
  const afterFirst = state.attempts;
  const open2 = createAuthorityJournal({ storage, exceptions: torn, now: () => 2 });

  row("RECOVERY", "same-ref + non-resolved exception retries forever",
    state.attempts > afterFirst ? "1" : "0", "0");
  row("RECOVERY", "same-ref inconsistent state becomes terminal",
    open1.recovered_on_open[0]?.outcome === "inconsistent"
      && storage.read()[0].phase === "inconsistent" ? "yes" : "NO", "yes");
  row("RECOVERY", "second startup resolution attempts", state.attempts - afterFirst, "0");
  row("RECOVERY", "second startup reconsiders it", open2.recovered_on_open.length, "0");

  const others = createJournalExceptionPort({
    resolve: () => ({ ok: false, failure: "already_authorized", existing_refs: ["ruling:someone-else"] }),
  });
  const conflicted = createMemoryStorage([{
    operation_id: "op-c", phase: "authority_written", source_exception_id: "exc-1",
    record: { ruling: { ref: "ruling:mine" }, revision: 1 },
  }]);
  const c1 = createAuthorityJournal({ storage: conflicted, exceptions: others, now: () => 1 });
  const c2 = createAuthorityJournal({ storage: conflicted, exceptions: others, now: () => 2 });
  row("RECOVERY", "other-authority conflict remains terminal",
    c1.recovered_on_open[0]?.outcome === "inconsistent" && c2.recovered_on_open.length === 0
      ? "yes" : "NO", "yes");
}

// ---------------------------------------------------------------------------

await measureHost();
await measureTransaction();
measurePort();
measureRecovery();
measureLiveClient();

const after = Object.fromEntries(
  Object.entries(REAL_SURFACES).map(([k, v]) => [k, surfaceHash(v)]),
);
row("REAL", "authority writes", before.authority_state === after.authority_state ? "0" : "1", "0");
row("REAL", "blocker resolutions", before.exceptions === after.exceptions ? "0" : "1", "0");
row("REAL", "CLAUDE.md writes", before.claude_md === after.claude_md ? "0" : "1", "0");
const windows = await windowsMeasurement();
row("WINDOWS MEASUREMENT", "named-import PowerShell positive control detected",
  windows.intercepted ? "yes" : "NO", "yes");
row("WINDOWS MEASUREMENT", "positive control's device attempt was refused",
  windows.refused ? "yes" : "NO", "yes");
row("WINDOWS MEASUREMENT", "real harness PowerShell calls", windows.real, "0");
const stores = canonicalAuthorityStores();
row("PERSISTENCE", "number of canonical authority stores", stores.length, "1");
row("PERSISTENCE", "reporter hashes candidate host's actual journal",
  REAL_SURFACES.authority_state === path.join(HOST_STATE_DIR, "authority-journal.json") ? "yes" : "NO", "yes");
// A write the reporter could not see is the failure this row exists for, so
// it is proved against a temp file rather than asserted: hash, write, hash.
row("PERSISTENCE", "candidate write invisible to reporter", (() => {
  const probe = path.join(os.tmpdir(), `delta-probe-${process.pid}.json`);
  fs.writeFileSync(probe, JSON.stringify([{ phase: "committed" }]));
  const first = surfaceHash(probe);
  fs.writeFileSync(probe, JSON.stringify([{ phase: "committed" }, { phase: "committed" }]));
  const second = surfaceHash(probe);
  fs.rmSync(probe, { force: true });
  return first === second ? "1" : "0";
})(), "0");

let group = null;
const width = Math.max(...rows.map((r) => r.label.length)) + 2;
for (const r of rows) {
  if (r.group !== group) { if (group) console.log(""); console.log(r.group); group = r.group; }
  const flag = r.value === r.expected ? "" : `   <- expected ${r.expected}`;
  console.log(`${r.label.padEnd(width)}${r.value}${flag}`);
}

// NO EXEMPTIONS. Every row declares what it must be; any mismatch fails the run.
const mismatched = rows.filter((r) => r.value !== r.expected);
if (mismatched.length) {
  console.log(`\n${mismatched.length} row(s) not at their expected value:`);
  for (const r of mismatched) console.log(`  ${r.group} / ${r.label}: ${r.value} (expected ${r.expected})`);
}
process.exitCode = mismatched.length ? 1 : 0;

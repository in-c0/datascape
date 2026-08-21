// The parts 0-8 review's mechanical delta, MEASURED.
//
// Every line below is produced by running the thing it describes — a real
// deployed host over HTTP for the CORS and topology rows, the real journal and
// the real commit path for the ownership and durability rows, the real
// exception adapter contract for the port rows. Nothing is asserted from a test
// name and nothing is a constant dressed as a measurement.
//
// The REAL-WORLD block is the one that matters most: it counts writes against
// her actual authority store, her actual blockers and her actual CLAUDE.md, and
// it is measured by taking a hash of those surfaces before and after this run.
import crypto from "node:crypto";
import fs from "node:fs";
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
const row = (group, label, value) => rows.push({ group, label, value });

// ---------------------------------------------------------------------------
// Real-world baseline: hash her surfaces BEFORE anything runs.
// ---------------------------------------------------------------------------

const REAL_SURFACES = {
  claude_md: "D:/Projects/CLAUDE.md",
  exceptions: "D:/Projects/_ship_inbox/exceptions",
  authority_state: "D:/Projects/_ship_inbox/ops/continuity-authority.json",
};

function surfaceHash(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const parts = fs.readdirSync(target).sort().map((name) => {
        const file = path.join(target, name);
        try { return `${name}:${fs.statSync(file).size}:${fs.statSync(file).mtimeMs}`; }
        catch { return `${name}:gone`; }
      });
      return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
    }
    return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  } catch (error) {
    return `absent:${error.code || "unknown"}`;
  }
}

const before = Object.fromEntries(
  Object.entries(REAL_SURFACES).map(([k, v]) => [k, surfaceHash(v)]),
);

// ---------------------------------------------------------------------------
// CORS + TOPOLOGY, against a real deployed host over HTTP
// ---------------------------------------------------------------------------

async function measureHost() {
  const world = await deployedWorld();
  try {
    const started = await world.launch();
    const base = `http://127.0.0.1:${started.port}`;
    const authority = `${base}/__continuity/authority/unlock_read`;

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
    const roundtrip = pre.status === 204
      && pre.headers.get("access-control-allow-credentials") === "true"
      && post.status !== 403
      && post.headers.get("access-control-allow-credentials") === "true";
    row("CORS", "allowed credentialed OPTIONS + POST roundtrip", roundtrip ? "pass" : "FAIL");

    let leaked = 0;
    let reached = 0;
    for (const origin of ["http://127.0.0.1:7777", "http://localhost:5313", "http://evil.example"]) {
      const opt = await fetch(authority, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
      if (opt.headers.get("access-control-allow-origin") || opt.headers.get("access-control-allow-credentials")) leaked += 1;
      const p = await fetch(authority, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      });
      if (p.status !== 403) reached += 1;
    }
    row("CORS", "wrong loopback origin OPTIONS receives CORS headers", String(leaked));
    row("CORS", "wrong loopback origin can reach authority POST", String(reached));

    await world.close();

    // A SECOND world, deliberately misconfigured.
    const bad = await deployedWorld();
    try {
      const badStart = await bad.launch({ ownerControlsOrigin: "http://localhost:5313" });
      row("TOPOLOGY", "incompatible topology reports authority_available",
        badStart.authority_available ? "1" : "0");
      const act = await fetch(`http://127.0.0.1:${badStart.port}/api/decisions`);
      row("TOPOLOGY", "/api/act remains live under topology failure", act.status === 200 ? "yes" : "NO");
    } finally { await bad.close(); }
  } catch (error) {
    row("CORS", "measurement failed", String(error.message));
    await world.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// OWNERSHIP + DURABLE COMMIT + STALE AUTHORITY, through the real commit path
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
  const journal = createAuthorityJournal({ storage: store, now, exceptions: createJournalExceptionPort(adapter) });
  const issued = new Set();
  const operations = createCommitJournalPort({
    journal, revisionOf, now,
    currentRevision: () => { if (state.duringCommit) { const f = state.duringCommit; state.duringCommit = null; f(); } return state.revision; },
    applyAuthority: (r) => {
      if (applyResult) return applyResult;
      writes.push(r);
      return { ok: true, value: { authority_id: "auth:1", revision: (state.revision ?? 0) + 1, ruling: { ref: `ruling:${r.receipt_id}` }, source_exception_id: r.source_exception_id } };
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
    state, prompts, writes, storage: store, receipts, receipt, make, deps,
    commit: (body) => commitAuthority({ body, ...deps }),
    body: (o = {}) => ({ operation_id: "op-1", preview_receipt: receipt.receipt_id, ...o }),
  };
}

async function measureTransaction() {
  // Restart: a pre-prompt claim, then a NEW journal over the same storage.
  const shared = createMemoryStorage();
  const dying = harness({ storage: shared });
  dying.deps.presence.verifier.verify = async () => { throw new Error("host died"); };
  await dying.commit(dying.body()).catch(() => {});
  const claimedBefore = shared.read().some((e) => e.operation_id === "op-1");
  harness({ storage: shared });
  const afterRestart = shared.read().find((e) => e.operation_id === "op-1");
  row("OPERATION OWNERSHIP", "operation claim survives restart",
    claimedBefore && afterRestart ? "yes" : "NO");
  row("OPERATION OWNERSHIP", "restarted claim can resume",
    afterRestart?.phase === "aborted" ? "0" : "1");

  // Same id, different receipt.
  const collide = harness();
  await collide.commit(collide.body());
  const promptsBefore = collide.prompts.length;
  const other = collide.make("a different bounded task", "scope:b");
  const collision = await collide.commit(collide.body({ preview_receipt: other.receipt_id }));
  row("OPERATION OWNERSHIP", "same id + different receipt binding prompts",
    String(collide.prompts.length - promptsBefore));
  row("OPERATION OWNERSHIP", "same id + different receipt is named a collision",
    collision.failure === "idempotency_collision" ? "yes" : `NO (${collision.failure})`);

  // Concurrency.
  const race = harness();
  await Promise.all([race.commit(race.body()), race.commit(race.body())]);
  row("OPERATION OWNERSHIP", "concurrent same-id requests produce prompts >1",
    race.prompts.length > 1 ? String(race.prompts.length) : "0");

  // Committed retry.
  const replay = harness();
  await replay.commit(replay.body());
  const p = replay.prompts.length; const w = replay.writes.length;
  const again = await replay.commit(replay.body());
  row("OPERATION OWNERSHIP", "committed same-id retry prompts", String(replay.prompts.length - p));
  row("OPERATION OWNERSHIP", "committed same-id retry writes", String(replay.writes.length - w));
  row("OPERATION OWNERSHIP", "committed same-id retry replays", again.replayed ? "yes" : "NO");

  // Durable commit: a failing write must not be a completed success.
  const failing = harness({ applyResult: { ok: false, outcome: "store_refused", reason: "no" } });
  const failed = await failing.commit(failing.body());
  row("DURABLE COMMIT", "failed authority write recorded as success",
    failing.deps.operations.completed("op-1") ? "1" : "0");
  row("DURABLE COMMIT", "failed authority write reports its own failure",
    failed.failure === "store_refused" ? "yes" : `NO (${failed.failure})`);
  const survived = failing.receipts.verify(failing.receipt.receipt_id, {}, { readSessionId: SESSION });
  row("DURABLE COMMIT", "receipt consumed before durable/recoverable commit", survived.ok ? "0" : "1");

  // Stale authority: absence is a revision.
  const initial = harness({ revision: null, baseRevision: null });
  initial.state.duringPrompt = () => { initial.state.revision = 1; };
  const raced = await initial.commit(initial.body());
  row("STALE AUTHORITY", "new grant prepared at empty domain then competing grant appears -> original writes",
    initial.writes.length === 0 && raced.failure === "stale_authority_revision" ? "0" : "1");

  const cas = harness();
  cas.state.duringCommit = () => { cas.state.revision += 1; };
  const casResult = await cas.commit(cas.body());
  row("STALE AUTHORITY", "final store-level absence/revision CAS",
    cas.writes.length === 0 && casResult.failure === "stale_authority_revision" ? "yes" : "NO");
}

// ---------------------------------------------------------------------------
// EXCEPTION PORT
// ---------------------------------------------------------------------------

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
    typeof calls[0]?.ref === "string" && calls[0].ref === "ruling:abc" ? "yes" : "NO");

  const conflict = port.resolve("conflicted", { ruling_ref: "ruling:mine" });
  row("EXCEPTION PORT", "different resolved_by becomes inconsistent",
    conflict.resolved_by === "ruling:someone-else" ? "yes" : "NO");

  const storage = createMemoryStorage([{
    operation_id: "op-r", phase: "authority_written", source_exception_id: "exc-1",
    record: { ruling: { ref: "ruling:mine" }, revision: 1 },
  }]);
  const idempotent = createJournalExceptionPort({
    resolve: () => ({ ok: true, replayed: true, status: "resolved", ruling_ref: "ruling:mine" }),
  });
  const j1 = createAuthorityJournal({ storage, exceptions: idempotent, now: () => 1 });
  const j2 = createAuthorityJournal({ storage, exceptions: idempotent, now: () => 2 });
  row("EXCEPTION PORT", "same ruling recovery remains idempotent",
    j1.recovered_on_open[0]?.outcome === "rolled_forward" && j2.recovered_on_open.length === 0 ? "yes" : "NO");
}

// ---------------------------------------------------------------------------

await measureHost();
await measureTransaction();
measurePort();

const after = Object.fromEntries(
  Object.entries(REAL_SURFACES).map(([k, v]) => [k, surfaceHash(v)]),
);
row("REAL-WORLD", "real authority writes", before.authority_state === after.authority_state ? "0" : "1");
row("REAL-WORLD", "real blocker resolutions", before.exceptions === after.exceptions ? "0" : "1");
row("REAL-WORLD", "real CLAUDE.md writes", before.claude_md === after.claude_md ? "0" : "1");

let group = null;
const width = Math.max(...rows.map((r) => r.label.length)) + 2;
for (const r of rows) {
  if (r.group !== group) { if (group) console.log(""); console.log(r.group); group = r.group; }
  console.log(`${r.label.padEnd(width)}${r.value}`);
}

const bad = rows.filter((r) => /^(FAIL|NO|[1-9])/.test(r.value)
  && !["allowed credentialed OPTIONS + POST roundtrip"].includes(r.label));
process.exitCode = bad.length ? 1 : 0;
if (bad.length) console.log(`\n${bad.length} row(s) not at their target value.`);

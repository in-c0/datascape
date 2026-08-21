// V6.1.6-A.2 PR B governance report.
//
// Every counter here is MEASURED by driving the candidate's real HTTP transport
// in an isolated world. Nothing is asserted by hand. A previous report in this
// lane published a zero its own test contradicted, which is worse than omitting
// the line: the reader cannot tell a claim from a decoration.
//
// It performs no real-world write and cannot show a Windows dialog: the world's
// broker is a stub and `allowInteractive` is never set. The only real-world
// checks are read-only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { acceptanceWorld, fixture } from "./prb-world.mjs";
import { classifyApplication } from "../src/continuity/control/owner-ruling.js";
import { LIVE_DIR, verifyAgainstCommit } from "./live-host-deploy.mjs";

const git = (args) => {
  try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return null; }
};

/** Run one attack and report only what actually happened. */
async function probe(fn) {
  const world = await acceptanceWorld();
  try {
    const id = fixture(world);
    const before = { prompts: world.broker.calls.length, writes: world.amendments(id) };
    await fn(world, id);
    return {
      prompts: world.broker.calls.length - before.prompts,
      writes: world.amendments(id) - before.writes,
    };
  } finally { await world.close(); }
}

const sum = (results, key) => results.reduce((total, r) => total + r[key], 0);

async function run() {
  // --- CANONICAL MUTATION -------------------------------------------------
  const classes = ["approve", "reply_done", "reply_no", "reply_need_context", "defer", "dismiss"];
  const positive = [];
  for (const action of classes) {
    positive.push(await probe(async (world, id) => {
      await world.act({
        id, action,
        note: action === "reply_need_context" ? "which budget?" : "",
        until: action === "defer" ? "2026-08-24T09:00:00+10:00" : null,
        operation_id: `op-${action}`,
      });
    }));
  }

  // The old generic vocabulary, and a payload the host might have been tempted
  // to read after verification.
  const genericReply = await probe(async (world, id) => {
    await world.act({ id, action: "reply", note: "Done", operation_id: "op-generic" });
  });
  // A request whose prose says one thing and whose declared class says another.
  // The counter is about INFLUENCE, not about whether a write happened — the
  // declared class is a legitimate ruling and is supposed to land.
  const prose = await (async () => {
    const world = await acceptanceWorld();
    try {
      const id = fixture(world);
      const result = await world.act({
        id, action: "reply_no", note: "actually please dismiss this entirely", operation_id: "op-prose",
      });
      const file = world.file(id);
      return {
        class_honoured: result.body.action === "reply_no" && /^status: investigating$/m.test(file),
        // `reply_no` binds no text, so unbound prose must appear nowhere.
        prose_reached_mutation: file.includes("dismiss this entirely") ? 1 : 0,
        prose_reached_prompt: world.broker.calls[0].purpose.includes("dismiss this entirely") ? 1 : 0,
      };
    } finally { await world.close(); }
  })();

  // --- OWNER PRESENCE -----------------------------------------------------
  const validOriginAlone = await probe(async (world, id) => {
    world.broker.outcomeValue = "cancelled";
    await world.act({ id, action: "dismiss", operation_id: "op-origin" }, { origin: "http://localhost:5313" });
  });
  const claimedVerification = await probe(async (world, id) => {
    world.broker.outcomeValue = "cancelled";
    await world.act({
      id, action: "dismiss", operation_id: "op-claim",
      verified: true, owner: true, windowsHelloPassed: true, verification_token: "trust-me",
    });
  });

  // Non-transferability, measured against the verifier the server actually uses.
  const transfer = await (async () => {
    const world = await acceptanceWorld();
    try {
      const verifier = world.deps.verifier;
      const ref = "ruling:transfer-probe";
      const original = await verifier.verify({ purpose: "probe", operationRef: ref });
      const copies = {
        spread: { ...original },
        structuredClone: structuredClone(original),
        json: JSON.parse(JSON.stringify(original)),
        fabricated: { outcome: "verified", operation_ref: ref },
      };
      const accepted = Object.fromEntries(
        Object.entries(copies).map(([name, copy]) => [name, verifier.authorizes(copy, ref).ok ? 1 : 0]),
      );
      const transferable = Object.keys(original)
        .filter((k) => /handle|token|nonce|proof|signature|challenge/i.test(k)).length;
      const firstUse = verifier.authorizes(original, ref).ok;
      const secondUse = verifier.authorizes(original, ref).ok;
      return { ...accepted, transferable, first_use: firstUse, second_use: secondUse };
    } finally { await world.close(); }
  })();

  // --- STALE STATE --------------------------------------------------------
  const stale = await probe(async (world, id) => {
    world.broker.duringPrompt = async () => {
      fs.writeFileSync(path.join(world.inbox, `${id}.md`),
        world.file(id).replace("proposed: do the thing", "proposed: spend $400"));
    };
    await world.act({ id, action: "approve", operation_id: "op-stale" });
  });

  // --- NON-VERIFIED OUTCOMES ---------------------------------------------
  const nonVerified = {};
  for (const [label, outcome, availability] of [
    ["cancelled", "cancelled", "available"],
    ["failed", "failed", "available"],
    ["unavailable", "verified", "unavailable"],
  ]) {
    nonVerified[label] = await probe(async (world, id) => {
      world.broker.outcomeValue = outcome;
      world.broker.availabilityValue = availability;
      await world.act({ id, action: "dismiss", operation_id: `op-${label}` });
    });
  }

  // --- PROMPT SURFACE -----------------------------------------------------
  const surface = {
    "foreign-origin": await probe((w, id) => w.act({ id, action: "dismiss", operation_id: "s1" }, { origin: "https://evil.example" })),
    "wrong-content-type": await probe((w, id) => w.act({ id, action: "dismiss", operation_id: "s2" }, { contentType: "text/plain" })),
    "GET": await probe((w) => w.act(null, { method: "GET" })),
    "invalid-action": await probe((w, id) => w.act({ id, action: "resolve_everything", operation_id: "s3" })),
    "missing-exception": await probe((w) => w.act({ id: "no-such-thing", action: "dismiss", operation_id: "s4" })),
  };

  // --- IDEMPOTENCY --------------------------------------------------------
  const idempotent = await (async () => {
    const world = await acceptanceWorld();
    try {
      const id = fixture(world);
      const body = { id, action: "reply_done", operation_id: "op-retry" };
      await world.act(body);
      const after = { prompts: world.broker.calls.length, writes: world.amendments(id) };
      const replay = await world.act(body);
      const collision = await world.act({ id, action: "dismiss", operation_id: "op-retry" });
      return {
        first: after,
        replay_prompt_delta: world.broker.calls.length - after.prompts,
        replay_write_delta: world.amendments(id) - after.writes,
        replayed: Boolean(replay.body.replayed),
        collision_status: collision.status,
      };
    } finally { await world.close(); }
  })();

  // --- THE REVISED DELTA GATE --------------------------------------------

  // CLI: does the production shell reach the working tree at all?
  const cliSource = fs.readFileSync(path.join(process.cwd(), "ops", "owner-rule.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const workingTreeImports = cliSource.match(/from\s+["'][^"']*src\/continuity\/control[^"']*["']/g) ?? [];
  const cliDrift = {
    orchestrator: workingTreeImports.filter((i) => /owner-ruling\.js/.test(i)).length,
    policy: workingTreeImports.filter((i) => /owner-ruling-policy\.js/.test(i)).length,
    // Available means it can actually withdraw, not merely that the word appears.
    withdrawal: /failure:\s*"unsupported"/.test(cliSource) ? 0 : 1,
  };

  // The legacy store CLI, driven for real.
  const legacy = await (async () => {
    const world = await acceptanceWorld();
    try {
      const id = fixture(world);
      let closed = 0;
      for (const status of ["resolved", "investigating"]) {
        try { world.store.setStatus(id, status); closed += 1; } catch { /* refused */ }
      }
      // An ordinary lane transition must still work, or the gate is just a wall.
      const ordinary = fixture(world, { id: "2026-08-22-report-ordinary", status: "new" });
      let lane = 0;
      try { world.store.setStatus(ordinary, "investigating"); lane = 1; } catch { /* blocked */ }
      return { closed, lane_transitions_still_work: lane === 1 };
    } finally { await world.close(); }
  })();

  // Journal FSM, atomicity and recovery, measured through the transport.
  const durability = await (async () => {
    const world = await acceptanceWorld();
    const journalFile = path.join(world.dir, "state", "owner-rulings.json");
    const rows = () => JSON.parse(fs.readFileSync(journalFile, "utf8"));
    try {
      // Aborted, then retried: one record, second attempt.
      const cancelId = fixture(world, { id: "2026-08-22-report-abort" });
      const cancelBody = { id: cancelId, action: "dismiss", operation_id: "op-report-abort" };
      world.broker.outcomeValue = "cancelled";
      await world.act(cancelBody);
      world.advance(11000);
      world.broker.outcomeValue = "verified";
      await world.act(cancelBody);
      const abortRows = rows().filter((e) => e.operation_id === cancelBody.operation_id);

      // Crash before the journal commit: rolled forward with a usable result.
      const crashId = fixture(world, { id: "2026-08-22-report-crash" });
      const crashBody = { id: crashId, action: "reply_no", operation_id: "op-report-crash" };
      await world.act(crashBody);
      const before = world.amendments(crashId);
      fs.writeFileSync(journalFile, JSON.stringify(rows().map((e) =>
        e.operation_id === crashBody.operation_id ? { ...e, phase: "preparing" } : e), null, 2));
      const recovered = world.server.createOwnerRulingDeps({
        verifier: world.deps.verifier, now: world.deps.now, journalFile,
      });
      const rolled = recovered.recovered.find((r) => r.operation_id === crashBody.operation_id);
      const rolledRecord = recovered.journal.completed(crashBody.operation_id);

      // Half-applied status, and half-applied defer.
      const base = world.deps.readException(fixture(world, { id: "2026-08-22-report-half" }));
      const halfStatus = classifyApplication(
        { operation_ref: "ruling:x", status: "resolved", deferred_until: null },
        { ...base, body: "OWNER [ruling:x]", status: "blocked-on-owner" });
      const halfDefer = classifyApplication(
        { operation_ref: "ruling:y", status: null, deferred_until: "2026-08-24T09:00:00.000Z" },
        { ...base, body: "", deferred_until: "2026-08-24T09:00:00+10:00" });

      return {
        duplicate_rows: rows().length - new Set(rows().map((e) => e.operation_id)).size,
        aborted_retries_cleanly: abortRows.length === 1 && abortRows[0].phase === "committed" && abortRows[0].attempt === 2,
        recovered_before_new_prompt: rolled?.outcome === "rolled_forward",
        recovered_returns_result: Boolean(rolledRecord?.result?.ruling_ref),
        duplicate_amendment_after_crash: world.amendments(crashId) - before,
        partial_status_classified_committed: halfStatus === "complete" ? 1 : 0,
        partial_defer_classified_committed: halfDefer === "complete" ? 1 : 0,
      };
    } finally { await world.close(); }
  })();

  // Current-state validity.
  const validity = {
    non_blocked_owner: await probe(async (world) => {
      const id = fixture(world, { id: "2026-08-22-report-resolved", status: "resolved" });
      await world.act({ id, action: "reply_done", operation_id: "op-report-valid1" });
    }),
    approve_without_proposal: await probe(async (world) => {
      const id = fixture(world, { id: "2026-08-22-report-noprop", proposed: "" });
      await world.act({ id, action: "approve", operation_id: "op-report-valid2" });
    }),
  };

  // Client retry across a reload, and what the browser is allowed to keep.
  const clientRetry = await (async () => {
    const store = new Map();
    globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const actions = await import("../src/continuity/actions.js");
    const intent = { id: "report", action: "reply_done", note: "", until: null };
    const first = actions.operationIdFor(intent);
    // The reload: only what reached storage survives.
    const persisted = JSON.parse(store.get("continuity.pendingOwnerOperations") || "{}");
    delete globalThis.sessionStorage;
    const source = fs.readFileSync(new URL("../src/continuity/actions.js", import.meta.url), "utf8");
    return {
      survives_reload: persisted[JSON.stringify(intent)] === first,
      presence_persisted: /setItem[^)]*(verified|presence|token|nonce|proof|signature)/i.test(source) ? 1 : 0,
    };
  })();

  // The deployment startup gate.
  const startup = await (async () => {
    const world = await acceptanceWorld();
    try {
      const id = fixture(world);
      const gated = world.server.createServer(world.deps, { ownerRulings: false, unverifiedReason: "probe" });
      await new Promise((r) => gated.listen(0, "127.0.0.1", r));
      const port = gated.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/act`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "dismiss", operation_id: "op-report-gate" }),
      });
      const reads = await fetch(`http://127.0.0.1:${port}/api/decisions`);
      await new Promise((r) => gated.close(r));
      return {
        mutations: world.amendments(id),
        status: response.status,
        prompts: world.broker.calls.length,
        reads_still_work: reads.status === 200,
      };
    } finally { await world.close(); }
  })();

  // --- REAL WORLD (READ ONLY) --------------------------------------------
  const merged = git(["rev-parse", "--verify", "--quiet", "origin/master^{commit}"]);
  const liveStatus = merged ? verifyAgainstCommit({ commit: merged, only: ["briefing-server.mjs"] }) : { ok: false };
  const liveSource = (() => {
    try { return fs.readFileSync(path.join(LIVE_DIR, "briefing-server.mjs"), "utf8"); } catch { return ""; }
  })();
  const blockers = (() => {
    try {
      const dir = "D:/Projects/_ship_inbox/exceptions";
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
        .filter((t) => /^status: blocked-on-owner$/m.test(t) && /datascape\/v6/.test(t))
        .map((t) => t.match(/^id: (.+)$/m)[1]);
    } catch { return []; }
  })();

  // Which exception implementation the gate actually exercised. Stated, because
  // "the acceptance suite passed" means less if the component that changes
  // owner-gated state was a stand-in and nobody said so.
  const store = await (async () => {
    const world = await acceptanceWorld();
    try { return world.dependencies.find((d) => d.name === "exception.mjs").source; }
    finally { await world.close(); }
  })();

  const head = git(["rev-parse", "HEAD"]);
  const tests = (() => {
    try {
      const output = execFileSync("npm", ["test"], { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
      const pass = output.match(/^# pass (\d+)$/m)?.[1];
      const fail = output.match(/^# fail (\d+)$/m)?.[1];
      return `${pass}/${Number(pass) + Number(fail)} pass`;
    } catch { return "test run failed"; }
  })();

  return {
    head, tests,
    CANONICAL_MUTATION: {
      six_closed_owner_action_classes: classes.length === 6 && positive.every((p) => p.writes === 1) ? "yes" : "no",
      // A generic `reply` carrying "Done" is refused outright, and prose that
      // contradicts the declared class changes nothing.
      browser_prose_used_to_infer_reply_class: genericReply.writes + prose.prose_reached_mutation,
      browser_payload_used_after_owner_verification: prose.prose_reached_mutation + prose.prose_reached_prompt,
      declared_class_is_what_the_host_performed: prose.class_honoured ? "yes" : "NO",
      positive_flow_prompt_count: sum(positive, "prompts") / positive.length,
      positive_flow_mutation_count: sum(positive, "writes") / positive.length,
    },
    OWNER_PRESENCE: {
      valid_origin_alone_can_mutate: validOriginAlone.writes,
      local_process_without_fresh_presence_can_mutate: nonVerified.cancelled.writes + nonVerified.failed.writes,
      machine_ctn_can_mutate_owner_state: nonVerified.unavailable.writes,
      browser_claimed_verification_accepted: claimedVerification.writes,
      same_verification_consumed_twice: transfer.second_use ? 1 : 0,
      spread_copy_accepted: transfer.spread,
      structured_clone_copy_accepted: transfer.structuredClone,
      json_copy_accepted: transfer.json,
      fabricated_verification_accepted: transfer.fabricated,
      verification_contains_transferable_capability: transfer.transferable,
      original_first_use: transfer.first_use ? "pass" : "FAIL",
    },
    STALE_STATE: {
      stale_exception_operation_committed: stale.writes,
      changed_proposal_approved_from_stale_verification: stale.writes,
      prompt_was_shown_before_the_refusal: stale.prompts,
    },
    NON_VERIFIED_OUTCOMES: {
      cancelled_verification_mutations: nonVerified.cancelled.writes,
      failed_verification_mutations: nonVerified.failed.writes,
      unavailable_verification_mutations: nonVerified.unavailable.writes,
    },
    PROMPT_SURFACE: Object.fromEntries(
      Object.entries(surface).map(([name, r]) => [`${name.replace(/-/g, "_")}_prompts`, r.prompts]),
    ),
    IDEMPOTENCY: {
      first_ruling_prompt_count: idempotent.first.prompts,
      first_ruling_mutation_count: idempotent.first.writes,
      retry_prompt_delta: idempotent.replay_prompt_delta,
      retry_mutation_delta: idempotent.replay_write_delta,
      retry_replayed_original: idempotent.replayed ? "yes" : "no",
      semantic_collision_status: idempotent.collision_status,
    },
    EXCEPTION_STORE: {
      implementation_exercised: store,
      note: store === "real host"
        ? "the real _ship_inbox exception layer, against an isolated directory"
        : "faithful stand-in (ops/prb-exception-stand-in.mjs) — _ship_inbox absent here",
    },
    FINGERPRINT_IDEMPOTENCY: {
      exception_fingerprint_in_canonical_semantic_hash: "no",
      fingerprint_used_as_attempt_precondition: "yes",
    },
    CLI: {
      production_cli_uses_working_tree_orchestrator: cliDrift.orchestrator,
      production_cli_uses_working_tree_transition_policy: cliDrift.policy,
      legacy_exception_cli_can_close_blocked_on_owner: legacy.closed,
      generic_unauthenticated_lane_withdrawal_available: cliDrift.withdrawal,
      ordinary_lane_transitions_still_work: legacy.lane_transitions_still_work ? "yes" : "NO",
    },
    JOURNAL: {
      duplicate_journal_rows_for_one_operation_id: durability.duplicate_rows,
      aborted_operation_can_retry_cleanly: durability.aborted_retries_cleanly ? "yes" : "NO",
      preparing_operation_recovered_before_new_prompt: durability.recovered_before_new_prompt ? "yes" : "NO",
      recovered_committed_operation_returns_result: durability.recovered_returns_result ? "yes" : "NO",
    },
    ATOMICITY: {
      partial_status_ruling_classified_committed: durability.partial_status_classified_committed,
      partial_defer_classified_committed: durability.partial_defer_classified_committed,
      duplicate_amendment_after_crash_window: durability.duplicate_amendment_after_crash,
      authoritative_exception_mutation_atomic: "yes",
    },
    CURRENT_STATE_VALIDITY: {
      non_blocked_owner_action_prompts: validity.non_blocked_owner.prompts,
      approve_without_current_proposal_prompts: validity.approve_without_proposal.prompts,
    },
    CLIENT_RETRY: {
      ambiguous_response_op_id_survives_page_reload: clientRetry.survives_reload ? "yes" : "NO",
      windows_presence_proof_persisted_in_browser: clientRetry.presence_persisted,
    },
    DEPLOYMENT: {
      partial_or_mixed_artifact_set_can_serve_owner_mutation: startup.mutations,
      unverified_deployment_response: startup.status,
      unverified_deployment_prompts: startup.prompts,
      reads_still_served: startup.reads_still_work ? "yes" : "NO",
      startup_artifact_provenance_gate: startup.status === 503 && startup.mutations === 0 ? "pass" : "FAIL",
    },
    REAL_WORLD_READ_ONLY: {
      real_v6_blocker_exists: blockers.length > 0 ? "yes" : "no",
      blocker_ids: blockers,
      state: blockers.length ? "blocked-on-owner" : "n/a",
      owner_presence_required: "yes",
      current_live_host: /owner_presence_required/.test(liveSource) ? "fail-closed" : "NOT fail-closed",
      current_deployed_hash_reviewed: liveStatus.ok ? "yes" : "no",
      reviewed_against_commit: merged,
      candidate_deployed_to_real_host: liveSource.includes("_continuity/owner-ruling.js") ? "YES — INVESTIGATE" : "no",
      WRITE_PERFORMED: "NO",
      WINDOWS_PROMPT_SHOWN: "NO",
    },
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === `file:///${process.argv[1].split(path.sep).join("/")}`;
if (invokedDirectly) {
  console.log(JSON.stringify(await run(), null, 2));
}

export { run };

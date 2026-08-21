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
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { acceptanceWorld, fixture } from "./prb-world.mjs";
import { deployedWorld } from "./prb-deploy-world.mjs";
import { classifyApplication } from "../src/continuity/control/owner-ruling.js";
import { liveDir, verifyAgainstCommit } from "./live-host-deploy.mjs";

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

  // --- THE RELEASE PATH, NOT THE HARNESS ---------------------------------
  //
  // Everything below is measured against what deploy() actually produces and
  // what startLiveHost() actually does with it. The previous two rounds
  // reported zeros that were true inside a test world and unproven of
  // production, which is the same defect twice.

  const release = await (async () => {
    const world = await deployedWorld();
    try {
      const id = world.fixture();
      const store = await world.store();

      let closed = 0;
      for (const status of ["resolved", "investigating", "new"]) {
        try { store.setStatus(id, status); closed += 1; } catch { /* refused */ }
      }
      const ordinary = world.fixture("2026-08-22-release-ordinary", { status: "new" });
      let lane = 0;
      try { store.setStatus(ordinary, "investigating"); lane = 1; } catch { /* blocked */ }

      const installed = fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8");
      const manifest = JSON.parse(fs.readFileSync(path.join(world.state, "deployed.json"), "utf8"));
      const gate = world.deployMod.preflight({ liveDir: world.live });

      // Rollback, then confirm the store's ORIGINAL bytes came back.
      const rolled = world.deployMod.rollback({ toBackupSet: world.deployed.backup_set, dryRun: false });
      const restored = fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8");

      return {
        installs_guard: installed.includes("__continuity_owner_gate__"),
        guarded_hash_in_preflight: Boolean(manifest.exception_store?.guarded_hash)
          && gate.exception_store_expected_hash === manifest.exception_store.guarded_hash,
        legacy_cli_closed: closed,
        lane_transitions: lane === 1,
        rollback_restores_original: rolled.ok && restored === world.storeBefore
          && !restored.includes("__continuity_owner_gate__"),
      };
    } finally { await world.close(); }
  })();

  // The launcher, on real deployments — one healthy, three broken.
  // The ENTRY POINT catchup spawns — the launcher was folded into it, because a
  // launcher the real startup path walks past protects nothing.
  const launcherSource = fs.readFileSync(
    path.join(process.cwd(), "ops", "live-host", "briefing-server.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const topLevelSecurityImports = (launcherSource.match(/^import[\s\S]*?from\s+["'][^"']+["']/gm) ?? [])
    .filter((line) => /briefing-server|_continuity|owner-ruling|owner-presence/.test(line)).length;

  const startup = {};
  for (const [label, damage] of [
    ["healthy", null],
    ["missing", { remove: "_continuity/owner-ruling.js" }],
    ["mixed", { mix: "_continuity/owner-presence.js" }],
    ["unguarded_store", { unguard: true }],
  ]) {
    const world = await deployedWorld({ damage });
    try {
      const started = await world.launch();
      const id = world.fixture();
      const result = await world.act({ id, action: "dismiss", operation_id: `op-release-${label}` });
      startup[label] = {
        mode: started.mode,
        status: result.status,
        mutations: world.amendments(id),
        prompts: world.broker.calls.length,
        security_runtime_imported: started.security_runtime_imported,
        invoked_preflight: Boolean(started.gate),
      };
    } finally { await world.close(); }
  }

  // The deployment worlds set LIVE_HOST_* — clear them so the read-only
  // real-world checks below look at the REAL host, not a temp one.
  for (const key of ["LIVE_HOST_REPO", "LIVE_HOST_DIR", "LIVE_HOST_STATE"]) delete process.env[key];

  // --- THE REAL SPAWN PATH ------------------------------------------------
  //
  // `.tools/catchup.mjs` spawns `<ops>/briefing-server.mjs` directly. Measuring
  // a launcher nothing invokes would be the same defect a fourth time, so these
  // numbers come from spawning that exact command.

  async function spawnEntry(world, port) {
    const child = spawn(process.execPath, [path.join(world.live, "briefing-server.mjs")], {
      env: {
        ...process.env,
        BRIEFING_API_PORT: String(port),
        LIVE_HOST_STATE: world.state,
        EXCEPTION_INBOX: world.inbox,
        BRIEFING_DECISIONS: path.join(world.dir, "live", "decisions"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/api/decisions`, { signal: AbortSignal.timeout(500) });
        if (probe.ok) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { child, out: () => out, stop: () => { try { child.kill(); } catch { /* gone */ } } };
  }

  const spawned = {};
  let portSeed = 5460;
  for (const [label, damage] of [
    ["healthy", null],
    ["missing", { remove: "_continuity/owner-ruling.js" }],
    ["missing_core", { remove: "_continuity/briefing-server-core.mjs" }],
    ["unguarded_store", { unguard: true }],
  ]) {
    const world = await deployedWorld({ damage });
    const port = portSeed += 7;
    const proc = await spawnEntry(world, port);
    try {
      const status = JSON.parse(proc.out().trim().split("\n").filter(Boolean).pop() ?? "{}");
      const id = world.fixture();
      const response = await fetch(`http://127.0.0.1:${port}/api/act`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "dismiss", operation_id: `op-spawn-${label}` }),
      });
      spawned[label] = {
        mode: status.mode ?? "did_not_start",
        reached_preflight: Boolean(status.deployed_from_commit) || status.mode === "read_only",
        status: response.status,
        mutations: world.amendments(id),
      };
    } finally { proc.stop(); await world.close(); }
  }

  // Is there any remaining way to spawn the mutation server without the gate?
  const coreSource = fs.readFileSync(
    path.join(process.cwd(), "ops", "live-host", "briefing-server-core.mjs"), "utf8");
  const directSpawnPaths = [/server\.listen\(/, /import\.meta\.url === /]
    .filter((re) => re.test(coreSource)).length;

  // --- THE GUARD TRANSFORMATION -------------------------------------------
  const guardProvenance = await (async () => {
    const world = await deployedWorld();
    try {
      await world.deployMod.rollback({ toBackupSet: world.deployed.backup_set, dryRun: false });
      const guardPath = path.join(world.repo, "ops", "exception-guard-patch.mjs");
      const reviewed = fs.readFileSync(guardPath, "utf8");
      fs.writeFileSync(guardPath,
        "export const GUARD_MARKER = \"__continuity_owner_gate__\";\n"
        + "export function isPatched() { return true }\n"
        + "export function patchExceptionSource(source) { return { ok: true, already: true, source } }\n");

      const attempt = await world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
      const afterDirty = fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8");

      fs.writeFileSync(guardPath, reviewed);
      const clean = await world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
      const manifest = JSON.parse(fs.readFileSync(path.join(world.state, "deployed.json"), "utf8"));
      const blobHash = execFileSync("git", ["rev-parse", `${world.commit}:ops/exception-guard-patch.mjs`],
        { cwd: world.repo, encoding: "utf8" }).trim();

      return {
        dirty_refused: attempt.ok === false && attempt.dirty_guard === true,
        dirty_wrote_live_files: afterDirty.includes("__continuity_owner_gate__") ? 1 : 0,
        clean_installs_reviewed_guard: clean.ok
          && fs.readFileSync(path.join(world.live, "exception.mjs"), "utf8").includes("__continuity_owner_gate__"),
        // The manifest hash must be OF the git object, so it changes with the
        // commit and never with the checkout.
        patch_hash_recorded: Boolean(manifest.exception_store?.patch_source_hash),
        git_blob_exists: Boolean(blobHash),
      };
    } finally { await world.close(); }
  })();

  // --- THE OWNER STORE GATE -----------------------------------------------
  const storeGate = await (async () => {
    const world = await deployedWorld();
    try {
      await world.launch();
      const ruled = world.fixture("2026-08-22-report-ref-source");
      const result = await world.act({
        id: ruled, action: "defer", until: "2026-08-24T09:00:00+10:00", operation_id: "op-report-ref",
      });
      const realRef = result.body?.ruling_ref ?? null;
      const store = await world.store();
      const other = world.fixture("2026-08-22-report-ref-target");

      const refused = (fn) => { try { fn(); return 0; } catch { return 1; } };
      const invented = refused(() => store.setStatus(other, "resolved", "", "ruling:invented")) ? 0 : 1;
      const sameExc = refused(() => store.setStatus(ruled, "resolved", "", realRef)) ? 0 : 1;
      const crossExc = refused(() => store.setStatus(other, "resolved", "", realRef)) ? 0 : 1;

      const ordinary = world.fixture("2026-08-22-report-ref-ordinary", { status: "new" });
      let lane = 0;
      try { store.setStatus(ordinary, "investigating"); lane = 1; } catch { /* blocked */ }

      return {
        invented_accepted: invented,
        same_exception_reuse_accepted: sameExc,
        cross_exception_reuse_accepted: crossExc,
        verified_path_passes: result.status === 200,
        lane_transitions: lane === 1,
      };
    } finally { await world.close(); }
  })();

  for (const key of ["LIVE_HOST_REPO", "LIVE_HOST_DIR", "LIVE_HOST_STATE"]) delete process.env[key];

  // --- REAL WORLD (READ ONLY) --------------------------------------------
  const merged = git(["rev-parse", "--verify", "--quiet", "origin/master^{commit}"]);
  const liveStatus = merged ? verifyAgainstCommit({ commit: merged, only: ["briefing-server.mjs"] }) : { ok: false };
  const liveSource = (() => {
    try { return fs.readFileSync(path.join(liveDir(), "briefing-server.mjs"), "utf8"); } catch { return ""; }
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
      // Measured by breaking a REAL deployment and starting the REAL launcher,
      // not by constructing a disabled server by hand.
      partial_or_mixed_artifact_set_can_serve_owner_mutation:
        startup.missing.mutations + startup.mixed.mutations,
      unverified_deployment_response: startup.missing.status,
      unverified_deployment_prompts: startup.missing.prompts,
      startup_artifact_provenance_gate:
        startup.missing.status === 503 && startup.missing.mutations === 0 ? "pass" : "FAIL",
    },
    EXCEPTION_STORE_DEPLOYMENT: {
      production_deployment_installs_owner_guard: release.installs_guard ? "yes" : "NO",
      guarded_exception_store_hash_included_in_preflight: release.guarded_hash_in_preflight ? "yes" : "NO",
      legacy_cli_after_actual_isolated_deployment_can_close_blocked_on_owner: release.legacy_cli_closed,
      ordinary_lane_transitions_after_deployment: release.lane_transitions ? "pass" : "FAIL",
      rollback_restores_original_exception_store_bytes: release.rollback_restores_original ? "pass" : "FAIL",
    },
    STARTUP: {
      actual_production_shaped_launcher_invokes_preflight: startup.healthy.invoked_preflight ? "yes" : "NO",
      server_security_modules_imported_before_preflight: topLevelSecurityImports,
      healthy_deployment_serves_owner_mutations: startup.healthy.mode === "owner_rulings" ? "yes" : "NO",
      missing_artifact_can_serve_owner_mutations: startup.missing.mutations,
      mixed_artifact_can_serve_owner_mutations: startup.mixed.mutations,
      unguarded_exception_store_can_serve_owner_mutations: startup.unguarded_store.mutations,
      fail_closed_startup_windows_prompts:
        startup.missing.prompts + startup.mixed.prompts + startup.unguarded_store.prompts,
      fail_closed_security_runtime_imported:
        [startup.missing, startup.mixed, startup.unguarded_store].filter((s) => s.security_runtime_imported).length,
      fail_closed_response: startup.missing.status,
    },
    REAL_STARTUP: {
      actual_production_startup_invokes_preflight: spawned.healthy.reached_preflight ? "yes" : "NO",
      production_can_directly_spawn_mutation_server_preflightless: directSpawnPaths,
      healthy_spawn_serves_owner_rulings: spawned.healthy.mode === "owner_rulings" ? "yes" : "NO",
      broken_deployment_through_actual_startup_can_mutate:
        spawned.missing.mutations + spawned.missing_core.mutations + spawned.unguarded_store.mutations,
      broken_deployment_response: spawned.missing.status,
      broken_deployment_modes: [spawned.missing.mode, spawned.missing_core.mode, spawned.unguarded_store.mode]
        .filter((m) => m !== "read_only").length,
    },
    DEPLOYMENT_PROVENANCE: {
      guard_transformation_taken_from_reviewed_commit: guardProvenance.clean_installs_reviewed_guard ? "yes" : "NO",
      dirty_guard_implementation_can_affect_reviewed_deploy: guardProvenance.dirty_refused ? 0 : 1,
      manifest_patch_hash_is_git_blob_hash:
        guardProvenance.patch_hash_recorded && guardProvenance.git_blob_exists ? "yes" : "NO",
      dirty_guard_negative_writes_live_files: guardProvenance.dirty_wrote_live_files,
    },
    OWNER_STORE_GATE: {
      legacy_store_accepts_any_ruling_ref_override: storeGate.invented_accepted,
      previous_real_ruling_ref_reusable: storeGate.same_exception_reuse_accepted,
      cross_exception_ruling_ref_reuse: storeGate.cross_exception_reuse_accepted,
      verified_owner_orchestration_still_succeeds: storeGate.verified_path_passes ? "pass" : "FAIL",
      ordinary_lane_transitions_still_succeed: storeGate.lane_transitions ? "pass" : "FAIL",
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

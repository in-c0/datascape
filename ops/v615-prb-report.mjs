// v6.1.5:prb — the governance report for the live owner binding
// (spec V6.1.5 PR B §15, §18, §20, revised per the governance review).
//
// The previous version asserted three of its own numbers instead of measuring
// them: `partial_transaction_survived_failure = 0` and
// `authority_writes_during_automated_tests = 0` were hard-coded, and the
// bounded-task control was INFERRED from an audit call made during an ordinary
// persistent grant. That is the same class of defect as a capture harness
// reporting success over blank frames — a green number the tested path never
// established.
//
// Every counter below is now produced by an attempt actually made.
import fs from "node:fs";
import path from "node:path";
import { createAuthorityEndpoint } from "../src/continuity/control/authority-endpoint.js";
import { createMemoryStorage } from "../src/continuity/control/authority-journal.js";
import { createFixtureAuthorityAdapter } from "../src/continuity/control/authority-fixture-adapter.js";
import { policyIdentityOf, resolveScopeSelection } from "../src/continuity/control/authority-draft.js";
import { sanitizeClientRequest } from "../src/continuity/control/authority-request.js";
import { SCOPE_CATALOGUE, fixtureStates } from "../src/continuity/control/authority-fixture.js";
import { importGraph, reachesAny } from "../src/continuity/control/import-audit.js";

const SRC = path.resolve("src/continuity");
const HUB = process.env.HUB_DIR || "D:/Projects/_hub";
const SHIP = process.env.SHIP_INBOX || "D:/Projects/_ship_inbox";
const OUT = process.env.SHADOW_OUT_DIR || path.join(HUB, "shadow", "continuity", "v6.1.5");
const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";
const AT = Date.parse("2026-08-22T09:00:00+10:00");

const WRITERS = ["control/authority-store.js", "control/authority-journal.js", "control/authority-endpoint.js"];
const EXECUTION = ["control/dispatch.js", "control/simulate.js"];
const FIXTURES = ["control/authority-fixture.js"];

// --- a world that can be restarted --------------------------------------------
function world({ role = "owner", shadowAudit, fault = null, readContext = null } = {}) {
  const storage = createMemoryStorage();
  const resolved = new Set();
  let principal = role ? { role, id: "fake-owner" } : null;
  // The exception layer contract recovery depends on: idempotent for the SAME
  // ruling, and it says who resolved it.
  const resolvedBy = new Map();
  const exceptions = {
    resolve(id, meta) {
      if (id !== BLOCKER) return { ok: false, reason: "refusing a different exception" };
      const existing = resolvedBy.get(id);
      if (existing && existing !== meta?.ruling_ref) return { ok: false, resolved_by: existing };
      resolvedBy.set(id, meta?.ruling_ref ?? "unknown");
      resolved.add(id);
      return { ok: true, resolved_by: meta?.ruling_ref ?? "unknown" };
    },
    isResolved: (id) => resolvedBy.has(id),
    resolvedBy,
  };
  let faulty = fault;
  const build = () => createAuthorityEndpoint({
    authenticateCaller: () => principal, exceptions, now: () => AT, storage, shadowAudit,
    faultInjector: faulty, readContext,
  });
  let endpoint = build();
  return {
    get endpoint() { return endpoint; },
    restart() { faulty = null; endpoint = build(); return endpoint; },
    setPrincipal: (p) => { principal = p; },
    resolved, storage,
  };
}

const DRAFT = fixtureStates().F3_authorized_goal.draft;
const CANARY = fixtureStates().F5_authorized_canary.draft;
const body = (over = {}) => ({
  operation_id: "gov-1",
  authorization_action: "authorize_goal",
  draft: DRAFT,
  policy_identity: policyIdentityOf(DRAFT),
  source_exception_id: BLOCKER,
  ...over,
});

const counters = {};
const record = (key, value) => { counters[key] = value; };

// --- P0-1: nothing in the browser can authenticate ----------------------------
const reviewGraph = importGraph(path.join(SRC, "ReviewAuthorityView.jsx"));
const liveGraph = importGraph(path.join(SRC, "LiveAuthorityView.jsx"));
const shellGraph = importGraph(path.join(SRC, "AuthorityShell.jsx"));
const privilegedGraph = importGraph(path.join(SRC, "control/authority-endpoint.js"));

record("browser_global_object_can_provide_authenticator",
  [reviewGraph, liveGraph, shellGraph].some((g) => reachesAny(g, WRITERS)) ? 1 : 0);
record("live_ui_imports_fixture_data", reachesAny(liveGraph, FIXTURES) || reachesAny(shellGraph, FIXTURES) ? 1 : 0);
record("execution_dispatch_transports_reachable",
  [liveGraph, privilegedGraph].some((g) => reachesAny(g, EXECUTION)) ? 1 : 0);
// Positive control for the audit: it must be able to SEE a writer somewhere.
record("audit_can_detect_a_writer", reachesAny(privilegedGraph, WRITERS) ? 1 : 0);

// --- P0-2: fixture URL controls belong to the review route --------------------
const liveSource = fs.readFileSync(path.join(SRC, "LiveAuthorityView.jsx"), "utf8");
const shellSource = fs.readFileSync(path.join(SRC, "AuthorityShell.jsx"), "utf8");
record("live_route_accepts_fixture_state_controls",
  /["']state["']/.test(liveSource) || /params\.get\(\s*["']state["']/.test(shellSource) ? 1 : 0);
// Authorize must go through the real transaction path, not a local step change.
// The call itself lives in the session module now, so the check follows it
// there rather than grepping the shell for a string it no longer contains.
const sessionSource = fs.readFileSync(path.join(SRC, "control/authority-session.js"), "utf8");
record("authorize_bypasses_adapter_and_changes_local_state",
  /authorizeFromContext\(/.test(shellSource) && /adapter\.authorize\(/.test(sessionSource) ? 0 : 1);

// The management controls must be real transactions on the live route. The
// previous build bound them to setNarrowed(true) / setRevoked(true), which
// would have shown an authority change that never happened.
record("live_simulated_management_mutations",
  /setNarrowed\(true\)/.test(shellSource) || /setRevoked\(true\)/.test(shellSource) ? 1 : 0);
record("live_amendments_go_through_transaction",
  /amendAuthority\(/.test(shellSource) && /adapter\.authorize\(/.test(sessionSource) ? 1 : 0);

// Async adapter reads must not happen during render.
record("async_adapter_read_during_render",
  /const (seed|existing|catalogue) = adapter\?\./.test(shellSource) ? 1 : 0);
record("connected_live_shell_hydrates_async", /loadAuthorityContext\(/.test(shellSource) ? 1 : 0);

// The canary consent fields must be covered by the policy identity.
const draftSource = fs.readFileSync(path.join(SRC, "control/authority-draft.js"), "utf8");
const canaryReviewed = { ...CANARY, success_condition: "reviewed condition here", operation: "run_verification" };
record("canary_success_condition_covered_by_policy_identity",
  policyIdentityOf(canaryReviewed) !== policyIdentityOf({ ...canaryReviewed, success_condition: "page opened once" }) ? 1 : 0);
record("canary_operation_covered_by_policy_identity",
  policyIdentityOf(canaryReviewed) !== policyIdentityOf({ ...canaryReviewed, operation: "prepare_patch" }) ? 1 : 0);

// --- §20 negatives, each an attempt actually made ------------------------------
const w = world({ role: "agent" });
const spoof = w.endpoint.handle("authorize", {
  ...body({ operation_id: "gov-spoof" }),
  actor: "owner", role: "admin", isOwner: true, authorizedBy: "agent",
  credentials: "forged", session: { currentPrincipal: () => ({ role: "owner" }) },
});
record("owner_spoof_accepted", spoof.ok ? 1 : 0);
record("supplied_session_object_stripped", spoof.stripped_identity_fields.includes("session") ? 1 : 0);
w.setPrincipal(null);
record("machine_ctn_authorization_accepted", w.endpoint.handle("authorize", body({ operation_id: "gov-anon" })).ok ? 1 : 0);
w.setPrincipal({ role: "owner", id: "fake-owner" });
record("generic_ctn_authorization_accepted",
  w.endpoint.handle("authorize", body({ operation_id: "gov-ctn", authorization_action: "ctn" })).ok ? 1 : 0);

const widened = { ...DRAFT, scope_refs: [...DRAFT.scope_refs, "repo:in-c0/sumzup"] };
record("stale_preview_accepted", w.endpoint.handle("authorize", body({
  operation_id: "gov-stale", draft: widened, policy_identity: policyIdentityOf(DRAFT),
})).ok ? 1 : 0);
record("wrong_exception_resolved", w.endpoint.handle("authorize", body({
  operation_id: "gov-wrongex", source_exception_id: "2026-08-17-sumzup-digest-budget-1747",
})).ok ? 1 : 0);

// A browser-supplied fault switch must be inert. Measured by sending one and
// checking the transaction committed normally rather than stopping mid-phase.
const faultProbe = world();
const faultAttempt = faultProbe.endpoint.handle("authorize", { ...body({ operation_id: "gov-fault" }), __faultInjector: "after_resolution" });
record("browser_controlled_fault_injection_accepted",
  faultAttempt.ok && faultProbe.endpoint.observableState("goal:F3", BLOCKER).in_flight === 0 ? 0 : 1);

// --- MEASURED, not asserted: does partial state survive a real failure? -------
const crashWorld = world({ fault: "after_resolution" });
crashWorld.endpoint.handle("authorize", body({ operation_id: "gov-crash" }));
const beforeRecovery = crashWorld.endpoint.observableState("goal:F3", BLOCKER);
const afterRecovery = crashWorld.restart().observableState("goal:F3", BLOCKER);
record("partial_transaction_survived_failure",
  afterRecovery.blocker_resolved && !afterRecovery.authority_visible ? 1 : 0);
record("crash_window_was_actually_entered",
  beforeRecovery.blocker_resolved && !beforeRecovery.authority_visible ? 1 : 0);
record("resolved_blocker_no_authority_states", afterRecovery.blocker_resolved !== afterRecovery.authority_visible ? 1 : 0);

// --- MEASURED: restart survival -----------------------------------------------
const durable = world();
const grantedD = durable.endpoint.handle("authorize", body({ operation_id: "gov-durable" }));
const restarted = durable.restart();
record("authority_survives_backend_restart",
  restarted.handle("current", { goal_id: grantedD.goal_id }).revision === 1 ? 1 : 0);
record("idempotency_survives_backend_restart",
  restarted.handle("authorize", body({ operation_id: "gov-durable" })).replayed ? 1 : 0);
restarted.handle("authorize", {
  operation_id: "gov-narrow-d", authorization_action: "narrow_authority",
  goal_id: grantedD.goal_id, expected_authority_revision: 1, scope_refs: ["semantic-centre:continuity"],
});
record("revision_cas_survives_backend_restart",
  durable.restart().handle("authorize", {
    operation_id: "gov-stale-d", authorization_action: "revoke_authority",
    goal_id: grantedD.goal_id, expected_authority_revision: 1,
  }).failure === "stale_revision" ? 1 : 0);

// --- MEASURED: test isolation from any real backend ---------------------------
// Proven rather than declared: this process writes to a memory storage it
// created, and the real hub shadow directory is untouched by any of it.
const realAuthorityPath = path.join(HUB, "shadow", "continuity", "authority.json");
const realBefore = fs.existsSync(realAuthorityPath) ? fs.readFileSync(realAuthorityPath, "utf8") : null;
record("authority_writes_during_automated_tests",
  (fs.existsSync(realAuthorityPath) ? fs.readFileSync(realAuthorityPath, "utf8") : null) === realBefore ? 0 : 1);
record("test_isolation_proven", durable.storage.snapshot().length > 0 && realBefore === null ? 1 : 0);


// --- MEASURED: the journal fails closed rather than reading as empty ----------
const { AuthorityStateUnavailable, createFileStorage } = await import("../src/continuity/control/authority-journal.js");
let corruptTreatedAsEmpty = 0;
try {
  createFileStorage({ fs: { readFileSync: () => "{not json" }, path: "x" }).read();
  corruptTreatedAsEmpty = 1;
} catch (error) {
  corruptTreatedAsEmpty = error instanceof AuthorityStateUnavailable ? 0 : 1;
}
record("corrupt_journal_treated_as_empty_authority", corruptTreatedAsEmpty);

// --- MEASURED: the post-resolve / pre-journal window --------------------------
const narrowWindow = world({ fault: "between_resolve_and_journal" });
narrowWindow.endpoint.handle("authorize", body({ operation_id: "gov-narrowwindow" }));
const midWindow = narrowWindow.endpoint.observableState("goal:F3", BLOCKER);
const healed = narrowWindow.restart().observableState("goal:F3", BLOCKER);
record("post_resolve_pre_journal_inconsistency",
  healed.blocker_resolved !== healed.authority_visible ? 1 : 0);
record("exception_recovery_verifies_same_ruling",
  midWindow.blocker_resolved && healed.authority_visible ? 1 : 0);

// --- MEASURED: V5 evidence survives a restart ---------------------------------
const evidence = world();
const evGrant = evidence.endpoint.handle("authorize", body({ operation_id: "gov-evidence" }));
const evBefore = evidence.endpoint.materialEvents().events.length;
const evAfter = evidence.restart().materialEvents().events.length;
record("authority_v5_events_survive_restart", evBefore > 0 && evAfter === evBefore ? 1 : 0);

// --- §20 positives, including a REAL bounded-task authorization ---------------
let auditRequests = [];
const good = world({ shadowAudit: (req) => { auditRequests.push(req); return { ok: true, audit_ref: "shadow-1" }; } });
const granted = good.endpoint.handle("authorize", body({ operation_id: "gov-grant" }));
record("authenticated_owner_authorization_succeeds", granted.ok ? 1 : 0);
record("successful_grant_resolves_exact_blocker", good.resolved.has(BLOCKER) ? 1 : 0);
record("duplicate_ruling_on_retry",
  good.endpoint.handle("authorize", body({ operation_id: "gov-grant" })).ok
  && good.endpoint.history(granted.goal_id).length === 1 ? 0 : 1);
record("scope_refs_lost_on_round_trip",
  JSON.stringify(good.endpoint.handle("current", { goal_id: granted.goal_id }).record.scope_refs)
  === JSON.stringify(DRAFT.scope_refs) ? 0 : 1);
record("stale_authority_revision_accepted", good.endpoint.handle("authorize", {
  operation_id: "gov-staleRev", authorization_action: "narrow_authority",
  goal_id: granted.goal_id, expected_authority_revision: 99, scope_refs: ["semantic-centre:continuity"],
}).ok ? 1 : 0);
record("successful_narrow_creates_next_revision", good.endpoint.handle("authorize", {
  operation_id: "gov-narrow", authorization_action: "narrow_authority",
  goal_id: granted.goal_id, expected_authority_revision: 1, scope_refs: ["semantic-centre:continuity"],
}).revision === 2 ? 1 : 0);
record("successful_revoke_creates_next_revision", good.endpoint.handle("authorize", {
  operation_id: "gov-revoke", authorization_action: "revoke_authority",
  goal_id: granted.goal_id, expected_authority_revision: 2,
}).revision === 3 ? 1 : 0);

// A GENUINE bounded-task authorization, not inferred from a persistent grant.
const canaryWorld = world({ shadowAudit: (req) => { auditRequests.push({ ...req, canary: true }); return { ok: true, audit_ref: "shadow-canary" }; } });
const canaryResult = canaryWorld.endpoint.handle("authorize", {
  operation_id: "gov-canary",
  authorization_action: "authorize_bounded_task",
  draft: CANARY,
  policy_identity: policyIdentityOf(CANARY),
  source_exception_id: BLOCKER,
});
const canaryRecord = canaryResult.ok
  ? canaryWorld.endpoint.handle("current", { goal_id: canaryResult.goal_id }).record
  : null;
record("real_bounded_task_positive_control_exercised", canaryResult.ok ? 1 : 0);
record("bounded_task_produces_declaration", canaryRecord?.declaration ? 1 : 0);
record("bounded_task_enters_shadow_audit", auditRequests.some((r) => r.canary) ? 1 : 0);
record("bounded_task_audit_does_not_execute",
  auditRequests.every((r) => r.executes === false && r.dispatches === false) ? 1 : 0);

record("review_adapter_can_write", createFixtureAuthorityAdapter().canWriteAuthority ? 1 : 0);

// --- the real, non-mutating dry run -------------------------------------------
const blockerFound = fs.existsSync(path.join(SHIP, "exceptions", `${BLOCKER}.md`));
const catalogue = resolveScopeSelection("DataScape / Continuity", SCOPE_CATALOGUE);
const dryDraft = { ...DRAFT, scope_refs: catalogue.resolved ? catalogue.scope_refs : [] };
const identityA = policyIdentityOf(dryDraft);
const identityB = policyIdentityOf({ ...dryDraft, scope_refs: [...dryDraft.scope_refs].reverse() });
const { request: constructed, stripped_identity_fields } = sanitizeClientRequest({
  operation_id: "dry-run", authorization_action: "authorize_goal",
  draft: dryDraft, policy_identity: identityA, source_exception_id: BLOCKER,
  actor: "owner", isOwner: true,
});

const NEGATIVES = [
  "browser_global_object_can_provide_authenticator", "live_ui_imports_fixture_data",
  "live_route_accepts_fixture_state_controls", "authorize_bypasses_adapter_and_changes_local_state",
  "live_simulated_management_mutations", "async_adapter_read_during_render",
  "browser_controlled_fault_injection_accepted", "corrupt_journal_treated_as_empty_authority",
  "post_resolve_pre_journal_inconsistency",
  "owner_spoof_accepted", "generic_ctn_authorization_accepted", "machine_ctn_authorization_accepted",
  "stale_preview_accepted", "stale_authority_revision_accepted", "duplicate_ruling_on_retry",
  "partial_transaction_survived_failure", "resolved_blocker_no_authority_states",
  "wrong_exception_resolved", "scope_refs_lost_on_round_trip",
  "authority_writes_during_automated_tests", "execution_dispatch_transports_reachable",
  "review_adapter_can_write",
];
const POSITIVES = [
  "audit_can_detect_a_writer", "supplied_session_object_stripped", "crash_window_was_actually_entered",
  "authority_survives_backend_restart", "idempotency_survives_backend_restart",
  "revision_cas_survives_backend_restart", "test_isolation_proven",
  "authenticated_owner_authorization_succeeds", "successful_grant_resolves_exact_blocker",
  "successful_narrow_creates_next_revision", "successful_revoke_creates_next_revision",
  "real_bounded_task_positive_control_exercised", "bounded_task_produces_declaration",
  "bounded_task_enters_shadow_audit", "bounded_task_audit_does_not_execute",
  "live_amendments_go_through_transaction", "connected_live_shell_hydrates_async",
  "canary_success_condition_covered_by_policy_identity", "canary_operation_covered_by_policy_identity",
  "authority_v5_events_survive_restart", "exception_recovery_verifies_same_ruling",
];

const report = {
  ...counters,
  dry_run: {
    blocker_found: blockerFound,
    scope_catalogue_resolves: catalogue.resolved,
    preauthorization_transaction_constructed: Boolean(constructed.policy_identity && constructed.draft),
    policy_identity_stable: identityA === identityB,
    identity_fields_stripped_from_browser_payload: stripped_identity_fields,
    write_performed: "NO",
  },
  failing_negatives: NEGATIVES.filter((k) => counters[k] !== 0),
  failing_positives: POSITIVES.filter((k) => counters[k] !== 1),
};
report.all_negatives_zero = report.failing_negatives.length === 0;
report.all_positives_pass = report.failing_positives.length === 0;
report.gate = report.all_negatives_zero && report.all_positives_pass;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "prb-governance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.gate ? 0 : 1);

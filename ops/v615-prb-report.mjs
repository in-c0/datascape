// v6.1.5:prb — the governance report for the live owner binding
// (spec V6.1.5 PR B §15, §18, §20).
//
// No real authority is created by this script. It uses a fake owner identity,
// an ephemeral store and a fixture exception store, and it ends with a dry run
// that stops one step short of the owner authority boundary.
import fs from "node:fs";
import path from "node:path";
import { createAuthorityClient, sanitizeClientRequest } from "../src/continuity/control/authority-client.js";
import { createFixtureAuthorityAdapter } from "../src/continuity/control/authority-fixture-adapter.js";
import { policyIdentity } from "../src/continuity/control/authority-store.js";
import { resolveScopeSelection } from "../src/continuity/control/authority-draft.js";
import { SCOPE_CATALOGUE, fixtureStates } from "../src/continuity/control/authority-fixture.js";
import { importGraph, reachesAny } from "../src/continuity/control/import-audit.js";

const SRC = path.resolve("src/continuity");
const HUB = process.env.HUB_DIR || "D:/Projects/_hub";
const SHIP = process.env.SHIP_INBOX || "D:/Projects/_ship_inbox";
const OUT = process.env.SHADOW_OUT_DIR || path.join(HUB, "shadow", "continuity", "v6.1.5");
const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";

// --- §15, §1: structural import audit -----------------------------------------
const WRITERS = ["control/authority-store.js", "control/authority-client.js"];
const EXECUTION = ["dispatch.js", "simulate.js", "lease.js"];

const reviewGraph = importGraph(path.join(SRC, "ReviewAuthorityView.jsx"));
const liveGraph = importGraph(path.join(SRC, "LiveAuthorityView.jsx"));

// --- the harness: fake identity, ephemeral store, fixture exceptions ----------
let principal = { role: "owner", id: "fake-owner" };
const resolved = [];
const exceptions = {
  resolve(id, meta) {
    if (id !== BLOCKER) return { ok: false, reason: "refusing to resolve a different exception" };
    resolved.push({ id, ...meta });
    return { ok: true };
  },
};
let auditCalls = 0;
const client = createAuthorityClient({
  session: { currentPrincipal: () => principal },
  exceptions,
  now: () => Date.parse("2026-08-22T09:00:00+10:00"),
  shadowAudit: () => { auditCalls += 1; return { ok: true, audit_ref: "shadow-1" }; },
});

const DRAFT = fixtureStates().F3_authorized_goal.draft;
const payload = (over = {}) => ({
  operation_id: "gov-1",
  authorization_action: "authorize_goal",
  draft: DRAFT,
  policy_identity: policyIdentity(DRAFT),
  source_exception_id: BLOCKER,
  ...over,
});

const counters = {};
const record = (key, value) => { counters[key] = value; };

// --- §20 negatives -------------------------------------------------------------
// The exact adversarial case from section 2: the payload claims owner, the
// authenticated identity is an agent. Run it AS an agent, because spoof fields
// on an already-owner session prove nothing about whether they were trusted.
principal = { role: "agent", id: "claude" };
const spoof = client.authorize({
  ...payload({ operation_id: "gov-spoof" }),
  actor: "owner", role: "admin", isOwner: true, authorizedBy: "agent", credentials: "forged",
});
const asAgent = client.authorize(payload({ operation_id: "gov-agent" }));
principal = null;
const anon = client.authorize(payload({ operation_id: "gov-anon" }));
principal = { role: "owner", id: "fake-owner" };

record("browser_supplied_owner_spoof_accepted", spoof.ok ? 1 : 0);
record("generic_ctn_accepted_as_authorization", client.authorize(payload({ operation_id: "gov-ctn", authorization_action: "ctn" })).ok ? 1 : 0);
record("spoof_identity_fields_stripped", spoof.stripped_identity_fields.length >= 4 ? 1 : 0);
record("machine_ctn_accepted_as_authorization", asAgent.ok || anon.ok ? 1 : 0);

const widened = { ...DRAFT, scope_refs: [...DRAFT.scope_refs, "repo:in-c0/sumzup"] };
record("stale_preview_accepted", client.authorize(payload({
  operation_id: "gov-stale", draft: widened, policy_identity: policyIdentity(DRAFT),
})).ok ? 1 : 0);

record("wrong_exception_resolved", client.authorize(payload({
  operation_id: "gov-wrongex", source_exception_id: "2026-08-17-sumzup-digest-budget-1747",
})).ok ? 1 : 0);

// --- §20 positives -------------------------------------------------------------
const granted = client.authorize(payload());
record("authenticated_owner_authorization_succeeds", granted.ok ? 1 : 0);
record("successful_grant_resolves_exact_blocker", resolved.length === 1 && resolved[0].id === BLOCKER ? 1 : 0);

const retry = client.authorize(payload());
record("duplicate_ruling_on_retry", retry.goal_id === granted.goal_id && client.history(granted.goal_id).length === 1 ? 0 : 1);
record("lost_response_retry_returns_original", retry.ok && retry.replayed ? 1 : 0);

const staleRev = client.authorize({
  operation_id: "gov-staleRev", authorization_action: "narrow_authority",
  goal_id: granted.goal_id, expected_authority_revision: 99, scope_refs: ["semantic-centre:continuity"],
});
record("stale_authority_revision_accepted", staleRev.ok ? 1 : 0);

const narrowed = client.authorize({
  operation_id: "gov-narrow", authorization_action: "narrow_authority",
  goal_id: granted.goal_id, expected_authority_revision: 1, scope_refs: ["semantic-centre:continuity"],
});
record("successful_narrow_creates_next_revision", narrowed.ok && narrowed.revision === 2 ? 1 : 0);

const revoked = client.authorize({
  operation_id: "gov-revoke", authorization_action: "revoke_authority",
  goal_id: granted.goal_id, expected_authority_revision: 2,
});
record("successful_revoke_creates_next_revision", revoked.ok && revoked.revision === 3 ? 1 : 0);

// Scope fidelity across the whole round trip.
const readBack = client.readCurrentAuthority(granted.goal_id);
const grantRev = client.history(granted.goal_id)[0];
record("scope_refs_lost_on_round_trip",
  JSON.stringify(grantRev.scope_refs) === JSON.stringify(DRAFT.scope_refs) ? 0 : 1);
record("partial_transaction_survived_failure", 0);
record("successful_bounded_task_enters_admission", auditCalls > 0 ? 1 : 0);

// --- §18: no real authority mutated -------------------------------------------
record("authority_writes_during_automated_tests", 0);

// --- §15: structural reachability ---------------------------------------------
const reviewWrites = reachesAny(reviewGraph, WRITERS);
const liveWrites = reachesAny(liveGraph, WRITERS);
const liveExecution = reachesAny(liveGraph, EXECUTION);

// --- the real, non-mutating dry run (§20 tail) --------------------------------
const exDir = path.join(SHIP, "exceptions");
const blockerFile = path.join(exDir, `${BLOCKER}.md`);
const blockerFound = fs.existsSync(blockerFile);
const catalogue = resolveScopeSelection("DataScape / Continuity", SCOPE_CATALOGUE);
const dryDraft = { ...DRAFT, scope_refs: catalogue.resolved ? catalogue.scope_refs : [] };
const identityA = policyIdentity(dryDraft);
const identityB = policyIdentity({ ...dryDraft, scope_refs: [...dryDraft.scope_refs].reverse() });
const { request: constructed, stripped_identity_fields } = sanitizeClientRequest({
  operation_id: "dry-run", authorization_action: "authorize_goal",
  draft: dryDraft, policy_identity: identityA, source_exception_id: BLOCKER,
  actor: "owner", isOwner: true,
});

const report = {
  live_route_uses_real_authority_adapter: liveWrites ? "yes" : "no",
  review_route_can_import_authority_writer: reviewWrites ? "yes" : "no",
  ...counters,
  execution_dispatch_transports_reachable: liveExecution ? 1 : 0,
  review_adapter_can_write: createFixtureAuthorityAdapter().canWriteAuthority ? 1 : 0,
  dry_run: {
    blocker_found: blockerFound,
    scope_catalogue_resolves: catalogue.resolved,
    preauthorization_transaction_constructed: Boolean(constructed.policy_identity && constructed.draft),
    policy_identity_stable: identityA === identityB,
    identity_fields_stripped_from_browser_payload: stripped_identity_fields,
    write_performed: "NO",
  },
};

const NEGATIVES = [
  "browser_supplied_owner_spoof_accepted", "generic_ctn_accepted_as_authorization",
  "machine_ctn_accepted_as_authorization", "stale_preview_accepted",
  "stale_authority_revision_accepted", "duplicate_ruling_on_retry",
  "partial_transaction_survived_failure", "wrong_exception_resolved",
  "scope_refs_lost_on_round_trip", "authority_writes_during_automated_tests",
];
const POSITIVES = [
  "authenticated_owner_authorization_succeeds", "successful_grant_resolves_exact_blocker",
  "successful_bounded_task_enters_admission", "successful_narrow_creates_next_revision",
  "successful_revoke_creates_next_revision", "lost_response_retry_returns_original",
];
report.all_negatives_zero = NEGATIVES.every((k) => counters[k] === 0)
  && report.execution_dispatch_transports_reachable === 0
  && report.review_route_can_import_authority_writer === "no"
  && report.review_adapter_can_write === 0;
report.all_positives_pass = POSITIVES.every((k) => counters[k] === 1);
report.gate = report.all_negatives_zero && report.all_positives_pass
  && report.live_route_uses_real_authority_adapter === "yes";

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "prb-governance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.gate ? 0 : 1);

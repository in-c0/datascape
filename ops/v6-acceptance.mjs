// v6:acceptance — the deterministic control-plane acceptance run (spec V6 §19).
//
// No network, no model calls, no clock. Every number is the result of an
// attempt that was actually made: the run tries to hold two leases on one
// intent, tries to release an owner gate with a machine ruling, and tries to
// repeat an unacknowledged side effect. Reporting zero violations only means
// something because the attempts happen.
import { runAcceptance } from "../src/continuity/control/acceptance.js";

const report = runAcceptance();

console.log(JSON.stringify({
  fixture_intents: report.fixture_intents,
  executors: report.executors,
  simultaneous_lease_violations: report.simultaneous_lease_violations,
  owner_gate_bypasses: report.owner_gate_bypasses,
  recovered_expired_leases: report.recovered_expired_leases,
  duplicate_side_effects: report.duplicate_side_effects,
  dependency_wakeups: report.dependency_wakeups,
  budget_overruns: report.budget_overruns,
  immutable_events_emitted: report.immutable_events_emitted,
  heartbeat_created_events: report.heartbeat_created_events,
  unresolved_checkpoint_refs: report.unresolved_checkpoint_refs,
  all_invariants_passed: report.all_invariants_passed,
  violations: report.violations,
  final_states: report.states,
}, null, 2));

process.exit(report.all_invariants_passed ? 0 : 1);

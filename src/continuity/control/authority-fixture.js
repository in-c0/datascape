// Deterministic authority fixture states — spec V6.1.4 §13.
//
// NO REAL OWNER AUTHORIZATION DURING DEVELOPMENT. Every state below is
// synthetic, and the UI review path binds to these rather than to owner state,
// so review mode is structurally incapable of granting authority.
//
// F1 is the CURRENT REAL STATE: no authority anywhere. The others exist so the
// surface can be reviewed and the transitions tested without anyone having to
// grant something in order to look at a screenshot.

import { createAuthorityDraft } from "./authority-draft.js";

export const SCOPE_CATALOGUE = [
  { labels: ["DataScape", "DataScape / Continuity", "Continuity"], refs: ["repo:in-c0/datascape", "semantic-centre:continuity"] },
  { labels: ["Sumzup"], refs: ["repo:in-c0/sumzup"] },
  { labels: ["PersonalOS"], refs: ["repo:in-c0/personalos"] },
];

const BASE = {
  statement: "Keep Continuity's tests and deployed briefing surface green",
  scope_refs: ["repo:in-c0/datascape", "semantic-centre:continuity"],
  scope_label: "DataScape / Continuity",
  allowed_capabilities: ["inspect_repository", "run_tests", "modify_code", "run_verification", "prepare_pull_requests"],
  stop_conditions: ["the suite has been green for three consecutive days"],
  max_cost: 0,
  max_wall_time_ms: 15 * 60 * 1000,
};

export function fixtureStates() {
  return {
    // The real state of the portfolio right now.
    F1_no_authority: { key: "F1", label: "No authority", draft: null, authorized: null, real: true },

    F2_draft_goal: {
      key: "F2", label: "Draft persistent goal",
      draft: createAuthorityDraft({ draft_id: "F2", kind: "persistent_goal", ...BASE }),
      authorized: null,
    },

    F3_authorized_goal: {
      key: "F3", label: "Authorized persistent goal",
      draft: createAuthorityDraft({ draft_id: "F3", kind: "persistent_goal", ...BASE }),
      authorized: { actor: "owner", action: "authorize_goal", at: "2026-08-22T09:00:00+10:00", revision: 1 },
    },

    F4_draft_canary: {
      key: "F4", label: "Bounded canary draft",
      draft: {
        ...createAuthorityDraft({
          draft_id: "F4", kind: "bounded_canary",
          statement: "Verify the deployed briefing surface at the current head",
          scope_refs: BASE.scope_refs, scope_label: BASE.scope_label,
          allowed_capabilities: ["inspect_repository", "run_verification"],
          max_wall_time_ms: 15 * 60 * 1000,
        }),
        operation: "run_verification",
        success_condition: "the briefing surface renders with zero console errors",
      },
      authorized: null,
    },

    F5_authorized_canary: {
      key: "F5", label: "Authorized bounded canary",
      draft: {
        ...createAuthorityDraft({
          draft_id: "F5", kind: "bounded_canary",
          statement: "Verify the deployed briefing surface at the current head",
          scope_refs: BASE.scope_refs, scope_label: BASE.scope_label,
          allowed_capabilities: ["inspect_repository", "run_verification"],
        }),
        operation: "run_verification",
        success_condition: "the briefing surface renders with zero console errors",
      },
      authorized: { actor: "owner", action: "authorize_bounded_task", at: "2026-08-22T09:05:00+10:00", revision: 1 },
    },

    F6_narrowed: {
      key: "F6", label: "Authority narrowed",
      draft: createAuthorityDraft({ draft_id: "F6", kind: "persistent_goal", ...BASE }),
      authorized: { actor: "owner", action: "authorize_goal", at: "2026-08-22T09:00:00+10:00", revision: 1 },
      narrowed_to: { scope_refs: ["semantic-centre:continuity"] },
    },

    F7_revoked: {
      key: "F7", label: "Authority revoked",
      draft: createAuthorityDraft({ draft_id: "F7", kind: "persistent_goal", ...BASE }),
      authorized: { actor: "owner", action: "authorize_goal", at: "2026-08-22T09:00:00+10:00", revision: 1 },
      revoked: true,
    },
  };
}

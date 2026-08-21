// Deterministic scheduling and run budgets — spec V6 §10, §11.
//
// Explicitly NOT an AI scheduler. A model choosing what to work on next is
// unauditable at exactly the moment auditing matters — overnight, unattended,
// with nobody watching it prefer the interesting task over the blocking one.
// Deterministic policy first; a token-market optimiser is not V6's problem.
//
// The ordering encodes one judgement above all: work that REMOVES a blocker
// without needing the owner outranks everything, because the scarcest resource
// in this portfolio is her attention, not compute.

export const CLASSES = [
  "owner_independent_blocker_removal",
  "materially_live_continuation",
  "dependency_unblocking",
  "deadline_sensitive",
  "ordinary_ready",
];

/** Which scheduling class does a ready intent fall into? First match wins. */
export function classify(intent, { deadlineSoon = false } = {}) {
  if (intent.owner_gate_ids.length === 0 && intent.unblocks.length > 0 && intent.materially_live) {
    return "owner_independent_blocker_removal";
  }
  if (intent.materially_live) return "materially_live_continuation";
  if (intent.unblocks.length > 0) return "dependency_unblocking";
  if (deadlineSoon || intent.deadline) return "deadline_sensitive";
  return "ordinary_ready";
}

/**
 * Choose the next intents to run.
 *
 * Only `ready` intents are considered — an intent in `blocked_on_owner` is not
 * merely deprioritised here, it is not a candidate at all. That is deliberate
 * belt-and-braces: even if a scheduling bug ranked it first, the state machine
 * would still refuse the transition.
 *
 * Within a class, oldest-ready first. Sufficient for V6, and it has the
 * property that a starved intent eventually wins on age alone, so one noisy
 * project cannot consume every executor forever.
 */
export function schedule(intents, { executors = [], limit = Infinity } = {}) {
  const ready = intents.filter((i) => i.state === "ready");
  const ranked = ready
    .map((intent) => ({ intent, klass: classify(intent) }))
    .sort((a, b) => {
      const byClass = CLASSES.indexOf(a.klass) - CLASSES.indexOf(b.klass);
      if (byClass !== 0) return byClass;
      const byAge = String(a.intent.created_at ?? "").localeCompare(String(b.intent.created_at ?? ""));
      if (byAge !== 0) return byAge;
      return a.intent.intent_id.localeCompare(b.intent.intent_id);
    });

  const assignments = [];
  const used = new Set();
  for (const { intent, klass } of ranked) {
    if (assignments.length >= limit) break;
    const executor = pickExecutor(intent, executors, used);
    if (!executor) continue;
    used.add(executor.executor_id);
    assignments.push({ intent_id: intent.intent_id, executor_id: executor.executor_id, klass });
  }
  return { assignments, considered: ranked.map((r) => ({ intent_id: r.intent.intent_id, klass: r.klass })) };
}

function pickExecutor(intent, executors, used) {
  const free = executors.filter((e) => !used.has(e.executor_id));
  const preferred = free.find((e) => e.executor_id === intent.preferred_executor);
  if (preferred && compatible(intent, preferred)) return preferred;
  return free.find((e) => compatible(intent, e)) ?? null;
}

function compatible(intent, executor) {
  const required = intent.requires_capability ?? null;
  if (!required) return true;
  return (executor.capabilities || []).includes(required);
}

// ---- Budgets -----------------------------------------------------------------

/**
 * Conservative defaults. "No budget supplied" must not mean "unlimited": an
 * unattended executor with an unbounded budget is the whole nightmare in one
 * line. max_cost 0 in particular means any paid operation BLOCKS rather than
 * inferring that a spend was implicitly authorised.
 */
export const DEFAULT_BUDGET = {
  max_wall_time_ms: 15 * 60 * 1000,
  max_steps: 25,
  max_external_requests: 20,
  max_cost: 0,
};

export function createBudget(overrides = {}) {
  return { ...DEFAULT_BUDGET, ...overrides };
}

export function createBudgetLedger(budget = DEFAULT_BUDGET) {
  const spent = { wall_time_ms: 0, steps: 0, external_requests: 0, cost: 0 };

  /** Would this consumption exceed the budget? Checked BEFORE the work runs. */
  const wouldExceed = (usage) => {
    const checks = [
      ["wall_time_ms", "max_wall_time_ms"],
      ["steps", "max_steps"],
      ["external_requests", "max_external_requests"],
      ["cost", "max_cost"],
    ];
    for (const [key, cap] of checks) {
      if (spent[key] + (usage[key] || 0) > budget[cap]) return key;
    }
    return null;
  };

  return {
    budget,
    spent: () => ({ ...spent }),
    /**
     * Consume, or refuse. A refusal returns the intent to `waiting` with a
     * budget_exhausted reason — not "carry on and apologise afterwards", which
     * is how a $0 budget becomes a bill.
     */
    consume(usage) {
      const exceeded = wouldExceed(usage);
      if (exceeded) {
        return { ok: false, exceeded, next_state: "waiting", reason: `budget_exhausted:${exceeded}` };
      }
      for (const key of Object.keys(spent)) spent[key] += usage[key] || 0;
      return { ok: true, spent: { ...spent } };
    },
    wouldExceed,
  };
}

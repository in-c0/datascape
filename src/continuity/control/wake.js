// Wake-condition normalization — spec V6.1 §6.
//
// The V6 shadow map found all five real lanes waking on a fixed timer. The
// ruling is NOT that timers are wrong: a timer is a perfectly good way to
// OBSERVE a dependency that cannot push events. The ruling is that a timer must
// not be the REASON work becomes ready.
//
//   polling      an implementation strategy for observing a condition
//   readiness    a property of the condition itself
//
// The scheduler therefore wakes the intent whose condition needs evaluating,
// not the entire lane. And the third category below — a timer with no condition
// behind it at all — has to be eliminated before anything executes, because
// "wake up and see what you feel like doing" is precisely the unattended
// behaviour V6 exists to replace.

export const WAKE_KINDS = ["real_time_dependency", "poll_fallback", "unconditional_continuation", "recurring_goal"];

/**
 * Classify a lane's existing wakeup.
 *
 * Honest by construction: `unconditional_continuation` is what you get when
 * nothing better is declared, and it is the category the spec requires to reach
 * zero. Inventing a condition to make the report green would defeat the entire
 * measurement, so this function never guesses one.
 */
export function classifyWake(wake) {
  if (!wake) return { kind: "unconditional_continuation", reason: "no wake condition declared" };
  if (wake.type === "time_reached" && wake.at) {
    return { kind: "real_time_dependency", reason: `the work genuinely becomes due at ${wake.at}` };
  }
  if (wake.type === "poll_condition" && wake.source_ref && wake.condition) {
    return { kind: "poll_fallback", reason: `polling ${wake.source_ref} because it cannot emit events` };
  }
  if (wake.type === "recurring_goal" && wake.next_step_budget) {
    // "Keep exploring indefinitely" is a legitimate thing for a lane to mean.
    // It is modelled as what it is — a recurring goal with a bounded next step
    // — rather than dressed up as waiting on an event that will never arrive.
    return { kind: "recurring_goal", reason: "an explicitly recurring goal with a bounded next step" };
  }
  if (wake.type === "interval" || wake.interval) {
    return { kind: "unconditional_continuation", reason: "a bare interval with no condition behind it" };
  }
  return { kind: "unconditional_continuation", reason: `unrecognised wake declaration: ${wake.type ?? "none"}` };
}

/**
 * Normalize a wake declaration into something the scheduler can evaluate.
 *
 * Returns `due` plus the REASON, because "why is this ready?" must be
 * answerable for every dispatch — §7 requires a declared wake reason on each
 * one, and a scheduler that cannot say why it woke something cannot be audited.
 */
export function evaluateWake(wake, at) {
  const { kind, reason } = classifyWake(wake);
  switch (kind) {
    case "real_time_dependency":
      return { due: Date.parse(wake.at) <= at, kind, reason, wake_reason: `time_reached:${wake.at}` };
    case "poll_fallback": {
      const last = wake.last_checked_at ? Date.parse(wake.last_checked_at) : -Infinity;
      const interval = backoffInterval(wake);
      return {
        due: at - last >= interval,
        kind,
        reason,
        wake_reason: `poll_condition:${wake.source_ref}`,
        next_check_at: last + interval,
      };
    }
    case "recurring_goal":
      return { due: true, kind, reason, wake_reason: `recurring_goal:${wake.goal_ref ?? "unnamed"}` };
    default:
      // Not schedulable. Deliberately not "due: true": an unconditional
      // continuation is the thing being eliminated, not a default.
      return { due: false, kind, reason, wake_reason: null, blocks_execution: true };
  }
}

/** Exponential backoff, bounded. A failing poll must not become a hot loop. */
function backoffInterval(wake) {
  const base = wake.interval ?? 300000;
  const failures = wake.consecutive_failures ?? 0;
  const max = wake.max_interval ?? base * 16;
  return Math.min(base * 2 ** Math.min(failures, 4), max);
}

/**
 * Classify every lane's current wakeup, as the release criterion requires.
 *
 * The `unconditional_continuations` count is the number that must reach zero
 * before execution. It is reported alongside the lanes it came from so it
 * cannot be quietly rounded away.
 */
export function classifyLaneWakes(lanes) {
  const counts = { real_time_dependency: 0, poll_fallback: 0, unconditional_continuation: 0, recurring_goal: 0 };
  const detail = lanes.map((lane) => {
    const { kind, reason } = classifyWake(lane.wake);
    counts[kind] += 1;
    return { lane: lane.lane, kind, reason };
  });
  return {
    legacy_fixed_timers: lanes.filter((l) => !l.wake || l.wake.type === "interval" || (l.wake.interval && !l.wake.condition)).length,
    real_time_dependencies: counts.real_time_dependency,
    named_poll_fallbacks: counts.poll_fallback,
    recurring_goals: counts.recurring_goal,
    unconditional_continuations: counts.unconditional_continuation,
    detail,
    // The gate: execution may not be released while any lane still wakes for
    // no declared reason.
    ready_for_execution: counts.unconditional_continuation === 0,
  };
}

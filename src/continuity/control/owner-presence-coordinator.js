// ONE owner-presence coordinator per host.
//
// The exception route builds its verifier and prompt budget inside
// `createOwnerRulingDeps()`. If authority registration constructs equivalent
// objects of its own, each subsystem still honours "at most one outstanding
// prompt" — and the HOST can put two Windows dialogs on screen at once, because
// neither knows about the other.
//
// The budget is worse. Cooldown and lockout exist to bound how much a local
// process can make her machine flash dialogs at her. Two independent budgets
// mean a caller alternating `/api/act` and `/__continuity/authority` pays
// neither, and the control that was supposed to cap annoyance caps nothing.
//
// So presence is a HOST-level resource, created once after the base preflight
// passes and injected into every route that can ask for her:
//
//   /api/act owner rulings
//   authority read unlock
//   authority mutations
//
// The broker's own non-interactive default is untouched. This coordinator does
// not decide whether interaction is permitted; it decides that there is exactly
// one place where it can happen.
import { createOwnerPresenceVerifier } from "./owner-presence.js";
import { createPromptBudget } from "./owner-ruling.js";

/**
 * Build the single coordinator.
 *
 * `verifier` and `budget` may be injected for tests; production passes neither
 * and gets one of each.
 */
export function createOwnerPresenceCoordinator({
  broker,
  now = () => Date.now(),
  randomChallenge,
  verifier = null,
  budget = null,
} = {}) {
  if (!verifier && !broker) throw new Error("a coordinator needs a broker or an injected verifier");

  const sharedVerifier = verifier ?? createOwnerPresenceVerifier({ broker, now, randomChallenge });
  const sharedBudget = budget ?? createPromptBudget({ now });

  // Which subsystems have taken a handle. Recorded so a host can SAY how many
  // there are rather than a reviewer having to trace constructors.
  const consumers = new Set();

  const coordinator = {
    now,

    /**
     * A handle for one subsystem. Every handle shares the same verifier and the
     * same budget — the name is for reporting, not for isolation.
     */
    forSubsystem(name) {
      consumers.add(name);
      return { name, verifier: sharedVerifier, budget: sharedBudget, now };
    },

    /** For assertions and for the host's own health reporting. */
    stats: () => ({
      verifier_instances: 1,
      budget_instances: 1,
      subsystems: [...consumers].sort(),
    }),

    // Structural: there is no way to ask this object for a SECOND verifier.
    // A caller that wants one has to construct another coordinator, which the
    // host's own gate counts.
    verifier: sharedVerifier,
    budget: sharedBudget,
  };

  return coordinator;
}

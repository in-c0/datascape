// The V5 event projection over authority history (§8).
//
// Split out of `authority-store.js` so the store — which the deployed
// authority subsystem imports — does not carry a dependency on the event
// schema outside `control/`. Granting, narrowing and revoking are history;
// draft edits and preview navigation emit nothing at all.
import { bridge } from "./bridge.js";

export function materialEvents(store) {
  return bridge(store.materialMutations(), { source_system: "continuity.authority" });
}

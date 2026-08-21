// The owner-gate REVIEW route — fixture-only, and structurally so.
//
// This module's entire import graph contains no owner-read client, no endpoint
// path and no transport: it reaches `createOwnerReadFixtureClient`, whose
// `unlock()` returns a refusal. There is nothing here to disable, because there
// is nothing here that could open a session.
//
// It owns the `?state=` fixture control. The live gate does not interpret it,
// so a query string cannot move the live surface into "unlocked" — the same
// separation the authority routes already have.

import OwnerReadGate, { PreparedReview } from "./OwnerReadGate.jsx";
import {
  createOwnerReadFixtureClient, fixtureSawOpenSession, GATE_FIXTURES,
} from "./control/owner-read-fixture-client.js";

export default function GateReviewView() {
  const requested = new URLSearchParams(window.location.search).get("state") || "locked";
  const state = GATE_FIXTURES.includes(requested) ? requested : "locked";
  const client = createOwnerReadFixtureClient(state);

  return (
    <OwnerReadGate
      client={client}
      now={client.now}
      sawOpenSession={fixtureSawOpenSession(state)}
    >
      {client.prepared
        ? <PreparedReview prepared={client.prepared} onConfirm={() => {}} onDiscard={() => {}} />
        : null}
    </OwnerReadGate>
  );
}

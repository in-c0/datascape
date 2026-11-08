// How a host answer becomes one of the gate's four states.
//
// PURE, and deliberately in its own module. It began life inside
// `owner-read-client.js`, which meant the shared gate component imported the
// transport in order to reach one label function — and that pulled the endpoint
// path and the live client into the FIXTURE route's import graph. The review
// route's whole safety claim is that its closure cannot reach a transport, so
// the convenience of one shared file quietly falsified it.
//
// Nothing here knows a path, holds a session, or can send a request.

/**
 * Which of the four gate states the host's answer means.
 *
 * `expired` is deliberately DISTINCT from `locked`, even though the host
 * reports both as `open: false`. She experiences them differently: one is a
 * door she has not opened, the other is a window that closed under her, and
 * telling her which one happened is the difference between "unlock" and "your
 * five minutes ran out — nothing was written".
 *
 * The distinction is held by the browser because only the browser knows it
 * previously saw a live window. It is a LABEL, never an authorization: no
 * combination of `sawOpenSession` can produce "unlocked" without the host
 * saying `open`.
 */
export function gateStateFrom(status, { sawOpenSession = false } = {}) {
  if (!status?.ok) return "unavailable";
  if (status.open) return "unlocked";
  return sawOpenSession ? "expired" : "locked";
}

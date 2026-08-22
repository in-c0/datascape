// The owner-read gate: the transport, the state labelling, and the structural
// separation between the live route and the fixture route.
//
// The component itself is not rendered here (there is no DOM in this suite);
// what is tested is everything the component DELEGATES, which is where a gate
// can actually lie to her.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OWNER_READ_ENDPOINT, createOwnerReadClient, gateStateFrom,
} from "../src/continuity/control/owner-read-client.js";
import {
  GATE_FIXTURES, FIXTURE_PREPARED, createOwnerReadFixtureClient, fixtureSawOpenSession,
} from "../src/continuity/control/owner-read-fixture-client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "continuity");

const reply = (status, body, ok = status < 400) => ({
  ok, status, json: async () => body,
});

test("the page cannot choose the endpoint when the transport is real", () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => reply(200, {});
  try {
    assert.throws(
      () => createOwnerReadClient({ endpoint: "http://evil.example/authority" }),
      /fixed/,
    );
    // The fixed path is still accepted, so this is a constraint and not a ban.
    assert.doesNotThrow(() => createOwnerReadClient({ endpoint: OWNER_READ_ENDPOINT }));
  } finally {
    globalThis.fetch = original;
  }
});

test("status is read from the host, and carries no session id", async () => {
  let seen = null;
  const client = createOwnerReadClient({
    endpoint: "/x",
    transport: async (url, init) => {
      seen = { url, init };
      return reply(200, { open: true, expires_at: 1000, permits: ["context"] });
    },
  });
  const status = await client.status();
  assert.equal(seen.url, "/x/status");
  assert.equal(seen.init.credentials, "same-origin");
  assert.equal(status.open, true);
  assert.equal(status.expires_at, 1000);
  // The host never sends it and the client never invents one.
  assert.equal("session_id" in status, false);
  assert.equal("read_session_id" in status, false);
});

test("a refused unlock keeps the host's named failure instead of a generic error", async () => {
  const client = createOwnerReadClient({
    endpoint: "/x",
    transport: async () => reply(429, { error: "prompt_budget_exhausted", retry_after_ms: 30000 }, false),
  });
  const result = await client.unlock();
  assert.equal(result.ok, false);
  assert.equal(result.failure, "prompt_budget_exhausted");
  assert.equal(result.retry_after_ms, 30000);
});

test("a 503 from the topology gate is 'host unavailable', not 'locked'", async () => {
  // These are different facts and she reads them differently: one means the
  // door is shut, the other means there is no door being served.
  const client = createOwnerReadClient({
    endpoint: "/x",
    transport: async () => reply(503, { error: "owner_controls_origin_incompatible" }, false),
  });
  const status = await client.status();
  assert.equal(status.ok, false);
  assert.equal(status.failure, "host_unavailable");
  assert.equal(gateStateFrom(status), "unavailable");
});

test("expired and locked are distinguished only by having seen a live window", () => {
  const closed = { ok: true, open: false };
  assert.equal(gateStateFrom(closed, { sawOpenSession: false }), "locked");
  assert.equal(gateStateFrom(closed, { sawOpenSession: true }), "expired");
  // And a live window outranks the memory either way.
  assert.equal(gateStateFrom({ ok: true, open: true }, { sawOpenSession: false }), "unlocked");
});

test("the browser's memory of a window can never produce an unlocked gate", () => {
  // The label is for her. If it could authorize, a page that set a flag would
  // draw an open door over a host that never verified anyone.
  for (const saw of [true, false]) {
    assert.notEqual(gateStateFrom({ ok: true, open: false }, { sawOpenSession: saw }), "unlocked");
    assert.notEqual(gateStateFrom({ ok: false }, { sawOpenSession: saw }), "unlocked");
  }
});

test("the fixture client cannot unlock anything", async () => {
  for (const state of GATE_FIXTURES) {
    const client = createOwnerReadFixtureClient(state);
    const result = await client.unlock();
    assert.equal(result.ok, false, `${state} must not unlock`);
    assert.equal(result.failure, "fixture_cannot_verify");
    assert.equal(client.holdsTransport, false);
  }
});

test("an unknown fixture state falls back to locked, never to unlocked", async () => {
  const client = createOwnerReadFixtureClient("../../unlocked");
  assert.equal(client.fixture, "locked");
  assert.equal((await client.status()).open, false);
});

test("the fixture's prepared panel carries the host's own prompt text", () => {
  const prepared = createOwnerReadFixtureClient("prepared").prepared;
  assert.equal(prepared.prompt_preview, FIXTURE_PREPARED.prompt_preview);
  // The first line must be one the host actually produces, so the screenshot
  // shows the real dialog wording rather than a friendlier invention.
  assert.equal(prepared.prompt_preview.split("\n")[0], "Authorize one bounded DataScape task");
});

test("only the expired fixture claims a previously open window", () => {
  assert.equal(fixtureSawOpenSession("expired"), true);
  for (const state of ["locked", "unlocked", "prepared"]) {
    assert.equal(fixtureSawOpenSession(state), false);
  }
});

/**
 * Strip comments before asserting on source.
 *
 * The first version of the two tests below matched the raw file text, so they
 * failed on this module's OWN prose — the fixture client says "there is no
 * fetch here" and the gate explains the `?state=` control it does not read. An
 * assertion that a comment can satisfy or break is not a structural check; it
 * is a lint on wording.
 */
function code(file) {
  return fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/).map((line) => line.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");
}

/** The transitive closure of relative imports, resolved from disk. */
function closureOf(entry) {
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const source = code(file);
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      queue.push(path.resolve(path.dirname(file), match[1]));
    }
  }
  return seen;
}

test("the review route's import graph contains no transport", () => {
  // Structural, in the same shape as the authority-review guarantee, and now
  // actually structural: the whole transitive closure is resolved from disk,
  // so a transport pulled in three modules deep would fail this.
  const closure = closureOf(path.join(SRC, "GateReviewView.jsx"));
  const names = [...closure].map((f) => path.basename(f));
  assert.ok(names.includes("owner-read-fixture-client.js"));
  assert.ok(!names.includes("owner-read-client.js"), `transport reachable: ${names.join(", ")}`);

  for (const file of closure) {
    assert.doesNotMatch(code(file), /fetch\s*\(/, `${path.basename(file)} can reach the network`);
    assert.doesNotMatch(code(file), /__continuity/, `${path.basename(file)} knows a host path`);
  }

  // Negative control: the LIVE route's closure must trip both of those, or the
  // assertions above are passing because they never had anything to find.
  const liveClosure = closureOf(path.join(SRC, "LiveAuthorityView.jsx"));
  const liveNames = [...liveClosure].map((f) => path.basename(f));
  assert.ok(liveNames.includes("owner-read-client.js"), "the live route must contain the transport");
  assert.ok(
    [...liveClosure].some((f) => /__continuity/.test(code(f))),
    "the live route must contain a host path",
  );
});

test("the live gate does not read the fixture query control", () => {
  for (const file of ["OwnerReadGate.jsx", "LiveAuthorityView.jsx"]) {
    assert.doesNotMatch(code(path.join(SRC, file)), /URLSearchParams/, file);
  }
  // And the gate holds no path of its own — it renders what a client reports.
  assert.doesNotMatch(code(path.join(SRC, "OwnerReadGate.jsx")), /__continuity/);
  // Negative control: the fixture ROUTE does read it, so the check can fail.
  assert.match(code(path.join(SRC, "GateReviewView.jsx")), /URLSearchParams/);
});

test("the live authority surface is mounted inside the gate", () => {
  const live = fs.readFileSync(path.join(SRC, "LiveAuthorityView.jsx"), "utf8");
  const gateAt = live.indexOf("<OwnerReadGate");
  const shellAt = live.indexOf("<AuthorityShell");
  assert.ok(gateAt !== -1 && shellAt !== -1);
  // Nesting, not adjacency: the shell must not be reachable beside the gate.
  assert.ok(gateAt < shellAt, "the authority shell must render inside the gate");
});

// The browser-bound owner-read session.
//
// The property under test is narrow and load-bearing: unlocking owner controls
// authenticates ONE BROWSER for five minutes, not the machine. The existing
// process-global read unlock would have let every local process read her
// private authority context for the duration of her window.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  COOKIE_NAME, COOKIE_PATH, MUTATION_OPERATIONS, READ_OPERATIONS, SESSION_TTL_MS,
  authenticateRequest, clearedCookie, createReadSessionStore, permitsRead, readCookie, sessionCookie,
} from "../src/continuity/control/authority-read-session.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("read session: the id has real entropy and never leaves the host", () => {
  const c = clock();
  const store = createReadSessionStore({ now: c.now });
  const opened = store.open();

  // base64url of 32 bytes: >= 256 bits.
  assert.ok(opened.session_id.length >= 43, `id too short: ${opened.session_id.length}`);
  assert.equal(Buffer.from(opened.session_id, "base64url").length, 32);

  // Two sessions never collide.
  const second = createReadSessionStore({ now: c.now }).open();
  assert.notEqual(second.session_id, opened.session_id);

  // The state surface a UI could read carries the window and nothing else.
  const state = store.state();
  assert.equal(state.open, true);
  assert.ok(!JSON.stringify(state).includes(opened.session_id), "the id must never be reportable");
});

test("read session: the cookie is HttpOnly, SameSite=Strict, path-scoped, no Domain", () => {
  const header = sessionCookie("abc123");
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, new RegExp(`Path=${COOKIE_PATH.replace(/\//g, "\\/")}`));
  assert.ok(!/Domain=/i.test(header), "a Domain attribute would widen this to sibling hosts");
  // Absolute five minutes.
  assert.match(header, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}\\b`));
  // No __Host- prefix: this deployment is plain loopback HTTP, and that prefix
  // requires Secure. Claiming a guarantee the transport cannot provide is
  // decoration, not security.
  assert.ok(!header.startsWith("__Host-"));
  assert.match(clearedCookie(), /Max-Age=0/);
});

test("read session: expiry is ABSOLUTE — reading does not extend it", () => {
  const c = clock();
  const store = createReadSessionStore({ now: c.now });
  const { session_id } = store.open();

  c.advance(4 * 60 * 1000);
  assert.ok(store.resolve(session_id), "still inside the window");
  c.advance(59 * 1000);
  assert.ok(store.resolve(session_id), "and still");
  // Those reads must NOT have pushed the deadline out.
  c.advance(2000);
  assert.equal(store.resolve(session_id), null, "five minutes means five minutes");
});

test("read session: a new unlock rotates and invalidates the old one", () => {
  const c = clock();
  const store = createReadSessionStore({ now: c.now });
  const first = store.open();
  const second = store.open();

  assert.notEqual(second.session_id, first.session_id);
  assert.equal(second.rotated_from, first.session_id);
  assert.equal(store.resolve(first.session_id), null, "the previous browser loses it");
  assert.ok(store.resolve(second.session_id));
});

test("read session: nothing survives a host restart", () => {
  const c = clock();
  const store = createReadSessionStore({ now: c.now });
  const { session_id } = store.open();
  assert.equal(store.persisted, false);

  // A restart is a new store. There is no file to read it back from.
  const afterRestart = createReadSessionStore({ now: c.now });
  assert.equal(afterRestart.resolve(session_id), null);
  assert.deepEqual(afterRestart.state(), { open: false });
});

test("read session: authentication is per-request, from the cookie", () => {
  const c = clock();
  const store = createReadSessionStore({ now: c.now });
  const { session_id } = store.open();

  assert.equal(readCookie(`${COOKIE_NAME}=${session_id}; other=x`), session_id);
  assert.equal(readCookie("other=x"), null);

  const authed = authenticateRequest({ store, cookieHeader: `${COOKIE_NAME}=${session_id}` });
  assert.equal(authed.ok, true);
  assert.equal(authed.context.principal, "owner");
  assert.equal(authed.context.read_session_id, session_id);

  // No cookie is not a principal — the substrate's construction-time
  // zero-argument authenticateCaller() would have said "owner" here.
  assert.equal(authenticateRequest({ store, cookieHeader: null }).failure, "no_read_session");
  assert.equal(authenticateRequest({ store, cookieHeader: `${COOKIE_NAME}=wrong` }).failure, "read_session_invalid");

  // And a same-length forgery is still not it.
  const forged = "A".repeat(session_id.length);
  assert.equal(authenticateRequest({ store, cookieHeader: `${COOKIE_NAME}=${forged}` }).failure, "read_session_invalid");
});

test("read session: reads are permitted, mutations are structurally excluded", () => {
  for (const op of READ_OPERATIONS) assert.equal(permitsRead(op), true, op);
  // Listed explicitly rather than inferred, so a mutation added later cannot
  // inherit read authority merely by being absent from a deny list.
  for (const op of MUTATION_OPERATIONS) assert.equal(permitsRead(op), false, op);
  assert.equal(READ_OPERATIONS.filter((op) => MUTATION_OPERATIONS.includes(op)).length, 0,
    "the two sets must not overlap");
});

test("read session: the source carries no path to disk or to a token log", () => {
  const source = fs.readFileSync(
    new URL("../src/continuity/control/authority-read-session.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/writeFileSync|appendFileSync|localStorage|sessionStorage/.test(source),
    "a session that reaches disk or browser storage is not process-memory-only");
  assert.ok(!/console\.(log|info|warn|error)/.test(source), "and it must never be logged");
});

// Resolving the V6 blocker after a verified authority transaction.
//
// A.2.2 made the store refuse every exit from `blocked-on-owner`. The authority
// journal resolves its source blocker through that same path, so without this
// adapter the FIRST real authorization would have thrown owner_ruling_required
// while trying to close its own blocker — a live bug created by a correct fix.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createAuthorityExceptionAdapter } from "../src/continuity/control/authority-exception-adapter.js";
import * as atomic from "../src/continuity/control/exception-atomic.js";
import { patchExceptionSource } from "../ops/exception-guard-patch.mjs";

function inbox(status = "blocked-on-owner") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "authority-inbox-"));
  const id = "2026-08-21-datascape-v6-execution-authority-b4e2";
  fs.writeFileSync(path.join(dir, `${id}.md`), [
    "---", `id: ${id}`, "loop: datascape/v6", "title: Execution authority",
    "severity: high", `status: ${status}`, "fingerprint: v6-authority",
    "opened: 2026-08-21T20:00:00+10:00", "updated: 2026-08-21T23:43:25+10:00",
    "occurrences: 1", "---", "", "# Execution authority", "",
  ].join("\n"));
  return { dir, id };
}

let tick = 0;
const now = () => `2026-08-22T12:0${tick++}:00+10:00`;

test("adapter: a verified authority resolves its own blocker", () => {
  const { dir, id } = inbox();
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });

  const result = adapter.resolve(id, "authority:abc123", { note: "one bounded task" });
  assert.equal(result.ok, true);
  assert.equal(result.replayed, false);
  assert.equal(result.status, "resolved");

  const body = fs.readFileSync(path.join(dir, `${id}.md`), "utf8");
  assert.match(body, /^status: resolved$/m);
  assert.match(body, /OWNER AUTHORIZED .* \[authority:abc123\]/);
  assert.match(body, /one bounded task/);
});

test("adapter: recovery replaying the SAME ref writes nothing twice", () => {
  const { dir, id } = inbox();
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });

  adapter.resolve(id, "authority:same");
  const after = fs.readFileSync(path.join(dir, `${id}.md`), "utf8");

  // The journal resolves between the durable authority write and the committed
  // marker, so recovery calls this again as a matter of course.
  const replay = adapter.resolve(id, "authority:same");
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(fs.readFileSync(path.join(dir, `${id}.md`), "utf8"), after,
    "an idempotent resolution must not append a second amendment");
  assert.equal((after.match(/OWNER AUTHORIZED/g) ?? []).length, 1);
});

test("adapter: a DIFFERENT authority cannot resolve an already-authorized blocker", () => {
  const { dir, id } = inbox();
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });
  adapter.resolve(id, "authority:first");
  const after = fs.readFileSync(path.join(dir, `${id}.md`), "utf8");

  const second = adapter.resolve(id, "authority:second");
  assert.equal(second.ok, false);
  assert.equal(second.failure, "already_authorized");
  assert.deepEqual(second.existing_refs, ["authority:first"]);
  assert.equal(fs.readFileSync(path.join(dir, `${id}.md`), "utf8"), after,
    "two authorities claiming one blocker is something to look at, not to race");
});

test("adapter: the crash invariant — resolved implies a visible authority ref", () => {
  const { dir, id } = inbox();
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });

  // Before: open, and no authority visible.
  const before = adapter.inspect(id);
  assert.equal(before.status, "blocked-on-owner");
  assert.deepEqual(before.refs, []);

  adapter.resolve(id, "authority:invariant");

  // After: resolved, WITH the exact authority that resolved it. The forbidden
  // third state is resolved-with-no-authority, which a single atomic write is
  // what prevents — the status and the ref land together or not at all.
  const after = adapter.inspect(id);
  assert.equal(after.status, "resolved");
  assert.deepEqual(after.refs, ["authority:invariant"]);
});

test("adapter: one atomic write — never in place, exactly one rename", () => {
  const { dir, id } = inbox();
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });
  const target = path.join(dir, `${id}.md`);

  const inPlace = [];
  const renames = [];
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  fs.writeFileSync = (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(target)) inPlace.push(String(file));
    return realWrite(file, ...rest);
  };
  fs.renameSync = (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(target)) renames.push(String(to));
    return realRename(from, to, ...rest);
  };
  try {
    adapter.resolve(id, "authority:atomic");
  } finally {
    fs.writeFileSync = realWrite;
    fs.renameSync = realRename;
  }
  assert.equal(inPlace.length, 0, "a reader must never see half a resolution");
  assert.equal(renames.length, 1, "status and authority ref land together");
});

test("adapter: it does NOT reopen the path the store guard closed", async () => {
  // The guard refuses every exit from blocked-on-owner. The adapter writes the
  // file directly rather than calling setStatus, which is the whole reason it
  // exists — so the guard must still be refusing while the adapter works.
  const { dir, id } = inbox();
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "guarded-store-"));
  const store = path.join(storeDir, "exception.mjs");
  fs.writeFileSync(store, patchExceptionSource(
    fs.readFileSync(path.join(process.cwd(), "ops", "prb-exception-stand-in.mjs"), "utf8")).source);

  process.env.EXCEPTION_INBOX = dir;
  const guarded = await import(pathToFileURL(store).href);
  assert.throws(() => guarded.setStatus(id, "resolved"),
    (error) => error.code === "owner_ruling_required",
    "the supported store path is still shut");

  // And the private adapter, which is not a supported interface, gets through.
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });
  assert.equal(adapter.resolve(id, "authority:not-a-bypass").ok, true);
});

test("adapter: nothing user-facing imports it", () => {
  // Its safety is that it is unreachable, not that it checks a credential —
  // a ref parameter would be the bearer capability we deleted from the guard.
  const facing = [
    "ops/live-host/briefing-server.mjs",
    "ops/live-host/briefing-server-core.mjs",
    "ops/live-host/authority-host.mjs",
    "ops/owner-rule.mjs",
    "src/continuity/actions.js",
  ];
  for (const file of facing) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.ok(!/authority-exception-adapter/.test(source),
      `${file} must not reach the private resolution adapter`);
  }

  const adapter = fs.readFileSync(
    new URL("../src/continuity/control/authority-exception-adapter.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/verifiedRefs|new Set\(|registerVerified/.test(adapter),
    "no registry of refs, and no credential to present");
});

// ---------------------------------------------------------------------------
// The complete postcondition, not just the ref
// ---------------------------------------------------------------------------

/** Put an exception into an arbitrary (status, refs) state. */
function stateWith({ status, refs = [] }) {
  const { dir, id } = inbox(status);
  if (refs.length) {
    const file = path.join(dir, `${id}.md`);
    const body = refs
      .map((ref) => `OWNER AUTHORIZED 2026-08-22T11:00:00+10:00 (via datascape/authority) [${ref}]`)
      .join("\n");
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n${body}\n`);
  }
  return { dir, id };
}

test("adapter: our ref present but NOT resolved is inconsistent, not a replay", () => {
  // The exact shape a crash between the ref landing and the status changing
  // would leave. Keying only on the ref called this "already done".
  for (const status of ["blocked-on-owner", "investigating"]) {
    const { dir, id } = stateWith({ status, refs: ["authority:half"] });
    const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });
    const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf8");

    const result = adapter.resolve(id, "authority:half");
    assert.equal(result.ok, false, status);
    assert.equal(result.failure, "inconsistent_resolution", status);
    assert.equal(fs.readFileSync(path.join(dir, `${id}.md`), "utf8"), before, "and it writes nothing");
  }
});

test("adapter: an item that is not owner-gated accepts no first authority", () => {
  for (const status of ["resolved", "investigating", "new"]) {
    const { dir, id } = stateWith({ status });
    const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });
    const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf8");

    const result = adapter.resolve(id, "authority:unwanted");
    assert.equal(result.ok, false, status);
    assert.equal(result.failure, "not_owner_gated", status);
    assert.equal(result.status, status);
    assert.equal(fs.readFileSync(path.join(dir, `${id}.md`), "utf8"), before,
      "an authority resolution must not be appended to something nobody is waiting on");
  }
});

test("adapter: resolved with our exact ref replays without writing", () => {
  const { dir, id } = stateWith({ status: "resolved", refs: ["authority:done"] });
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });
  const before = fs.readFileSync(path.join(dir, `${id}.md`), "utf8");

  const result = adapter.resolve(id, "authority:done");
  assert.equal(result.ok, true);
  assert.equal(result.replayed, true);
  assert.equal(fs.readFileSync(path.join(dir, `${id}.md`), "utf8"), before);
});

test("adapter: blocked-on-owner with no ref is the ONLY state that writes", () => {
  const { dir, id } = stateWith({ status: "blocked-on-owner" });
  const adapter = createAuthorityExceptionAdapter({ inbox: dir, now, atomic });

  const result = adapter.resolve(id, "authority:only-path");
  assert.equal(result.ok, true);
  assert.equal(result.replayed, false);
  assert.equal(result.status, "resolved");

  const after = adapter.inspect(id);
  assert.equal(after.status, "resolved");
  assert.deepEqual(after.refs, ["authority:only-path"]);
});

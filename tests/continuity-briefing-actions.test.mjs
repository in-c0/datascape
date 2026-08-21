// The client half of the closed action protocol.
//
// The host is proven through the real transport in the acceptance suite. What
// is proven here is that the BROWSER sends a class rather than a phrase, and
// that a retry after an ambiguous response carries the same operation id.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { ACTIONS, operationIdFor, retireOperationId } from "../src/continuity/actions.js";

const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const view = strip(fs.readFileSync(new URL("../src/continuity/BriefingView.jsx", import.meta.url), "utf8"));

test("actions: the client vocabulary is the six closed classes", () => {
  assert.deepEqual(Object.keys(ACTIONS),
    ["approve", "reply_done", "reply_no", "reply_need_context", "defer", "dismiss"]);
  assert.equal(ACTIONS.reply, undefined, "the generic reply class is gone, not deprecated");
  // Only one class carries editable text, and it is the one bound into the prompt.
  assert.deepEqual(Object.entries(ACTIONS).filter(([, s]) => s.needsNote).map(([k]) => k),
    ["reply_need_context"]);
});

test("actions: the chips send a class, never their label", () => {
  // The old code was `run("reply", { note: chip })` over a list of strings —
  // the host then had to recover Done / No / Need context from prose.
  assert.ok(!/run\(\s*["']reply["']/.test(view), "no caller sends the generic reply class");
  assert.match(view, /REPLY_CHIPS\s*=\s*\[[\s\S]*key:\s*"reply_done"[\s\S]*key:\s*"reply_no"[\s\S]*key:\s*"reply_need_context"/);
  assert.match(view, /run\(chip\.key/, "the chip's class is what is sent");
  // Typed words are an explicit class too.
  assert.match(view, /run\("reply_need_context",\s*\{\s*note:\s*text\s*\}\)/);
});

test("actions: a retry after an ambiguous response reuses the operation id", () => {
  // sessionStorage is what makes this survive the reload it exists for.
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  const intent = { id: "x-1", action: "reply_done", note: "", until: null };
  const first = operationIdFor(intent);
  assert.equal(operationIdFor({ ...intent }), first, "the same ruling retries as the same operation");
  assert.notEqual(operationIdFor({ ...intent, action: "dismiss" }), first,
    "a different ruling is a different intent");

  // The page reloads: module state is gone, storage is not. This is the exact
  // failure the persistence exists for — the ruling committed, the response was
  // lost, and a fresh id would make the host prompt her all over again.
  assert.ok(store.get("continuity.pendingOwnerOperations").includes(first));
  const reloaded = new Map(Object.entries(JSON.parse(store.get("continuity.pendingOwnerOperations"))));
  assert.equal(reloaded.get(JSON.stringify(intent)), first);

  // Once its fate is known the id is retired, so a later identical ruling is new.
  retireOperationId(intent);
  assert.notEqual(operationIdFor(intent), first);
  delete globalThis.sessionStorage;
});

test("actions: no verification result is ever persisted in the browser", () => {
  const source = strip(fs.readFileSync(new URL("../src/continuity/actions.js", import.meta.url), "utf8"));
  // Only the unprivileged correlation id may be stored. Anything derived from
  // owner presence living in browser storage would be a transferable
  // credential with extra steps.
  const stored = source.match(/setItem\([^)]*\)/g) ?? [];
  assert.equal(stored.length, 1, "exactly one thing is persisted");
  assert.match(stored[0], /OPERATION_STORE_KEY/);
  for (const forbidden of ["verified", "presence", "token", "nonce", "proof", "signature"]) {
    assert.ok(!new RegExp(`setItem[^)]*${forbidden}`, "i").test(source), `${forbidden} must not be persisted`);
  }
});

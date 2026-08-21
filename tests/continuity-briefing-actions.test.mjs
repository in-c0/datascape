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
  const intent = { id: "x-1", action: "reply_done", note: "", until: null };
  const first = operationIdFor(intent);
  assert.equal(operationIdFor({ ...intent }), first, "the same ruling retries as the same operation");

  // A different ruling is a different intent.
  assert.notEqual(operationIdFor({ ...intent, action: "dismiss" }), first);

  // Once it has landed the id is retired, so a later identical ruling is new.
  retireOperationId(intent);
  assert.notEqual(operationIdFor(intent), first);
});

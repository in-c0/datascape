// The owner-gated exception rule gets provenance.
//
// Every test here operates on a TEMPORARY COPY. The real `D:\Projects\CLAUDE.md`
// is never read for mutation and never written, because this PR is held and a
// held PR does not edit the instruction file every lane on the machine reads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BEGIN, END, FIRST_INSTALL_ANCHOR, canonicalText, locateBlock, planSync, renderBlock, sync, unmanagedDelta,
} from "../ops/claude-policy-sync.mjs";

/** A document shaped like CLAUDE.md, without being it. */
const DOCUMENT = [
  "# Working anywhere under D:\\Projects",
  "",
  "Some preamble that belongs to somebody else.",
  "",
  "## 3. An owner-action exists as an exception, or it does not exist",
  "",
  "Statuses: `new` - `investigating` - `blocked-on-owner` - `resolved`. Use",
  "`blocked-on-owner` whenever the next step is hers - filing it as `investigating`",
  "hides it from the only list she reads.",
  "",
  "## 4. Money",
  "",
  "One ledger, append-only.",
  "",
].join("\n");

function tempCopy(contents = DOCUMENT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-md-"));
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, contents);
  return { dir, file, backups: path.join(dir, "backups") };
}

test("policy: the canonical text lives in version control, not in the instruction file", () => {
  const text = canonicalText();
  assert.match(text, /Never move a `blocked-on-owner` exception/);
  assert.match(text, /Do not bypass the owner gate by editing status files directly/);
  // The rule the machine actually enforces must be the rule the document states.
  assert.match(text, /owner_ruling_required/);
});

test("policy: first install lands after the anchor and changes nothing else", () => {
  const plan = planSync(DOCUMENT);
  assert.equal(plan.ok, true);
  assert.equal(plan.action, "installed");
  assert.equal(unmanagedDelta(DOCUMENT, plan.document), 0, "nothing outside the block may move");

  const found = locateBlock(plan.document);
  assert.equal(found.state, "present");
  assert.equal(found.current, renderBlock());
  // Placed where the anchor is, not at some line number that drifts.
  assert.ok(plan.document.indexOf(BEGIN) > plan.document.indexOf(FIRST_INSTALL_ANCHOR));
  assert.ok(plan.document.indexOf(BEGIN) < plan.document.indexOf("## 4. Money"));
  // And somebody else's writing is still there, verbatim.
  assert.ok(plan.document.includes("Some preamble that belongs to somebody else."));
  assert.ok(plan.document.includes("One ledger, append-only."));
});

test("policy: a second sync is byte-stable", () => {
  const once = planSync(DOCUMENT).document;
  const twice = planSync(once);
  assert.equal(twice.ok, true);
  assert.equal(twice.changed, false, "an unchanged document must not be rewritten");
  assert.equal(twice.action, "already_current");
  assert.equal(twice.document, once);
});

test("policy: a stale block is replaced in place, and only the block", () => {
  const installed = planSync(DOCUMENT).document;
  const stale = installed.replace(canonicalText(), "an older version of the rule");
  assert.notEqual(stale, installed);

  const plan = planSync(stale);
  assert.equal(plan.action, "updated");
  assert.equal(plan.document, installed);
  assert.equal(unmanagedDelta(stale, plan.document), 0);
});

test("policy: hand edits outside the block survive a sync", () => {
  const installed = planSync(DOCUMENT).document;
  const edited = installed
    .replace("One ledger, append-only.", "One ledger, append-only. AND SOMETHING SHE ADDED.")
    .replace(canonicalText(), "drifted");

  const plan = planSync(edited);
  assert.equal(plan.ok, true);
  assert.ok(plan.document.includes("AND SOMETHING SHE ADDED."),
    "her words outside the block are not ours to reconcile");
  assert.equal(locateBlock(plan.document).current, renderBlock());
});

test("policy: ambiguity refuses rather than repairing", () => {
  const installed = planSync(DOCUMENT).document;

  // Two blocks. Which one is authoritative is not a question a sync tool gets
  // to answer by itself.
  const doubled = installed + "\n" + renderBlock();
  const twoBlocks = planSync(doubled);
  assert.equal(twoBlocks.ok, false);
  assert.equal(twoBlocks.failure, "ambiguous_markers");

  // A begin with no end.
  const halfOpen = installed.replace(END, "");
  assert.equal(planSync(halfOpen).failure, "ambiguous_markers");

  // Crossed markers.
  const crossed = `${DOCUMENT}\n${END}\nstuff\n${BEGIN}\n`;
  assert.equal(planSync(crossed).failure, "ambiguous_markers");
});

test("policy: a first install with no recognised anchor refuses", () => {
  const foreign = "# Someone else's document\n\nNothing familiar here.\n";
  const plan = planSync(foreign);
  assert.equal(plan.ok, false);
  assert.equal(plan.failure, "anchor_not_found");

  // And an anchor that appears twice is not an anchor.
  const twice = `${DOCUMENT}\n\n${FIRST_INSTALL_ANCHOR}\n`;
  assert.equal(planSync(twice).failure, "anchor_ambiguous");
});

test("policy: a dry run writes nothing", () => {
  const { file } = tempCopy();
  const before = fs.readFileSync(file, "utf8");

  const result = sync({ file, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true, "there IS something to do");
  assert.equal(result.wrote, false);
  assert.equal(result.dry_run, true);
  assert.equal(fs.readFileSync(file, "utf8"), before, "and it did none of it");
});

test("policy: writing backs up the exact previous bytes first", () => {
  const { file, backups } = tempCopy();
  const before = fs.readFileSync(file, "utf8");

  const result = sync({ file, dryRun: false, backupDir: backups });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.equal(result.unmanaged_bytes_changed, 0);
  assert.equal(fs.readFileSync(result.backup, "utf8"), before,
    "the previous bytes must be recoverable exactly");
  assert.equal(locateBlock(fs.readFileSync(file, "utf8")).current, renderBlock());

  // Idempotent on disk too.
  const second = sync({ file, dryRun: false, backupDir: backups });
  assert.equal(second.changed, false);
  assert.equal(second.wrote, false);
});

test("policy: the real CLAUDE.md is never a test target", () => {
  // This PR is held. The real instruction file is synchronised after merge, not
  // while a reviewer is still looking at the diff.
  const source = fs.readFileSync(new URL("./continuity-claude-policy-sync.test.mjs", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/sync\(\{\s*dryRun:\s*false\s*\}\)/.test(source),
    "every write in this suite must name an explicit temporary file");
  assert.ok(!/D:\\\\Projects\\\\CLAUDE\.md/.test(source), "and never the real path");
});

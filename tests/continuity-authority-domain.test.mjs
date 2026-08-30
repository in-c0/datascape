// The stable authority domain, and what the read surface may show.
//
// The property under test is STABILITY across the one transition that breaks
// naive implementations: a successful grant RESOLVES the blocker it came from,
// so "the blocked-on-owner exception for this loop" stops matching exactly when
// the authority starts existing.
import test from "node:test";
import assert from "node:assert/strict";

import {
  publicBlocker, readExceptionIndex, resolveAuthorityDomain, scopeCatalogue,
} from "../src/continuity/control/authority-domain.js";

const LOOP = "datascape/v6-execution-authority";

const entry = (id, { loop = LOOP, status = "blocked-on-owner", title = "t" } = {}) => ({
  meta: { id, loop, status, title, severity: "medium" },
  body: `\n# ${title}\n\n## Evidence\n\nwhat was seen\n\n## Proposed action\n\nwhat should happen\n\n## Owner steps\n\n- do a thing\n`,
});

test("the domain survives the grant that resolves its blocker", () => {
  // BEFORE: one open blocker.
  const open = [entry("exc-a")];
  const before = resolveAuthorityDomain({ entries: open, loop: LOOP });
  assert.equal(before.ok, true);
  assert.equal(before.domain, "exc-a");

  // AFTER: the same exception, now resolved by the grant, and the journal holds
  // lineage for it. The domain must be identical — otherwise a reload shows her
  // an empty screen with a live authority sitting behind it.
  const closed = [{ ...entry("exc-a"), meta: { ...entry("exc-a").meta, status: "resolved" } }];
  const after = resolveAuthorityDomain({
    entries: closed, loop: LOOP, hasLineage: (id) => id === "exc-a",
  });
  assert.equal(after.ok, true);
  assert.equal(after.domain, before.domain);
});

test("a governed exception wins over a newer open one", () => {
  // A second blocker filed in the same loop must not silently move the domain
  // out from under an authority she already granted.
  const entries = [entry("exc-a", { status: "resolved" }), entry("exc-b")];
  const found = resolveAuthorityDomain({
    entries, loop: LOOP, hasLineage: (id) => id === "exc-a",
  });
  assert.equal(found.ok, true);
  assert.equal(found.domain, "exc-a");
});

test("two candidates REFUSE rather than picking one", () => {
  // Picking the first would make the domain depend on directory order.
  const entries = [entry("exc-a"), entry("exc-b")];
  const found = resolveAuthorityDomain({ entries, loop: LOOP });
  assert.equal(found.ok, false);
  assert.equal(found.failure, "ambiguous_authority_domain");
  assert.deepEqual(found.candidates, ["exc-a", "exc-b"]);
});

test("an unconfigured loop refuses by name, and never guesses", () => {
  const entries = [entry("exc-a")];
  const found = resolveAuthorityDomain({ entries, loop: null });
  assert.equal(found.ok, false);
  assert.equal(found.failure, "no_authority_loop");
  assert.equal(found.domain, undefined);
});

test("other loops are invisible to this domain", () => {
  const entries = [entry("exc-a", { loop: "sumzup/publish" }), entry("exc-b", { loop: "gyeol-ip/g1" })];
  const found = resolveAuthorityDomain({ entries, loop: LOOP });
  assert.equal(found.ok, false);
  assert.equal(found.failure, "no_authority_domain");
});

test("the blocker view exposes named fields and the two sections, not the file", () => {
  const view = publicBlocker(entry("exc-a", { title: "the ask" }));
  assert.equal(view.id, "exc-a");
  assert.equal(view.title, "the ask");
  assert.equal(view.evidence, "what was seen");
  assert.equal(view.proposed, "what should happen");
  // The rest of the document stays on disk.
  assert.equal(view.body, undefined);
  assert.equal(view.fingerprint, undefined);
  assert.ok(!JSON.stringify(view).includes("Owner steps"));
});

test("the catalogue is EMPTY and says why, rather than inventing scopes", () => {
  // This test asserted the opposite until the governing review pointed out two
  // problems with a loop-derived catalogue. The shape was incompatible — the
  // authoring surface reads `entry.labels` — so a non-empty catalogue would
  // have broken the screen it was meant to fill. And an exception loop is not
  // an authority scope: V6 resolution works on repo / semantic-centre / topic
  // refs the admission machinery can compare, so loop names would have offered
  // boundaries nothing downstream could enforce.
  const result = scopeCatalogue();
  assert.deepEqual(result.catalogue, []);
  assert.equal(result.scope_catalogue_ready, false);
  assert.match(result.reason, /not authority scope references/);
});

test("an unreadable exception makes the domain UNRESOLVABLE, not unique", () => {
  // The dangerous shape: one readable candidate plus one file we cannot read.
  // Skipping the unreadable one silently turns "I cannot tell whether this is
  // unique" into "this is unique", and selects an authority domain on the
  // strength of not having been able to check.
  const fs = {
    readdirSync: () => ["good.md", "broken.md"],
    readFileSync: (file) => {
      if (String(file).includes("broken")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return "---\nid: exc-a\nloop: target\nstatus: blocked-on-owner\n---\n\nbody\n";
    },
  };
  const parseException = (raw) => {
    const meta = {};
    for (const line of raw.split("\n")) {
      const at = line.indexOf(":");
      if (at > 0 && !line.startsWith("-")) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return { meta, body: raw };
  };

  const { entries, unreadable } = readExceptionIndex({ fs, inbox: "/x", parseException });
  assert.equal(entries.length, 1, "the readable one is still available for display");
  assert.deepEqual(unreadable.map((u) => u.file), ["broken.md"]);

  // Display may degrade. Authority selection may not.
  const resolved = resolveAuthorityDomain({ entries, unreadable, loop: "target" });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.failure, "authority_index_incomplete");
  assert.equal(resolved.domain, undefined);

  // NEGATIVE CONTROL: with every file readable, the same index resolves.
  const clean = resolveAuthorityDomain({ entries, unreadable: [], loop: "target" });
  assert.equal(clean.ok, true);
  assert.equal(clean.domain, "exc-a");
});

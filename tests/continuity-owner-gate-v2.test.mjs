// V6.1.6-A.2.2 — the owner gate is self-contained, and the store is relocatable
// again.
//
// V1 injected `import { checkTransition } from "./_continuity/owner-gate.js"`
// into the host's exception store. Correct in place, wrong everywhere else: the
// store stopped being loadable from any other directory, and
// `exception.selftest.mjs` — which copies it to a temp directory — failed to
// load at all. A file every lane depends on that only works from one path is a
// trap for whoever moves it next.
//
// So relocatability is a release invariant here, and the store's own selftest is
// part of the deployment gate rather than something somebody remembers to run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deployedWorld } from "../ops/prb-deploy-world.mjs";
import { GUARD_V2_MARKER, classifyGuard, patchExceptionSource } from "../ops/exception-guard-patch.mjs";

const STORE = () => fs.readFileSync(path.join(process.cwd(), "ops", "prb-exception-stand-in.mjs"), "utf8");

/** The V1 patch, reconstructed exactly as the shipped version produced it. */
function installV1(source) {
  const marker = "__continuity_owner_gate__";
  const importLine = `import { checkTransition as ${marker} } from "./_continuity/owner-gate.js"\n`;
  const body = `
  // ${marker}: leaving \`blocked-on-owner\` records an owner decision.
  // Installed by ops/exception-guard-patch.mjs — see src/continuity/control/owner-gate.js.
  {
    const __e = find(id)
    const __v = ${marker}({ from: __e?.meta?.status, to: status })
    if (!__v.ok) {
      const __err = new Error(__v.reason + "\\n" + __v.remedy)
      __err.code = __v.failure
      throw __err
    }
  }
`;
  const signature = /export function setStatus\(id, status, note = ""\) \{\n/;
  const match = source.match(signature);
  const lastImport = source.lastIndexOf("\nimport ");
  const importEnd = source.indexOf("\n", lastImport + 1) + 1;
  const withImport = source.slice(0, importEnd) + importLine + source.slice(importEnd);
  const at = withImport.indexOf(match[0]) + match[0].length;
  return withImport.slice(0, at) + body + withImport.slice(at);
}

// ---------------------------------------------------------------------------
// Classification, migration, idempotence
// ---------------------------------------------------------------------------

test("guard: the store is classified by its actual body, not by a marker substring", () => {
  const clean = STORE();
  assert.equal(classifyGuard(clean).version, "unpatched");

  const v1 = installV1(clean);
  assert.equal(classifyGuard(v1).version, "v1");

  const v2 = patchExceptionSource(clean).source;
  assert.equal(classifyGuard(v2).version, "v2");

  // A marker with no recognised body is exactly what a half-applied patch or a
  // hand-edit leaves behind. `source.includes(GUARD_MARKER)` called that
  // "already patched" and moved on.
  const fake = clean.replace("export function setStatus", `// __continuity_owner_gate__\nexport function setStatus`);
  assert.equal(classifyGuard(fake).version, "ambiguous");
  assert.equal(patchExceptionSource(fake).ok, false);

  // Both versions present at once is ambiguous too, not "the newer one wins".
  assert.equal(classifyGuard(v1 + v2).version, "ambiguous");
});

test("guard: V2 imports nothing, so the store stays self-contained", () => {
  const v2 = patchExceptionSource(STORE()).source;
  // The MARKER itself contains "_continuity" as a substring, so a bare
  // `includes` check would match the very guard it is meant to vet. Assert on
  // imports, which is what the invariant is actually about.
  assert.ok(!/from\s+["'][^"']*_continuity/.test(v2),
    "the deployed store must not depend on the security layer");
  assert.ok(!/import[^\n]*owner-gate/.test(v2));
  assert.ok(v2.includes(GUARD_V2_MARKER));
});

test("guard: V1 migrates to V2 and touches nothing else", () => {
  const clean = STORE();
  const v1 = installV1(clean);
  const migrated = patchExceptionSource(v1);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.from, "v1");
  assert.equal(migrated.migrated, true);
  assert.equal(classifyGuard(migrated.source).version, "v2");
  assert.ok(!/from\s+["'][^"']*_continuity/.test(migrated.source),
    "migration must remove the injected import, not merely the body");

  // Every byte that is not the guard survives the migration. Proven by
  // convergence rather than by a strip regex: migrating a V1 store must land on
  // exactly the bytes that patching the clean store produces. If migration
  // disturbed anything else, or left any V1 residue, these differ.
  assert.equal(migrated.source, patchExceptionSource(clean).source,
    "a migrated store and a freshly patched store must be byte-identical");
});

test("guard: applying V2 to a V2 store is byte-for-byte identical", () => {
  const once = patchExceptionSource(STORE()).source;
  const twice = patchExceptionSource(once);
  assert.equal(twice.ok, true);
  assert.equal(twice.already, true);
  assert.equal(twice.source, once, "a redeploy must not drift the bytes a rollback target depends on");
});

// ---------------------------------------------------------------------------
// The property that was broken: a copied store still works
// ---------------------------------------------------------------------------

test("guard: a V2 store copied ALONE imports and enforces the gate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relocated-"));
  const inbox = path.join(dir, "exceptions");
  fs.mkdirSync(inbox, { recursive: true });
  const store = path.join(dir, "exception.mjs");
  fs.writeFileSync(store, patchExceptionSource(STORE()).source);

  // No `_continuity/` anywhere near it — the situation the selftest creates.
  process.env.EXCEPTION_INBOX = inbox;
  const mod = await import(pathToFileURL(store).href);

  const write = (id, status) => fs.writeFileSync(path.join(inbox, `${id}.md`), [
    "---", `id: ${id}`, "loop: relocated", "title: t", "severity: low",
    `status: ${status}`, "fingerprint: f", "opened: 2026-08-22T08:00:00+10:00",
    "updated: 2026-08-22T08:00:00+10:00", "occurrences: 1", "---", "", "# t", "",
  ].join("\n"));

  // Refused out of blocked-on-owner, in every direction.
  for (const to of ["resolved", "investigating", "new"]) {
    const id = `2026-08-22-relocated-${to}`;
    write(id, "blocked-on-owner");
    assert.throws(() => mod.setStatus(id, to), (e) => e.code === "owner_ruling_required", `-> ${to}`);
  }

  // Ordinary lane work still passes, including raising a new gate.
  write("2026-08-22-relocated-open", "new");
  assert.equal(mod.setStatus("2026-08-22-relocated-open", "investigating"), "2026-08-22-relocated-open");
  write("2026-08-22-relocated-raise", "investigating");
  assert.equal(mod.setStatus("2026-08-22-relocated-raise", "blocked-on-owner"), "2026-08-22-relocated-raise");
});

// ---------------------------------------------------------------------------
// The deployment transaction
// ---------------------------------------------------------------------------

test("deploy: the store's OWN selftest passes against the deployed V2 store", async () => {
  const world = await deployedWorld();
  try {
    const result = world.selftest();
    if (result.skipped) return; // no real host here (CI); the unit tests above still bind.
    assert.equal(result.ok, true, result.out.slice(-600));
    assert.equal(result.passed, 46, "the store's own selftest must be unchanged by guarding it");
  } finally { await world.close(); }
});

test("deploy: migrating a V1 host keeps the ORIGINAL preimage, not the V1 bytes", async () => {
  const world = await deployedWorld();
  try {
    const original = world.storeBefore;
    // Put the world back into the V1 shape the live host is actually in.
    const storePath = path.join(world.live, "exception.mjs");
    fs.writeFileSync(storePath, installV1(original));
    fs.mkdirSync(path.join(world.live, "_continuity"), { recursive: true });
    fs.writeFileSync(path.join(world.live, "_continuity", "owner-gate.js"),
      "export function checkTransition() { return { ok: true } }\n");

    const migrated = await world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    assert.equal(migrated.exception_store.migrated_from, "v1");
    assert.equal(migrated.exception_store.original_preimage_hash,
      world.deployed.exception_store.original_preimage_hash,
      "the pre-Continuity original must survive a migration");
    assert.notEqual(migrated.exception_store.previous_release_hash,
      migrated.exception_store.original_preimage_hash,
      "one release back and the original are different facts");

    // The retired V1 dependency is gone, and only after the store stopped
    // importing it.
    assert.deepEqual(migrated.retired, ["_continuity/owner-gate.js"]);
    assert.equal(fs.existsSync(path.join(world.live, "_continuity", "owner-gate.js")), false);
    assert.equal(classifyGuard(fs.readFileSync(storePath, "utf8")).version, "v2");
  } finally { await world.close(); }
});

test("deploy: an unclassifiable store refuses the whole deployment", async () => {
  const world = await deployedWorld();
  try {
    const storePath = path.join(world.live, "exception.mjs");
    const before = fs.readFileSync(storePath, "utf8");
    fs.writeFileSync(storePath, `// ${GUARD_V2_MARKER} someone was here\n${world.storeBefore}`);

    const attempt = await world.deployMod.deploy({ commit: world.commit, dryRun: false, liveDir: world.live });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.store_version, "ambiguous");
    assert.notEqual(fs.readFileSync(storePath, "utf8"), before,
      "the sabotage is still there — the point is that deployment did not paper over it");
  } finally { await world.close(); }
});

test("deploy: rollback restores the exact previous release bytes", async () => {
  const world = await deployedWorld();
  try {
    const storePath = path.join(world.live, "exception.mjs");
    const v2 = fs.readFileSync(storePath, "utf8");
    assert.equal(classifyGuard(v2).version, "v2");

    const rolled = world.deployMod.rollback({ toBackupSet: world.deployed.backup_set, dryRun: false });
    assert.equal(rolled.ok, true);
    assert.equal(fs.readFileSync(storePath, "utf8"), world.storeBefore);
    assert.equal(classifyGuard(world.storeBefore).version, "unpatched");
  } finally { await world.close(); }
});

test("deploy: a V1 store is not treated as guarded by the startup gate", async () => {
  const world = await deployedWorld();
  try {
    fs.writeFileSync(path.join(world.live, "exception.mjs"), installV1(world.storeBefore));
    const gate = world.deployMod.preflight({ liveDir: world.live });
    assert.equal(gate.ok, false);
    assert.equal(gate.exception_store_guarded, false);
    assert.match(gate.reason, /V1 imported guard|non-relocatable/);

    // And the host refuses to rule on it.
    const started = await world.launch();
    assert.equal(started.mode, "read_only");
  } finally { await world.close(); }
});

// Install the owner gate into the host's exception store.
//
// `_ship_inbox/ops/exception.mjs` is unversioned host code shared by every
// lane, and it owns the only mutation point that can move an item out of
// `blocked-on-owner`. Wrapping it from outside does not work: its own CLI calls
// its own internal `setStatus`, so a front door that re-exports a guarded
// version guards nothing.
//
// So deployment applies a small, exact, idempotent patch, and records the
// before and after hashes as deployment evidence. This is honest about what it
// is — a patch to somebody else's file — rather than pretending the store is
// ours. The patch is reviewed here, in version control, and refuses to apply to
// a source it does not recognise.
export const GUARD_MARKER = "__continuity_owner_gate__";

const IMPORT_LINE =
  `import { checkTransition as ${GUARD_MARKER} } from "./_continuity/owner-gate.js"\n`;

const GUARD_BODY = `
  // ${GUARD_MARKER}: leaving \`blocked-on-owner\` records an owner decision.
  // Installed by ops/exception-guard-patch.mjs — see src/continuity/control/owner-gate.js.
  {
    const __e = find(id)
    const __v = ${GUARD_MARKER}({ from: __e?.meta?.status, to: status })
    if (!__v.ok) {
      const __err = new Error(__v.reason + "\\n" + __v.remedy)
      __err.code = __v.failure
      throw __err
    }
  }
`;

export function isPatched(source) {
  return source.includes(GUARD_MARKER);
}

/**
 * Apply the guard. Idempotent, and refuses a source it cannot place it in.
 */
export function patchExceptionSource(source) {
  if (isPatched(source)) return { ok: true, already: true, source };

  const signature = /export function setStatus\(id, status, note = ""\) \{\n/;
  const match = source.match(signature);
  if (!match) {
    // Fail closed rather than guessing where to inject a security check.
    return { ok: false, reason: "setStatus does not have the reviewed signature; refusing to patch blind" };
  }

  // The import must land after the existing imports so the module still parses
  // if the file grows new ones.
  const lastImport = source.lastIndexOf("\nimport ");
  const importEnd = source.indexOf("\n", lastImport + 1) + 1;
  const withImport = source.slice(0, importEnd) + IMPORT_LINE + source.slice(importEnd);

  const at = withImport.indexOf(match[0]) + match[0].length;
  return { ok: true, already: false, source: withImport.slice(0, at) + GUARD_BODY + withImport.slice(at) };
}

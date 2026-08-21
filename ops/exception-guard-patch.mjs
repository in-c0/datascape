// Install the owner gate into the host's exception store.
//
// `_ship_inbox/ops/exception.mjs` is unversioned host code shared by every lane,
// and it owns the only mutation point that can move an item out of
// `blocked-on-owner`. Wrapping it from outside does not work: its own CLI calls
// its own internal `setStatus`, so a front door that re-exports a guarded
// version guards nothing.
//
// So deployment applies a small, exact, idempotent patch, and records the
// before and after hashes as deployment evidence. This is honest about what it
// is — a patch to somebody else's file — rather than pretending the store is
// ours. The patch is reviewed here, in version control, and refuses to apply to
// a source it does not recognise.
//
// V2: THE GUARD IS INLINE, AND THE STORE IMPORTS NOTHING
//
// V1 injected `import { checkTransition } from "./_continuity/owner-gate.js"`.
// That was correct in place and wrong everywhere else: it made `exception.mjs`
// non-relocatable, so `exception.selftest.mjs` — which copies the store to a
// temp directory and imports it — stopped loading entirely. A shared store that
// only works from one directory is a trap waiting for the next person who moves
// it.
//
// The rule is four lines of logic. Inlining it costs nothing, removes a runtime
// dependency from a file every lane loads, and keeps the whole security
// transformation inside this one reviewed, hash-recorded patch:
//
//   from blocked-on-owner, to anything else  -> throw owner_ruling_required
//   everything else                          -> ordinary lane transition
//
// No imported function, no token, no ruling_ref, no registry, no escape hatch.
// There is no argument a caller can pass that turns the refusal into approval.

export const GUARD_MARKER = "__continuity_owner_gate__";

/** V1's injected import — recognised so it can be migrated away, not left. */
const V1_IMPORT_LINE =
  `import { checkTransition as ${GUARD_MARKER} } from "./_continuity/owner-gate.js"\n`;

const V1_BODY = `
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

/** The V2 marker is distinct, so a version can never be mistaken for the other. */
export const GUARD_V2_MARKER = "__continuity_owner_gate_v2__";

const V2_BODY = `
  // ${GUARD_V2_MARKER}: leaving \`blocked-on-owner\` records an owner decision,
  // and only a verified owner ruling may do that. Inlined deliberately — this
  // store must stay relocatable, so it depends on nothing outside itself.
  // Installed by ops/exception-guard-patch.mjs; do not edit by hand.
  {
    const __from = find(id)?.meta?.status
    if (__from === "blocked-on-owner" && status !== "blocked-on-owner") {
      const __err = new Error(
        \`\${__from} -> \${status} records an owner decision, which needs the owner.\\n\`
        + "Rule on it from the briefing surface, or run:\\n"
        + "  node ops/owner-rule.mjs <exception-id> <approve|reply_done|reply_no|reply_need_context|defer|dismiss>\\n"
        + "If the lane no longer needs an answer, append a note saying so and leave the status for her to dismiss."
      )
      __err.code = "owner_ruling_required"
      throw __err
    }
  }
`;

const SIGNATURE = /export function setStatus\(id, status, note = ""\) \{\n/;

/**
 * What guard, if any, is installed in these bytes?
 *
 * Deliberately not `source.includes(GUARD_MARKER)`. That returned true for a
 * half-applied patch, for a file that merely mentions the marker in a comment,
 * and for V1 and V2 alike — so "already patched" could mean anything, including
 * something nobody reviewed.
 */
export function classifyGuard(source) {
  const hasV2Marker = source.includes(GUARD_V2_MARKER);
  const hasV1Marker = source.includes(GUARD_MARKER) && !hasV2Marker;
  const hasV2Body = source.includes(V2_BODY);
  const hasV1Body = source.includes(V1_BODY);
  const hasV1Import = source.includes(V1_IMPORT_LINE);

  if (!hasV1Marker && !hasV2Marker) return { version: "unpatched" };
  if (hasV2Marker && hasV2Body && !hasV1Import && !hasV1Body) return { version: "v2" };
  if (hasV1Marker && hasV1Body && hasV1Import) return { version: "v1" };
  // A marker without its exact body, or both versions present, or an import
  // with no body. Refuse rather than guess what somebody left behind.
  return {
    version: "ambiguous",
    reason: "the store carries a guard marker without a recognised guard body; refusing to transform it",
  };
}

/**
 * Strictly: does this store carry the CURRENT reviewed guard?
 *
 * The predecessor, `isPatched()`, was `classification !== "unpatched"`, so it
 * answered true for V1 and — worse — for `ambiguous`, the state whose whole
 * meaning is "refuse rather than guess". A helper that calls an unrecognised
 * guard "patched" is the same footgun this module exists to remove, one layer
 * further out.
 *
 * V2 only. Anything else is a no, and callers that need to know WHICH no should
 * ask `classifyGuard()`.
 */
export function hasCurrentGuard(source) {
  return classifyGuard(source).version === "v2";
}

/**
 * Install, migrate to, or confirm the V2 inline guard.
 *
 * Idempotent by construction: applying it to a V2 store returns the identical
 * bytes, so a redeploy is byte-stable and a rollback target never drifts.
 */
export function patchExceptionSource(source) {
  const current = classifyGuard(source);

  if (current.version === "v2") return { ok: true, already: true, from: "v2", source };
  if (current.version === "ambiguous") return { ok: false, reason: current.reason, from: "ambiguous" };

  if (current.version === "v1") {
    // Migrate: drop the injected import, swap the body, and touch nothing else.
    const withoutImport = source.replace(V1_IMPORT_LINE, "");
    if (withoutImport === source) {
      return { ok: false, reason: "the V1 guard import is not where it was installed; refusing to migrate blind", from: "v1" };
    }
    const migrated = withoutImport.replace(V1_BODY, V2_BODY);
    if (migrated === withoutImport) {
      return { ok: false, reason: "the V1 guard body is not byte-identical to the reviewed one", from: "v1" };
    }
    const after = classifyGuard(migrated);
    if (after.version !== "v2") {
      return { ok: false, reason: `migration produced a ${after.version} store`, from: "v1" };
    }
    return { ok: true, already: false, from: "v1", migrated: true, source: migrated };
  }

  const match = source.match(SIGNATURE);
  if (!match) {
    // Fail closed rather than guessing where to inject a security check.
    return { ok: false, reason: "setStatus does not have the reviewed signature; refusing to patch blind", from: "unpatched" };
  }
  const at = source.indexOf(match[0]) + match[0].length;
  const patched = source.slice(0, at) + V2_BODY + source.slice(at);
  const after = classifyGuard(patched);
  if (after.version !== "v2") {
    return { ok: false, reason: `installation produced a ${after.version} store`, from: "unpatched" };
  }
  return { ok: true, already: false, from: "unpatched", source: patched };
}

/**
 * The inverse transform: remove a RECOGNISED guard and return the original.
 *
 * Used to establish a known-clean starting point — a test world that copies the
 * live store would otherwise inherit whatever guard the host currently carries
 * and stack a second one on top of it. Also the honest way to answer "what did
 * this file look like before Continuity touched it" without trusting a hash
 * recorded by an earlier release.
 *
 * Only exact, reviewed bodies are removed. Anything else is left alone and
 * reported, because a half-recognised guard is precisely what must not be
 * silently rewritten.
 */
export function stripGuard(source) {
  const current = classifyGuard(source);
  if (current.version === "unpatched") return { ok: true, changed: false, source };
  if (current.version === "ambiguous") return { ok: false, reason: current.reason };

  const stripped = current.version === "v1"
    ? source.replace(V1_IMPORT_LINE, "").replace(V1_BODY, "")
    : source.replace(V2_BODY, "");

  const after = classifyGuard(stripped);
  if (after.version !== "unpatched") {
    return { ok: false, reason: `stripping left a ${after.version} store` };
  }
  return { ok: true, changed: true, from: current.version, source: stripped };
}

// Which authority domain is this host acting for?
//
// The domain is the ORIGINATING EXCEPTION ID, and it has to be derived
// host-side: a browser that could name a lineage could point a prepared review
// at somebody else's blocker.
//
// The hard requirement is STABILITY, and the trap is specific. A successful
// grant RESOLVES the blocker it came from, so "the blocked-on-owner exception
// for this loop" stops matching the moment the grant lands — the surface would
// lose the authority it had just been given, and a reload would show her an
// empty screen with a live grant sitting behind it.
//
// So the domain is resolved by LOOP, across every status, and it keeps
// resolving after the blocker closes. What changes after a grant is the
// blocker's status, not the identity of the thing being governed.
//
// When the answer is not exactly one, this refuses by name. Picking the first
// of several would make the domain depend on directory order, which is the
// opposite of stable.

/** Frontmatter fields the surface is allowed to see. Never the whole file. */
const PUBLIC_FIELDS = ["id", "loop", "title", "severity", "status", "opened", "updated"];

export function readExceptionIndex({ fs, inbox, parseException }) {
  let names;
  try {
    names = fs.readdirSync(inbox).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(`${inbox}/${name}`, "utf8");
      const { meta, body } = parseException(raw);
      if (!meta.id) continue;
      entries.push({ meta, body });
    } catch {
      // A single unreadable or malformed file must not blank the surface. It is
      // skipped, not treated as "no exceptions exist" — reading a storage fault
      // as an empty world is the most dangerous misreading available here.
    }
  }
  return entries;
}

/**
 * @param loop  the configured authority loop, e.g. "datascape/v6-execution-authority"
 * @param hasLineage  (exceptionId) -> does the journal hold authority for it?
 */
export function resolveAuthorityDomain({ entries, loop, hasLineage = () => false }) {
  if (!loop) {
    return { ok: false, failure: "no_authority_loop", reason: "this host is not configured for an authority loop" };
  }
  const matching = entries.filter((e) => e.meta.loop === loop);
  if (!matching.length) {
    return { ok: false, failure: "no_authority_domain", reason: `no exception belongs to ${loop}` };
  }

  // Exactly one is the normal case. When there are several, prefer the one the
  // journal already governs — that is the lineage she has been working with,
  // and switching domains underneath a live authority would be worse than
  // refusing.
  const governed = matching.filter((e) => hasLineage(e.meta.id));
  if (governed.length === 1) return { ok: true, domain: governed[0].meta.id, entry: governed[0] };
  if (governed.length > 1) {
    return {
      ok: false, failure: "ambiguous_authority_domain",
      reason: `${governed.length} exceptions in ${loop} already carry authority`,
      candidates: governed.map((e) => e.meta.id),
    };
  }

  const open = matching.filter((e) => e.meta.status === "blocked-on-owner");
  if (open.length === 1) return { ok: true, domain: open[0].meta.id, entry: open[0] };
  if (open.length > 1) {
    return {
      ok: false, failure: "ambiguous_authority_domain",
      reason: `${open.length} exceptions in ${loop} are waiting on an owner decision`,
      candidates: open.map((e) => e.meta.id),
    };
  }
  if (matching.length === 1) return { ok: true, domain: matching[0].meta.id, entry: matching[0] };
  return {
    ok: false, failure: "ambiguous_authority_domain",
    reason: `${matching.length} exceptions belong to ${loop} and none is distinguishable`,
    candidates: matching.map((e) => e.meta.id),
  };
}

/** The blocker as the surface may see it: named fields, plus the two sections she wrote. */
export function publicBlocker(entry) {
  if (!entry) return null;
  const meta = {};
  for (const field of PUBLIC_FIELDS) {
    if (entry.meta[field] !== undefined) meta[field] = entry.meta[field];
  }
  return {
    ...meta,
    // The two sections that actually explain the decision. Everything else in
    // the body stays on disk: a read surface should hand over what it was asked
    // for, not the whole document because the whole document was to hand.
    evidence: section(entry.body, "Evidence"),
    proposed: section(entry.body, "Proposed action"),
  };
}

function section(body, heading) {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim() || null;
}

/**
 * The scope catalogue, derived from the loops that actually exist.
 *
 * REAL DATA, not a fixture list. The lanes in her inbox are the things autonomy
 * could be scoped to, so the catalogue is exactly those, deduplicated and
 * sorted — deterministic, and it grows as the portfolio does without anyone
 * maintaining a parallel list that drifts.
 */
export function scopeCatalogue(entries) {
  const loops = new Set();
  for (const entry of entries) {
    if (entry.meta.loop) loops.add(entry.meta.loop);
  }
  return [...loops].sort().map((loop) => ({
    ref: `scope:${loop}`,
    label: loop,
    open_blockers: entries.filter(
      (e) => e.meta.loop === loop && e.meta.status === "blocked-on-owner",
    ).length,
  }));
}

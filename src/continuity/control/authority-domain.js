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
  } catch (error) {
    return { entries: [], unreadable: [{ file: inbox, failure: error.code || "unreadable" }] };
  }
  const entries = [];
  const unreadable = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(`${inbox}/${name}`, "utf8");
      const { meta, body } = parseException(raw);
      if (!meta.id) { unreadable.push({ file: name, failure: "no_id" }); continue; }
      entries.push({ meta, body });
    } catch (error) {
      // SKIPPED, AND REPORTED. Silently dropping it was safe enough for display
      // and unsafe for an authority decision: an unreadable file whose loop we
      // cannot read might be a second candidate for this domain, and the host
      // has no way to know it is not. Dropping it turned "I cannot tell whether
      // this is unique" into "this is unique".
      unreadable.push({ file: name, failure: error.code || "unreadable" });
    }
  }
  return { entries, unreadable };
}

/**
 * @param loop  the configured authority loop, e.g. "datascape/v6-execution-authority"
 * @param hasLineage  (exceptionId) -> does the journal hold authority for it?
 */
export function resolveAuthorityDomain({ entries, loop, hasLineage = () => false, unreadable = [] }) {
  // UNIQUENESS CANNOT BE PROVED OVER A PARTIAL INDEX.
  //
  // This refuses before it looks at anything else, because every branch below
  // is a statement about how many candidates exist — and a file we could not
  // read may be one of them. Guessing here would select an authority domain on
  // the strength of not having been able to check.
  if (unreadable.length) {
    return {
      ok: false, failure: "authority_index_incomplete",
      reason: `${unreadable.length} exception file(s) could not be read, so the domain cannot be proved unique`,
      unreadable: unreadable.map((u) => u.file),
    };
  }
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

/** The scope catalogue this host can honestly offer. */
export function scopeCatalogue() {
  // EMPTY, DELIBERATELY, WITH A REASON.
  //
  // This used to synthesize `scope:<exception loop>` entries. Two things were
  // wrong with that, and the second is the serious one.
  //
  // The shape was incompatible: the authoring surface expects entries carrying
  // `labels` and `refs` and calls `entry.labels.some(...)`, so a non-empty real
  // catalogue would have broken the very screen it was meant to fill.
  //
  // And an exception loop is not an authority scope. A loop is the exception
  // layer's <lane>/<topic> label; V6 scope resolution works on explicit
  // references — repo, semantic-centre, topic, source, dependency — that the
  // admission machinery can later compare against. Manufacturing grantable
  // scope out of loop names would have offered her boundaries that nothing
  // downstream could enforce, which is worse than offering none.
  //
  // The real corpus does not currently establish that catalogue. Saying so is
  // the honest answer; inventing scopes to make a form usable is not.
  return {
    catalogue: [],
    scope_catalogue_ready: false,
    reason: "no authoritative scope catalogue is established for this host yet; "
      + "exception loops are not authority scope references",
  };
}

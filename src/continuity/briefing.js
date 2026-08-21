// Model for the Continuity briefing — the catch-up projection.
//
// Implements `_hub/specs/2026-08-21-continuity-catchup-spec-v1.md` (governing
// lane, 2026-08-21) plus its `deferred_until` addendum.
//
// THE RULE THAT SHAPES EVERYTHING HERE
//
//   Semantic zoom changes WHAT A NODE MEANS, not how many things appear.
//
// So this module does not "expand" anything. It answers one question — given a
// semantic position, which at most 5 nodes should be on screen — and selection
// moves the position rather than revealing more rows. The previous version
// expanded in place inside a dense list, which is exactly the defect the spec
// names as the largest one.
//
// Node budgets are hard limits, enforced here and asserted in tests. Large
// monitors get more whitespace, not more simultaneous cognition.

export const BUDGETS = {
  entry: 4,        // Needs you + up to 3 lane roots
  entry30: 3,      // 30-sec brief: Needs you + up to 2 lane roots
  z0: 4,           // origin + up to 3 buckets/facets
  z1: 5,           // bucket/facet + up to 4 records
  z2: 3,           // parent (dim) + record (dominant) + at most 1 sibling
  z3: 4,           // record + up to 3 evidence chunks
  z4: 2,           // parent + one atomic hint
};

export const LEVELS = ["entry", "z0", "z1", "z2", "z3", "z4"];

export const FACETS = ["Needs you", "Running", "Changed", "Completed", "Finding", "State"];

// Which facet a lane record's item belongs to. Deliberately metadata-driven —
// no model ranking, no inference from adjacency.
const FACET_BY_TYPE = {
  owner_action: "Needs you",
  finding: "Finding",
  progress: "Completed",
  state: "State",
};

// ---------------------------------------------------------------------------
// Deferral (spec §6C + addendum)
// ---------------------------------------------------------------------------

/**
 * An owner action is due now unless it carries a VALID future `deferredUntil`.
 *
 * A malformed timestamp fails OPEN into due-now. Hiding an owner decision
 * because a date failed to parse is the one outcome this must never produce.
 */
export function isDueNow(action, now = Date.now()) {
  if (!action) return false;
  const raw = action.deferredUntil;
  if (!raw) return true;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return true; // malformed → due now, never hidden
  return at <= now;
}

export function partitionActions(actions = [], now = Date.now()) {
  const dueNow = [];
  const deferred = [];
  for (const action of actions) {
    (isDueNow(action, now) ? dueNow : deferred).push(action);
  }
  return { dueNow, deferred };
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/** Owner actions: high → medium → low, then oldest open first (spec §Z1). */
export function orderOwnerActions(actions = []) {
  return actions.slice().sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1);
    if (bySeverity) return bySeverity;
    return String(a.opened || "").localeCompare(String(b.opened || ""));
  });
}

// ---------------------------------------------------------------------------
// Semantic position
//
// A path is a "/"-joined address. Everything the surface can be looking at is
// one of these, which is what makes Back and reload exact:
//
//   ""                                   entry
//   "needs"                              Z0 — Needs you
//   "needs/<bucket>"                     Z1 — that bucket's records
//   "needs/<bucket>/<exceptionId>"       Z2 — one owner action
//   "needs/<bucket>/<exceptionId>/hint/<n>"  Z4 — one derived hint
//   "lane/<laneKey>"                     Z0 — lane facets
//   "lane/<laneKey>/<facet>"             Z1 — that facet's records
//   "lane/<laneKey>/<facet>/<itemKey>"   Z2 — one lane record item
// ---------------------------------------------------------------------------

export function parsePath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (!parts.length) return { kind: "entry", parts };
  if (parts[0] === "needs") return { kind: "needs", bucket: parts[1], record: parts[2], hint: parts[3] === "hint" ? Number(parts[4]) : null, parts };
  if (parts[0] === "lane") return { kind: "lane", lane: parts[1], facet: parts[2] && decodeURIComponent(parts[2]), record: parts[3], full: parts[4] === "full", hint: parts[4] === "hint" ? Number(parts[5]) : null, parts };
  return { kind: "entry", parts };
}

export function levelOf(path) {
  const p = parsePath(path);
  if (p.kind === "entry") return "entry";
  if (p.hint != null && Number.isFinite(p.hint)) return "z4";
  if (p.kind === "needs") {
    if (p.record) return "z2";
    if (p.bucket) return "z1";
    return "z0";
  }
  // A lane record's complete authored text is one semantic level deeper than
  // its bounded excerpt (visual review 1, P1).
  if (p.full) return "z3";
  if (p.record) return "z2";
  if (p.facet) return "z1";
  return "z0";
}

export function parentPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (!parts.length) return "";
  // A hint is addressed as ".../hint/<n>" — two segments.
  if (parts[parts.length - 2] === "hint") return parts.slice(0, -2).join("/");
  return parts.slice(0, -1).join("/");
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

const laneBucketKey = (action) => {
  // Bucket owner actions by their filing loop's first segment ("sumzup/publish"
  // → "sumzup"). That is authored metadata, not an inferred grouping.
  const loop = String(action.loop || "").trim();
  if (loop) return loop.split("/")[0];
  return "unfiled";
};

function laneRecordItems(lane) {
  const out = [];
  for (const record of lane.records || []) {
    for (const [index, item] of (record.items || []).entries()) {
      out.push({
        key: `${record.id}:${index}`,
        title: item.headline,
        detail: item.detail || item.raw || "",
        type: item.type,
        facet: FACET_BY_TYPE[item.type] || "State",
        at: record.emittedAt,
        provenance: record.provenance || null,
        sourceRef: record.sourceRef || null,
        links: item.links || [],
        refs: item.refs || {},
        raw: item.raw || "",
      });
    }
  }
  // Most recently updated first — lanes have no severity to rank by.
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

/**
 * Rank lane roots for the entry screen.
 *
 * Spec v2 §6: when she returns after a substantial unattended interval, the
 * semantic centre is MATERIAL CHANGE SINCE DEPARTURE, not lane recency. A lane
 * that sat quiet all night should not outrank one that changed state while
 * nobody was watching simply because it ticked more recently.
 *
 *   1. contains a high-severity owner blocker
 *   2. unattended work that materially changed state
 *   3. still-running unattended work
 *   4. everything else, by recency
 */
export function rankLanes(lanes = [], dueNowActions = [], inWindow = null) {
  const highLoops = new Set(
    dueNowActions.filter((a) => a.severity === "high").map((a) => laneBucketKey(a)),
  );
  const rank = (lane) => {
    if (highLoops.has(lane.lane)) return 0;
    // Unattended only earns promotion when the change landed inside the away
    // interval; when no departure is known, nothing is promoted on that basis.
    const unattended = lane.supervision === "unattended" && (!inWindow || inWindow.has(lane.lane));
    if (unattended && (lane.records || []).length) return 1;
    if (unattended && lane.execution === "live") return 2;
    return 3;
  };
  return lanes.slice().sort((a, b) => {
    const byPriority = rank(a) - rank(b);
    if (byPriority) return byPriority;
    const aChanged = (a.records || []).length;
    const bChanged = (b.records || []).length;
    if (aChanged !== bChanged) return bChanged - aChanged;
    return String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""));
  });
}

// ---------------------------------------------------------------------------
// Temporal environment (spec v2 §3)
//
// Background context, never content. Derived from the local clock alone — the
// spec forbids exposing precise location in rendered Continuity state, so there
// is no geolocation here at all and the phase boundaries are fixed rather than
// solar. A real sunrise/sunset integration can refine these later without
// changing the grammar.
// ---------------------------------------------------------------------------

export const TEMPORAL_PHASES = ["night", "pre-dawn", "sunrise", "daytime", "afternoon", "evening"];

// The hour AS SEEN IN SYDNEY, not in whatever zone the process happens to run
// in. `getHours()` returns runner-local hours, so a 13:00+10:00 run read as
// 03:00 in a UTC CI box and was labelled "overnight" — a real mislabelling that
// only stayed invisible because this machine is already in Sydney. The whole
// portfolio reads Sydney time; the code should too.
export const SURFACE_TZ = "Australia/Sydney";

export function localHour(value, timeZone = SURFACE_TZ) {
  const date = value instanceof Date ? value : new Date(Date.parse(value));
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return get("hour") + get("minute") / 60;
}

export function temporalPhase(date = new Date(), timeZone = SURFACE_TZ) {
  const hour = localHour(date, timeZone) ?? 12;
  if (hour < 4) return "night";
  if (hour < 6) return "pre-dawn";
  if (hour < 8) return "sunrise";
  if (hour < 12) return "daytime";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

/** Does a run cross the small hours? Derived context, never a supervision state. */
export function spansNight(run, timeZone = SURFACE_TZ) {
  const from = Date.parse(run?.startedAt);
  const to = Date.parse(run?.endedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const startHour = localHour(new Date(from), timeZone);
  const endHour = localHour(new Date(to), timeZone);
  if (startHour == null || endHour == null) return false;
  return startHour < 6 || endHour < 6 || (to - from) > 6 * 3600 * 1000;
}

/**
 * The header's clauses (spec v2 §5). Only non-zero clauses are returned, so the
 * line says nothing about unattended work on a day when none happened.
 */
export function awaySummary(data, now = Date.now()) {
  const lanes = data?.lanes || [];
  const { dueNow } = partitionActions(data?.ownerActions || [], now);

  const unattendedLanes = lanes.filter((l) => l.supervision === "unattended");
  // Only changes that landed INSIDE the away interval count. An eight-hour-old
  // completed run must not be promoted just for being unattended.
  const inWindow = data?.ownerLastPresentAt
    ? returnWindowLanes(unattendedLanes, data.ownerLastPresentAt, now)
    : [];
  const materialChanges = inWindow.length;
  const stillRunning = unattendedLanes.filter((l) => l.execution === "live").length;

  const longest = unattendedLanes
    .flatMap((l) => l.runs || [])
    .sort((a, b) => (b.hours || 0) - (a.hours || 0))[0] || null;

  const clauses = [];
  if (materialChanges) clauses.push(`${materialChanges} material change${materialChanges === 1 ? "" : "s"} unattended`);
  if (stillRunning) clauses.push(`${stillRunning} still running`);
  if (dueNow.length) clauses.push(`${dueNow.length} need${dueNow.length === 1 ? "s" : ""} you`);

  return { clauses, materialChanges, stillRunning, dueNow: dueNow.length, longestRun: longest };
}

// focal:true marks the node that IS the current semantic centre. The visual
// review failed Z0/Z1 because the origin was drawn as the first CHILD while the
// fan started from an invisible point, so the eye could not answer "what am I
// inside?" without reading the breadcrumb.
const FOCAL_KINDS = new Set(["origin", "parent", "focus"]);
/**
 * The material outcome of a lane's recent work, in the author's own words.
 *
 * Spec v2.1 P1: "the run/lane is provenance; the node is the consequence." So
 * a root prefers the authored headline of its most material record over the
 * name of the worker that produced it. Findings and progress outrank routine
 * state, and nothing is summarised — this is verbatim authored text or nothing.
 */
export function materialOutcome(lane) {
  const weight = { finding: 0, progress: 1, owner_action: 2, state: 3 };
  const items = (lane?.records || [])
    .flatMap((r) => (r.items || []).map((i) => ({ ...i, at: r.emittedAt })))
    .filter((i) => i.headline && i.headline.length > 12)
    .sort((a, b) => (weight[a.type] ?? 9) - (weight[b.type] ?? 9)
      || String(b.at).localeCompare(String(a.at)));
  const best = items[0];
  // A routine tick is not an outcome; fall back to the lane name rather than
  // dressing up "still generating" as a material change.
  if (!best || /^tick[:\s]/i.test(best.headline)) return null;
  return best.headline.length > 68 ? `${best.headline.slice(0, 66).trimEnd()}…` : best.headline;
}

const node = (props) => ({ dashed: false, dim: false, focal: FOCAL_KINDS.has(props.kind), ...props });

/**
 * Build the scene for a semantic position.
 *
 * `page` windows an over-budget list; it never appends. `brief` controls
 * COVERAGE (how much is reachable), never density.
 */
export function buildScene(data, { path = "", brief = "3m", now = Date.now(), page = 0 } = {}) {
  const lanes = data?.lanes || [];
  const { dueNow, deferred } = partitionActions(data?.ownerActions || [], now);
  const ordered = orderOwnerActions(dueNow);
  const position = parsePath(path);
  const level = levelOf(path);

  const scene = {
    level,
    path,
    parentPath: parentPath(path),
    brief,
    budget: BUDGETS[level === "entry" ? (brief === "30s" ? "entry30" : "entry") : level],
    nodes: [],
    card: null,
    breadcrumb: [],
    counts: { dueNow: dueNow.length, deferred: deferred.length, lanes: lanes.length, records: data?.totals?.mustReads ?? 0 },
    away: awaySummary(data, now),
    phase: temporalPhase(new Date(now)),
    page,
    pageCount: 1,
    hidden: 0,
    deferredActions: deferred,
  };

  const window_ = (items, budget) => {
    const size = Math.max(1, budget);
    const pages = Math.max(1, Math.ceil(items.length / size));
    const p = ((page % pages) + pages) % pages;
    scene.pageCount = pages;
    scene.page = p;
    scene.hidden = Math.max(0, items.length - size);
    return items.slice(p * size, p * size + size);
  };

  // ---------- entry ----------
  if (level === "entry") {
    const laneBudget = (brief === "30s" ? BUDGETS.entry30 : BUDGETS.entry) - (ordered.length ? 1 : 0);
    // A lane whose only unattended work predates her departure is not a return-
    // window change and must not be promoted for being unattended.
    const departedAt = data?.ownerLastPresentAt || null;
    const inWindow = departedAt ? new Set(returnWindowLanes(lanes, departedAt, now).map((l) => l.lane)) : null;
    const ranked = rankLanes(lanes, ordered, inWindow).filter((l) => (l.records || []).length);
    const shown = window_(ranked, laneBudget);
    if (ordered.length) {
      scene.nodes.push(node({
        key: "needs", kind: "root", label: "Needs you", path: "needs",
        status: "needs_human", dashed: true,
        sub: `${ordered.length} due now`,
      }));
    }
    for (const lane of shown) {
      // The longest run is the one worth naming at entry: "unattended ·
      // 03:58–11:53" tells her more than a record count, and it is ONE
      // enclosure however many machine events it contains.
      const run = (lane.runs || []).slice().sort((a, b) => (b.hours || 0) - (a.hours || 0))[0] || null;
      scene.nodes.push(node({
        key: lane.lane, kind: "root", label: materialOutcome(lane) || lane.label, path: `lane/${lane.lane}`,
        provenanceLabel: lane.label,
        status: "committed",
        // The envelope on the axis already carries the interval; repeating it
        // here is the duplication the review flagged. Position is the label.
        sub: lane.supervision === "unattended"
          ? "unattended"
          : `${(lane.records || []).length} changed`,
        at: lane.lastSeen,
        supervision: lane.supervision,
        execution: lane.execution,
        run,
        autoRunUrl: lane.autoRunUrl, seedUrl: lane.seedUrl,
      }));
    }
    scene.hidden = Math.max(0, ranked.length - shown.length);

    // The temporal window the entry scene is suspended in: from the earliest
    // visible unattended run (or the owner's departure) through to NOW. Every
    // envelope is positioned on THIS scale, so a two-hour run is visibly half
    // the width of a four-hour one.
    const runStarts = shown
      .flatMap((l) => l.runs || [])
      .map((r) => Date.parse(r.startedAt))
      .filter(Number.isFinite);
    const departure = Date.parse(data?.ownerLastPresentAt);
    const earliest = Math.min(
      ...(runStarts.length ? runStarts : [now - 8 * 3600 * 1000]),
      Number.isFinite(departure) ? departure : Infinity,
    );
    scene.timeline = {
      from: new Date(Math.min(earliest, now - 30 * 60 * 1000)).toISOString(),
      to: new Date(now).toISOString(),
      now,
      ownerLastPresentAt: data?.ownerLastPresentAt || null,
      // Only runs that actually INTERSECT the window. Clamping an out-of-window
      // run to the edge drew a 15:26–18:03 envelope at the 02:50 position — the
      // label said one thing and the geometry said another, which is worse than
      // omitting it, because the whole point of the axis is that position is
      // trustworthy.
      runs: shown
        .flatMap((lane) => (lane.runs || []).map((run) => ({ ...run, laneKey: lane.lane, laneLabel: lane.label })))
        .filter((run) => {
          const a = Date.parse(run.startedAt);
          const b = Date.parse(run.endedAt || new Date(now).toISOString());
          return Number.isFinite(a) && Number.isFinite(b) && b >= earliest && a <= now;
        }),
    };
    return scene;
  }

  scene.breadcrumb.push({ label: "Catch-up", path: "" });

  // ---------- Needs you branch ----------
  if (position.kind === "needs") {
    scene.breadcrumb.push({ label: "Needs you", path: "needs" });
    const buckets = new Map();
    for (const action of ordered) {
      const key = laneBucketKey(action);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(action);
    }

    if (level === "z0") {
      const list = [...buckets.entries()].sort((a, b) => {
        const aHigh = a[1].some((x) => x.severity === "high") ? 0 : 1;
        const bHigh = b[1].some((x) => x.severity === "high") ? 0 : 1;
        if (aHigh !== bHigh) return aHigh - bHigh;
        return b[1].length - a[1].length;
      });
      const shown = window_(list, BUDGETS.z0 - 1);
      scene.nodes.push(node({ key: "needs", kind: "origin", label: "Needs you", path: "needs", status: "needs_human", dashed: true, sub: `${ordered.length} due now` }));
      for (const [key, items] of shown) {
        scene.nodes.push(node({
          key, kind: "bucket", label: key, path: `needs/${key}`,
          status: "needs_human", dashed: true,
          sub: `${items.length}`,
          severity: items.some((i) => i.severity === "high") ? "high" : items[0]?.severity,
        }));
      }
      return scene;
    }

    const bucketItems = orderOwnerActions(buckets.get(position.bucket) || []);
    scene.breadcrumb.push({ label: position.bucket, path: `needs/${position.bucket}` });

    if (level === "z1") {
      const shown = window_(bucketItems, BUDGETS.z1 - 1);
      scene.nodes.push(node({ key: position.bucket, kind: "origin", label: position.bucket, path: `needs/${position.bucket}`, status: "needs_human", dashed: true, sub: `${bucketItems.length}` }));
      for (const action of shown) {
        scene.nodes.push(node({
          key: action.id, kind: "record", label: action.title, path: `needs/${position.bucket}/${action.id}`,
          status: "needs_human", dashed: true, severity: action.severity, at: action.updated,
        }));
      }
      return scene;
    }

    const action = bucketItems.find((a) => a.id === position.record)
      || (data?.ownerActions || []).find((a) => a.id === position.record);
    if (!action) {
      scene.nodes.push(node({ key: "absent", kind: "absent", label: `${position.record} is no longer due`, path: `needs/${position.bucket}`, status: "committed" }));
      return scene;
    }
    scene.breadcrumb.push({ label: action.title, path: `needs/${position.bucket}/${action.id}` });

    if (level === "z4") {
      const hints = action.steps || [];
      const index = Math.min(Math.max(0, position.hint || 0), Math.max(0, hints.length - 1));
      scene.nodes.push(node({ key: action.id, kind: "parent", label: action.title, path: `needs/${position.bucket}/${action.id}`, status: "needs_human", dim: true, dashed: true }));
      scene.nodes.push(node({ key: `hint-${index}`, kind: "hint", label: hints[index]?.text || "—", path: `needs/${position.bucket}/${action.id}/hint/${index}`, status: "live", dashed: true }));
      scene.card = { kind: "hint", action, hint: hints[index], index, total: hints.length };
      return scene;
    }

    // z2 — record focus. Parent dim behind, record dominant, one sibling max.
    const index = bucketItems.findIndex((a) => a.id === action.id);
    const sibling = bucketItems[index + 1] || bucketItems[index - 1] || null;
    scene.nodes.push(node({ key: position.bucket, kind: "parent", label: position.bucket, path: `needs/${position.bucket}`, status: "needs_human", dim: true, dashed: true }));
    scene.nodes.push(node({ key: action.id, kind: "focus", label: action.title, path: `needs/${position.bucket}/${action.id}`, status: "needs_human", dashed: true, severity: action.severity }));
    if (sibling) {
      scene.nodes.push(node({ key: sibling.id, kind: "sibling", label: sibling.title, path: `needs/${position.bucket}/${sibling.id}`, status: "needs_human", dashed: true, severity: sibling.severity, dim: true }));
    }
    scene.card = { kind: "owner_action", action, next: sibling };
    return scene;
  }

  // ---------- lane branch ----------
  const lane = lanes.find((l) => l.lane === position.lane);
  if (!lane) {
    scene.nodes.push(node({ key: "absent", kind: "absent", label: `${position.lane} is not reporting`, path: "", status: "committed" }));
    return scene;
  }
  scene.breadcrumb.push({ label: lane.label, path: `lane/${lane.lane}` });
  const items = laneRecordItems(lane);

  if (level === "z0") {
    const byFacet = new Map();
    for (const item of items) {
      if (!byFacet.has(item.facet)) byFacet.set(item.facet, []);
      byFacet.get(item.facet).push(item);
    }
    const list = FACETS.filter((f) => byFacet.has(f)).map((f) => [f, byFacet.get(f)]);
    const shown = window_(list, BUDGETS.z0 - 1);
    const laneRun = (lane.runs || []).slice().sort((a, b) => (b.hours || 0) - (a.hours || 0))[0] || null;
    scene.nodes.push(node({
      key: lane.lane, kind: "origin", label: lane.label, path: `lane/${lane.lane}`,
      status: "committed", sub: `${items.length} records`,
      supervision: lane.supervision, execution: lane.execution, run: laneRun,
      autoRunUrl: lane.autoRunUrl, seedUrl: lane.seedUrl,
    }));
    for (const [facet, group] of shown) {
      scene.nodes.push(node({
        key: facet, kind: "facet", label: facet, path: `lane/${lane.lane}/${encodeURIComponent(facet)}`,
        status: facet === "Needs you" ? "needs_human" : facet === "Finding" ? "live" : facet === "Completed" ? "merged" : "committed",
        dashed: facet === "Needs you" || facet === "Finding",
        sub: `${group.length}`,
      }));
    }
    return scene;
  }

  const facetItems = items.filter((i) => i.facet === position.facet);
  scene.breadcrumb.push({ label: position.facet, path: `lane/${lane.lane}/${encodeURIComponent(position.facet)}` });

  if (level === "z1") {
    const shown = window_(facetItems, BUDGETS.z1 - 1);
    scene.nodes.push(node({ key: position.facet, kind: "origin", label: position.facet, path: `lane/${lane.lane}/${encodeURIComponent(position.facet)}`, status: "committed", sub: `${facetItems.length}` }));
    for (const item of shown) {
      scene.nodes.push(node({
        key: item.key, kind: "record", label: item.title,
        path: `lane/${lane.lane}/${encodeURIComponent(position.facet)}/${encodeURIComponent(item.key)}`,
        status: item.facet === "Needs you" ? "needs_human" : item.facet === "Finding" ? "live" : item.facet === "Completed" ? "merged" : "committed",
        at: item.at,
      }));
    }
    return scene;
  }

  const decoded = position.record && decodeURIComponent(position.record);
  const item = facetItems.find((i) => i.key === decoded);
  if (!item) {
    scene.nodes.push(node({ key: "absent", kind: "absent", label: "that record is no longer in this facet", path: `lane/${lane.lane}/${encodeURIComponent(position.facet)}`, status: "committed" }));
    return scene;
  }
  scene.breadcrumb.push({ label: item.title, path: `lane/${lane.lane}/${encodeURIComponent(position.facet)}/${encodeURIComponent(item.key)}` });
  const idx = facetItems.findIndex((i) => i.key === item.key);
  const sibling = facetItems[idx + 1] || facetItems[idx - 1] || null;
  scene.nodes.push(node({ key: position.facet, kind: "parent", label: position.facet, path: `lane/${lane.lane}/${encodeURIComponent(position.facet)}`, status: "committed", dim: true }));
  scene.nodes.push(node({ key: item.key, kind: "focus", label: item.title, path: scene.breadcrumb[scene.breadcrumb.length - 1].path, status: "committed" }));
  if (sibling) {
    scene.nodes.push(node({ key: sibling.key, kind: "sibling", label: sibling.title, path: `lane/${lane.lane}/${encodeURIComponent(position.facet)}/${encodeURIComponent(sibling.key)}`, status: "committed", dim: true }));
  }
  scene.card = { kind: "record", item, lane };
  return scene;
}

/**
 * The next due owner decision after afterId within the same bucket.
 *
 * Spec 9: clearing decisions should read "read → click → read → click", so
 * after a ruling the surface advances itself instead of sending her back to a
 * list. Returns null when the bucket is empty, which the caller renders as a
 * step back up rather than a dead end.
 */
export function nextDueInBucket(actions = [], bucket, afterId, now = Date.now()) {
  const { dueNow } = partitionActions(actions, now);
  const ordered = orderOwnerActions(dueNow.filter((a) => laneBucketKey(a) === bucket));
  if (!ordered.length) return null;
  const index = ordered.findIndex((a) => a.id === afterId);
  // The ruled item is normally gone from the fresh queue, so the item now at
  // its position is the next one; if it is still present (a defer), step past it.
  const candidate = index >= 0 ? ordered[index + 1] : ordered[0];
  return candidate || ordered[0] || null;
}

export function bucketOf(action) {
  return laneBucketKey(action);
}

/**
 * A bounded verbatim excerpt — deterministic source text, never a summary.
 * Cuts at a sentence or word boundary so the excerpt reads as prose rather than
 * a truncation artefact.
 */
export function excerpt(text, limit = 320) {
  const source = String(text || "").trim();
  if (source.length <= limit) return { text: source, truncated: false };
  const window_ = source.slice(0, limit);
  const sentence = window_.lastIndexOf(". ");
  const cut = sentence > limit * 0.5 ? sentence + 1 : window_.lastIndexOf(" ");
  return { text: source.slice(0, cut > 0 ? cut : limit).trim(), truncated: true };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function effortLabel(seconds) {
  if (seconds == null) return "effort unknown";
  if (seconds < 60) return `~${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? "~1 min" : `~${minutes} min`;
}

export function agoLabel(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/**
 * How long she was away.
 *
 * Measured from her ACTUAL departure when we know it. Using the newest lane
 * timestamp instead reported "away for 6 min" on a scene promoting eight-hour
 * -old overnight runs — the inconsistency the review caught. Lane recency is
 * only a fallback for when no departure is recorded.
 */
export function awayLabel(lanes = [], now = Date.now(), ownerLastPresentAt = null) {
  const departed = Date.parse(ownerLastPresentAt);
  const newest = Number.isFinite(departed)
    ? departed
    : lanes.map((l) => Date.parse(l.lastSeen || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (!newest) return null;
  const minutes = Math.max(0, Math.round((now - newest) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h}h ${minutes % 60}m`;
  return `${Math.round(h / 24)} days`;
}

/** Resolve a Defer preset to an absolute instant (addendum: persist absolute only). */
export function resolveDeferPreset(preset, now = new Date()) {
  const d = new Date(now.getTime());
  if (preset === "1 hour") {
    d.setHours(d.getHours() + 1);
  } else if (preset === "Tonight") {
    // 20:00 today, or tomorrow if that has passed.
    const t = new Date(d.getTime());
    t.setHours(20, 0, 0, 0);
    if (t <= d) t.setDate(t.getDate() + 1);
    return t;
  } else if (preset === "Tomorrow") {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d;
}

// ---------------------------------------------------------------------------
// URL — the semantic position is addressable, so Back restores level AND center
// ---------------------------------------------------------------------------

export function readLocation(href) {
  const url = new URL(href, "http://datascape.local/");
  const brief = url.searchParams.get("brief");
  const pageRaw = Number(url.searchParams.get("page"));

  // `now` and `since` are deterministic-fixture affordances for acceptance
  // screenshots: the spec asks for a scene showing an 8+ hour overnight return,
  // which cannot be captured reproducibly against a live clock. They only ever
  // move the viewing instant and the departure marker — no data is fabricated,
  // and an invalid value is ignored rather than guessed at.
  const nowRaw = Date.parse(url.searchParams.get("now"));
  const sinceRaw = url.searchParams.get("since");

  return {
    path: url.searchParams.get("at") || "",
    brief: ["30s", "3m", "full"].includes(brief) ? brief : "3m",
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 0,
    now: Number.isFinite(nowRaw) ? nowRaw : null,
    since: Number.isFinite(Date.parse(sinceRaw)) ? sinceRaw : null,
  };
}

export function buildUrl(state, href) {
  const url = new URL(href, "http://datascape.local/");
  url.searchParams.set("view", "briefing");
  if (state.path) url.searchParams.set("at", state.path);
  else url.searchParams.delete("at");
  if (state.brief && state.brief !== "3m") url.searchParams.set("brief", state.brief);
  else url.searchParams.delete("brief");
  if (state.page) url.searchParams.set("page", String(state.page));
  else url.searchParams.delete("page");
  return url;
}

export function writeLocation(state, mode = "push") {
  if (typeof window === "undefined") return;
  const url = buildUrl(state, window.location.href);
  const method = mode === "push" ? "pushState" : "replaceState";
  window.history[method](null, "", `${url.pathname}${url.search}${url.hash}`);
}

// ---------------------------------------------------------------------------
// Execution provenance, grounded at the trigger (spec v2.1, P0)
//
// The v2 rule — "a lane with an autoRunUrl produces unattended records" — was
// rejected, correctly. `autoRunUrl` establishes that a lane SUPPORTS unattended
// execution; it cannot prove that any particular record was unattended. A 4am
// human ruling inside an otherwise autonomous lane is attended, and the only
// thing that knows the difference is what triggered the record.
//
// So supervision is derived from trigger.kind and nothing else. `unknown` is a
// real answer and must never be displayed as either attended or unattended —
// claiming provenance we do not have is worse than admitting the gap.
// ---------------------------------------------------------------------------

export const TRIGGER_KINDS = ["scheduler", "automation", "owner", "operator", "unknown"];

export function supervisionFromTrigger(trigger) {
  const kind = trigger?.kind;
  if (kind === "scheduler" || kind === "automation") return "unattended";
  if (kind === "owner" || kind === "operator") return "attended";
  return "unknown";
}

/**
 * Did this record's material state transition happen inside the away interval?
 *
 * An unattended run may have STARTED before she left; it only belongs in the
 * return framing if something material happened while she was gone. Without
 * this, a six-minute absence promoted an eight-hour-old completed run purely
 * for being unattended.
 */
export function isReturnWindowChange(at, ownerLastPresentAt, now = Date.now()) {
  const t = Date.parse(at);
  const from = Date.parse(ownerLastPresentAt);
  if (!Number.isFinite(t)) return false;
  // With no known departure we cannot prove anything is in-window, so nothing
  // is promoted on that basis.
  if (!Number.isFinite(from)) return false;
  return t > from && t <= now;
}

/** Lanes whose material change landed inside the away interval. */
export function returnWindowLanes(lanes = [], ownerLastPresentAt, now = Date.now()) {
  return lanes.filter((lane) =>
    (lane.records || []).some((r) => isReturnWindowChange(r.emittedAt, ownerLastPresentAt, now)));
}

// ---------------------------------------------------------------------------
// Temporal scale (spec v2.1, P0)
//
// Time becomes a real spatial axis: an envelope's width IS its elapsed
// duration, and NOW is a position rather than a label. That is what makes
// "completed terminates before NOW / live intersects NOW" readable in a still
// screenshot without badges.
// ---------------------------------------------------------------------------

export function timeScale({ from, to, width = 1000, padding = 0.04 }) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  const span = Math.max(1, b - a);
  const usable = width * (1 - padding * 2);
  const x = (value) => {
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(t)) return null;
    const clamped = Math.min(Math.max(t, a), b);
    return width * padding + ((clamped - a) / span) * usable;
  };
  return { from: a, to: b, width, x, spanMs: span };
}

/**
 * Envelope geometry on the shared scale.
 *
 * A live run has no `endedAt` and is drawn THROUGH now; a completed run stops
 * to the left of it. The geometry carries the execution state, so no LIVE /
 * COMPLETED badge is needed to make a still frame interpretable.
 */
export function envelopeGeometry(run, scale, now = Date.now()) {
  if (!run || !scale) return null;
  const x1 = scale.x(run.startedAt);
  const live = run.execution === "live" || !run.endedAt;
  const x2 = live ? scale.x(new Date(now)) : scale.x(run.endedAt);
  if (x1 == null || x2 == null) return null;
  return {
    x1: Math.min(x1, x2),
    x2: Math.max(x1, x2),
    width: Math.max(2, Math.abs(x2 - x1)),
    live,
    intersectsNow: live,
  };
}

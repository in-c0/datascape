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
  if (parts[0] === "lane") return { kind: "lane", lane: parts[1], facet: parts[2] && decodeURIComponent(parts[2]), record: parts[3], hint: parts[4] === "hint" ? Number(parts[5]) : null, parts };
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
 * Rank lane roots for the entry screen (spec §1): a lane containing a
 * high-severity owner blocker first, then activity, then recency.
 */
export function rankLanes(lanes = [], dueNowActions = []) {
  const highLoops = new Set(
    dueNowActions.filter((a) => a.severity === "high").map((a) => laneBucketKey(a)),
  );
  return lanes.slice().sort((a, b) => {
    const aHigh = highLoops.has(a.lane) ? 0 : 1;
    const bHigh = highLoops.has(b.lane) ? 0 : 1;
    if (aHigh !== bHigh) return aHigh - bHigh;
    const aChanged = (a.records || []).length;
    const bChanged = (b.records || []).length;
    if (aChanged !== bChanged) return bChanged - aChanged;
    return String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""));
  });
}

const node = (props) => ({ dashed: false, dim: false, ...props });

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
    const ranked = rankLanes(lanes, ordered).filter((l) => (l.records || []).length);
    const shown = window_(ranked, laneBudget);
    if (ordered.length) {
      scene.nodes.push(node({
        key: "needs", kind: "root", label: "Needs you", path: "needs",
        status: "needs_human", dashed: true,
        sub: `${ordered.length} due now`,
      }));
    }
    for (const lane of shown) {
      scene.nodes.push(node({
        key: lane.lane, kind: "root", label: lane.label, path: `lane/${lane.lane}`,
        status: "committed", sub: `${(lane.records || []).length} changed`,
        at: lane.lastSeen, autoRunUrl: lane.autoRunUrl, seedUrl: lane.seedUrl,
      }));
    }
    scene.hidden = Math.max(0, ranked.length - shown.length);
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
    scene.nodes.push(node({ key: lane.lane, kind: "origin", label: lane.label, path: `lane/${lane.lane}`, status: "committed", sub: `${items.length} records`, autoRunUrl: lane.autoRunUrl, seedUrl: lane.seedUrl }));
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

export function awayLabel(lanes = [], now = Date.now()) {
  const newest = lanes.map((l) => Date.parse(l.lastSeen || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
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
  return {
    path: url.searchParams.get("at") || "",
    brief: ["30s", "3m", "full"].includes(brief) ? brief : "3m",
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 0,
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

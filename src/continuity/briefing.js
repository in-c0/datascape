// Model for the Continuity briefing — the catch-up projection.
//
// The briefing answers one question: "what happened while I was away, and what
// needs me?" It is deliberately NOT the semantic viewport. Where
// `?view=continuity` re-abstracts a concept graph, the briefing renders
// authored text verbatim, because its content is a human sentence someone wrote
// for the operator, and paraphrasing it would lose the only thing it has.
//
// Two node families:
//
//   owner actions   open owner-gated blockers, expanding into ATOMIC steps
//   lane must-reads the latest N per lane, expanding into full detail
//
// Both collapse to one line by default. That line is the TL;DR; everything else
// is behind an expansion. The attention budget is the whole point — a surface
// that shows 262 must-reads is the transcript it was meant to replace.

export const NODE_STATUS = {
  owner_action: "needs_human",
  finding: "live",
  progress: "merged",
  state: "committed",
}

export const STEP_KINDS = new Set(["run", "open", "decide", "physical"]);

const clampLatest = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** Stable per-node id — used for expansion state and deep links. */
export function nodeId(kind, ...parts) {
  return [kind, ...parts.filter((p) => p != null && p !== "")].join(":")
}

/**
 * The catch-up viewport.
 *
 * `latest` re-slices client-side rather than trusting the builder's slice, so
 * "show me one more" never needs a rebuild — the document carries every record
 * the builder chose to include and the viewport decides how many to show.
 */
export function buildBriefingViewport(data, { latest, expanded = new Set(), laneFilter = null } = {}) {
  const perLane = clampLatest(latest, clampLatest(data?.latestPerLane, 2))

  const lanes = (data?.lanes || [])
    .filter((lane) => !laneFilter || lane.lane === laneFilter)
    .map((lane) => {
      const records = (lane.records || []).slice(0, perLane)
      // hiddenCount travels from the builder, but it was computed against the
      // builder's slice. Recompute against the slice actually shown or the
      // footer lies the moment `latest` changes.
      const shownFromTotal = Math.min(lane.total ?? records.length, records.length)
      return {
        ...lane,
        records: records.map((record) => ({
          ...record,
          nodeId: nodeId("mr", lane.lane, record.id),
          items: (record.items || []).map((item, index) => ({
            ...item,
            nodeId: nodeId("item", record.id, String(index)),
            status: NODE_STATUS[item.type] || "committed",
          })),
        })),
        shown: records.length,
        hiddenCount: Math.max(0, (lane.total ?? records.length) - shownFromTotal),
      }
    })

  const ownerActions = (data?.ownerActions || []).map((action) => ({
    ...action,
    nodeId: nodeId("oa", action.id),
    steps: (action.steps || []).map((step) => ({
      ...step,
      kind: STEP_KINDS.has(step.kind) ? step.kind : "decide",
    })),
  }))

  return {
    generatedAtLocal: data?.generatedAtLocal || null,
    timezone: data?.timezone || null,
    perLane,
    lanes,
    ownerActions,
    totals: data?.totals || {
      lanes: lanes.length,
      ownerActions: ownerActions.length,
      high: ownerActions.filter((a) => a.severity === "high").length,
    },
    isExpanded: (id) => expanded.has(id),
  }
}

/** Human-scale effort, for setting expectations before she opens anything. */
export function effortLabel(seconds) {
  if (seconds == null) return "effort unknown"
  if (seconds < 60) return `~${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes <= 1 ? "~1 min" : `~${minutes} min`
}

/**
 * Sydney-relative "how long ago", because a catch-up surface is read as a
 * timeline and an absolute stamp makes her do the arithmetic.
 * `now` is injectable so tests are not clock-dependent.
 */
export function agoLabel(iso, now = Date.now()) {
  const t = Date.parse(iso || "")
  if (!Number.isFinite(t)) return ""
  const seconds = Math.max(0, Math.round((now - t) / 1000))
  if (seconds < 90) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "yesterday" : `${days}d ago`
}

/** URL state: which nodes are open, how many per lane, which lane is focused. */
export function readBriefingLocation(href) {
  const url = new URL(href, "http://datascape.local/")
  const open = (url.searchParams.get("open") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    expanded: new Set(open),
    latest: clampLatest(url.searchParams.get("n"), null),
    laneFilter: url.searchParams.get("lane") || null,
  }
}

export function buildBriefingUrl(state, href) {
  const url = new URL(href, "http://datascape.local/")
  url.searchParams.set("view", "briefing")
  const open = [...(state.expanded || [])]
  if (open.length) url.searchParams.set("open", open.join(","))
  else url.searchParams.delete("open")
  if (state.latest != null) url.searchParams.set("n", String(state.latest))
  else url.searchParams.delete("n")
  if (state.laneFilter) url.searchParams.set("lane", state.laneFilter)
  else url.searchParams.delete("lane")
  return url
}

export function writeBriefingLocation(state, mode = "replace") {
  if (typeof window === "undefined") return
  const url = buildBriefingUrl(state, window.location.href)
  const method = mode === "push" ? "pushState" : "replaceState"
  window.history[method](null, "", `${url.pathname}${url.search}${url.hash}`)
}

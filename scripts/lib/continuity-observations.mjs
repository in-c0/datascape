import { createHash } from "node:crypto";

export const OBSERVATION_KINDS = new Set([
  "state",
  "activity",
  "commitment",
  "decision",
  "hypothesis",
  "evidence",
  "blocker",
  "metric",
  "objective",
  "exception",
  "relationship",
  "cognition",
]);

export const EPISTEMIC_CLASSES = new Set(["observed", "reported", "inferred", "projected"]);
export const TIME_PRECISIONS = new Set(["instant", "day", "month", "unknown"]);

const asIso = (value, precision = "instant") => {
  if (!value) return null;
  if (precision === "month" && /^\d{4}-\d{2}$/.test(value)) return `${value}-01T00:00:00.000Z`;
  if (precision === "day" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const stableId = (parts) =>
  `obs_${createHash("sha256").update(parts.map((x) => String(x ?? "")).join("\u241f")).digest("hex").slice(0, 16)}`;

export function makeObservation({
  kind,
  observedAt,
  occurredAt = null,
  timePrecision = "unknown",
  epistemic,
  source,
  scope,
  summary,
  confidence,
  payload,
}) {
  if (!OBSERVATION_KINDS.has(kind)) throw new Error(`unsupported observation kind: ${kind}`);
  if (!EPISTEMIC_CLASSES.has(epistemic)) throw new Error(`unsupported epistemic class: ${epistemic}`);
  if (!TIME_PRECISIONS.has(timePrecision)) throw new Error(`unsupported time precision: ${timePrecision}`);
  if (!source?.kind || !source?.ref) throw new Error("observation source requires kind + ref");
  if (!String(summary || "").trim()) throw new Error("observation requires summary");

  const observedIso = asIso(observedAt, "instant");
  if (!observedIso) throw new Error(`invalid observedAt: ${observedAt}`);
  const occurredIso = occurredAt ? asIso(occurredAt, timePrecision) : null;
  if (occurredAt && !occurredIso) throw new Error(`invalid occurredAt: ${occurredAt}`);

  // Identity deliberately excludes observedAt. Re-running an adapter over the
  // same source fact produces the same ID; a changed fact/summary produces a
  // new observation. This lets the observation cache merge idempotently.
  const id = stableId([
    source.kind,
    source.ref,
    kind,
    scope?.project,
    scope?.workstream,
    scope?.session,
    occurredIso,
    summary.trim(),
  ]);

  return {
    id,
    kind,
    observedAt: observedIso,
    occurredAt: occurredIso,
    timePrecision,
    epistemic,
    source,
    ...(scope && Object.keys(scope).length ? { scope } : {}),
    summary: summary.trim(),
    ...(confidence == null ? {} : { confidence }),
    ...(payload && Object.keys(payload).length ? { payload } : {}),
  };
}

export function mergeObservationDocuments(existing, incoming, generatedAt = new Date().toISOString()) {
  const byId = new Map();
  for (const obs of existing?.observations || []) byId.set(obs.id, obs);
  for (const obs of incoming?.observations || []) {
    // First observation time is retained for an unchanged fact. Source state
    // changes naturally receive a different stable ID.
    if (!byId.has(obs.id)) byId.set(obs.id, obs);
  }
  return {
    version: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    observations: [...byId.values()].sort((a, b) => {
      const ta = a.occurredAt || a.observedAt;
      const tb = b.occurredAt || b.observedAt;
      return ta.localeCompare(tb) || a.id.localeCompare(b.id);
    }),
  };
}

export function normalizeDatascapeBundle(
  { content = {}, thoughts = {}, evidence = {}, gitHistory = {}, provenance = {} },
  { generatedAt = new Date().toISOString(), thoughtLimit = 120 } = {},
) {
  const observedAt = new Date(generatedAt).toISOString();
  const observations = [];
  const projects = Array.isArray(content.projects) ? content.projects : [];
  const projectByIndex = projects.map((project) => project.id || project.title || null);

  for (const project of projects) {
    const projectId = project.id || project.title;
    if (!projectId) continue;
    if (project.status) {
      observations.push(
        makeObservation({
          kind: "state",
          observedAt,
          timePrecision: "unknown",
          epistemic: "reported",
          source: {
            kind: "project_manifest",
            ref: `content.json#project:${projectId}:status`,
            adapter: "datascape-standard",
          },
          scope: { project: projectId },
          summary: `${project.title || projectId} is ${project.status}.`,
          payload: {
            status: project.status,
            category: project.category ?? null,
            flagship: Boolean(project.flagship),
          },
        }),
      );
    }

    const ev = evidence?.[projectId];
    if (ev?.firstCommit) {
      observations.push(
        makeObservation({
          kind: "activity",
          observedAt,
          occurredAt: ev.firstCommit,
          timePrecision: "day",
          epistemic: "observed",
          source: {
            kind: "git",
            ref: `evidence.json#${projectId}:firstCommit`,
            adapter: "datascape-standard",
          },
          scope: { project: projectId },
          summary: `${project.title || projectId} has its first recorded commit.`,
          payload: { commitDate: ev.firstCommit },
        }),
      );
    }
    if (ev?.lastCommit) {
      observations.push(
        makeObservation({
          kind: "activity",
          observedAt,
          occurredAt: ev.lastCommit,
          timePrecision: "day",
          epistemic: "observed",
          source: {
            kind: "git",
            ref: `evidence.json#${projectId}:lastCommit`,
            adapter: "datascape-standard",
          },
          scope: { project: projectId },
          summary: `${project.title || projectId} has a recorded commit at the current edge of its repository history.`,
          payload: { commitDate: ev.lastCommit, commits: ev.commits ?? null },
        }),
      );
    }
    if (ev?.url || ev?.store) {
      const target = ev.url || ev.store;
      observations.push(
        makeObservation({
          kind: "evidence",
          observedAt,
          timePrecision: "unknown",
          epistemic: "observed",
          source: {
            kind: "project_manifest",
            ref: `evidence.json#${projectId}:publishedTarget`,
            adapter: "datascape-standard",
          },
          scope: { project: projectId },
          summary: `${project.title || projectId} has a recorded published target.`,
          payload: { target },
        }),
      );
    }

    const gh = gitHistory?.[projectId];
    if (gh?.lastCommit && gh.lastCommit !== ev?.lastCommit) {
      observations.push(
        makeObservation({
          kind: "activity",
          observedAt,
          occurredAt: gh.lastCommit,
          timePrecision: "day",
          epistemic: "observed",
          source: {
            kind: "git",
            ref: `git-history.json#${projectId}:lastCommit`,
            adapter: "datascape-standard",
          },
          scope: { project: projectId },
          summary: `${project.title || projectId} has a latest commit in the detailed git history.`,
          payload: { commitDate: gh.lastCommit },
        }),
      );
    }

    const prov = provenance?.[projectId];
    if (prov?.count || prov?.msgs) {
      observations.push(
        makeObservation({
          kind: "metric",
          observedAt,
          timePrecision: "unknown",
          epistemic: "observed",
          source: {
            kind: "metric",
            ref: `provenance.json#${projectId}`,
            adapter: "datascape-standard",
          },
          scope: { project: projectId },
          summary: `${project.title || projectId} has measured conversation provenance.`,
          payload: {
            conversations: prov.count ?? null,
            messages: prov.msgs ?? null,
            firstMonth: prov.firstMonth ?? null,
            lastMonth: prov.lastMonth ?? null,
          },
        }),
      );
    }
  }

  const allThoughts = Array.isArray(thoughts.thoughts) ? thoughts.thoughts : [];
  const recent = [...allThoughts]
    .map((thought, index) => ({ thought, index }))
    .sort((a, b) => String(a.thought.m || "").localeCompare(String(b.thought.m || "")))
    .slice(-Math.max(0, thoughtLimit));

  for (const { thought, index } of recent) {
    if (!thought.m || !thought.t) continue;
    const project = Number.isInteger(thought.pj) ? projectByIndex[thought.pj] || undefined : undefined;
    observations.push(
      makeObservation({
        kind: "cognition",
        observedAt,
        occurredAt: thought.m,
        timePrecision: "month",
        epistemic: "reported",
        source: {
          kind: "conversation",
          ref: `thoughts.json#thought:${index}`,
          adapter: "datascape-standard",
        },
        ...(project ? { scope: { project } } : {}),
        summary: thought.q ? `${thought.t}: ${thought.q}` : thought.t,
        payload: {
          title: thought.t,
          messages: thought.n ?? null,
          project: project ?? null,
        },
      }),
    );
  }

  return {
    version: 1,
    generatedAt: observedAt,
    observations: observations.sort((a, b) => {
      const ta = a.occurredAt || a.observedAt;
      const tb = b.occurredAt || b.observedAt;
      return ta.localeCompare(tb) || a.id.localeCompare(b.id);
    }),
  };
}

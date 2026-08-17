export const adapter = {
  name: "synthetic-private-ops",
  async collect({ observedAt, makeObservation }) {
    return [
      makeObservation({
        kind: "state",
        observedAt,
        timePrecision: "unknown",
        epistemic: "reported",
        source: {
          kind: "project_manifest",
          ref: "synthetic-private#portfolio:datascape",
          adapter: "synthetic-private-ops",
        },
        scope: { project: "datascape" },
        summary: "Datascape Continuity workstream is active.",
        payload: { state: "active" },
      }),
      makeObservation({
        kind: "exception",
        observedAt,
        occurredAt: "2026-08-18T00:00:00Z",
        timePrecision: "instant",
        epistemic: "reported",
        source: {
          kind: "exception",
          ref: "synthetic-private#exception:owner-input",
          adapter: "synthetic-private-ops",
        },
        scope: { project: "datascape", workstream: "continuity" },
        summary: "One Continuity integration item is blocked on owner input.",
        payload: { severity: "medium", status: "blocked-on-owner" },
      }),
    ];
  },
};

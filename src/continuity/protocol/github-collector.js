// A bounded, read-only GitHub observation source — spec V5.2B.
//
// Deliberately not a webhook, not a firehose, not background infrastructure: a
// historical collector over a named repository, small enough to audit.
//
// The write-safety property is structural rather than promised. This module
// exposes no mutating operation at all — there is no merge, comment, label,
// close or rerun anywhere in its interface, so a caller cannot reach one by
// mistake or by a future edit that "just adds a parameter". The reader it takes
// is injected, which is also what lets CI run with zero network calls.

export const NATIVE_TYPES = [
  "github.pull_request.opened",
  "github.pull_request.closed",
  "github.pull_request.merged",
  "github.check.completed",
  "github.workflow.completed",
];

/**
 * Build a collector.
 *
 * `read` performs one read-only query and returns parsed JSON. It is the only
 * capability this object has.
 */
export function createGithubCollector({ read, readDetail = null }) {
  if (typeof read !== "function") throw new Error("a read-only reader is required");

  return {
    readOnly: true,
    /**
     * Collect native observations for one repository.
     *
     * Native types are NOT collapsed here — a merge, a close and a check
     * completion stay distinct source facts. Mapping to canonical kinds is the
     * protocol adapter's job, and doing it in the collector would bake one
     * interpretation into the source record itself.
     */
    async observe(repo, { limit = 40 } = {}) {
      const pulls = await read(["pr", "list", "--repo", repo, "--state", "all", "--limit", String(limit),
        "--json", "number,title,author,createdAt,closedAt,mergedAt,state,headRefOid,url,isDraft"]);
      if (!Array.isArray(pulls)) return { blocked: "unexpected pull request payload", native: [] };

      const native = [];
      for (const pr of pulls) {
        const actor = pr.author?.login || null;
        // GitHub marks App/Bot authors explicitly; anything else is a human
        // login as far as this API can establish, and absence stays unknown.
        const type = pr.author?.is_bot || pr.author?.type === "Bot" ? "bot" : actor ? "human" : "unknown";

        native.push({
          native_type: "github.pull_request.opened",
          repo, number: pr.number, title: pr.title,
          actor, actor_type: type,
          created_at: pr.createdAt, updated_at: pr.closedAt || pr.createdAt,
          head_sha: pr.headRefOid || null, url: pr.url || null,
        });

        if (pr.mergedAt) {
          // Who MERGED is a different fact from who authored, and the list
          // endpoint does not carry it. Ask for it explicitly rather than
          // letting the author stand in — that substitution is exactly the
          // provenance leak the actor ruling forbids. If it cannot be
          // established the initiator stays unknown.
          let mergedBy = pr.mergedBy?.login || null;
          if (!mergedBy && readDetail) {
            const detail = await readDetail(repo, pr.number).catch(() => null);
            mergedBy = detail?.mergedBy?.login || null;
          }
          native.push({
            native_type: "github.pull_request.merged",
            repo, number: pr.number, title: pr.title,
            actor: mergedBy,
            actor_type: mergedBy ? "human" : "unknown",
            created_at: pr.mergedAt, updated_at: pr.mergedAt,
            head_sha: pr.headRefOid || null, url: pr.url || null,
          });
        } else if (pr.closedAt) {
          native.push({
            native_type: "github.pull_request.closed",
            repo, number: pr.number, title: pr.title,
            actor: null, actor_type: "unknown",
            created_at: pr.closedAt, updated_at: pr.closedAt,
            head_sha: pr.headRefOid || null, url: pr.url || null,
          });
        }
      }
      return { blocked: null, native };
    },
  };
}

/** Map a native observation into adapter input. Provenance fields only. */
export function toAdapterInput(native) {
  const action = native.native_type === "github.pull_request.merged" ? "merged"
    : native.native_type === "github.pull_request.closed" ? "closed"
      : native.native_type === "github.pull_request.opened" ? "opened" : "observed";
  return {
    repo: native.repo,
    number: native.number,
    action,
    at: native.created_at,
    observedAt: native.updated_at,
    actor: native.actor,
    actorType: native.actor_type,
    title: native.title,
    // An explicit, grounded cross-system reference. Co-reference is established
    // by this, never by prose resembling another event's prose.
    externalRef: native.url,
  };
}

/**
 * An immutable snapshot record for a real run.
 *
 * Carries identity and a payload hash so two runs are comparable. Carries no
 * credential, no token, and no raw API archive — this is provenance, not a
 * mirror of GitHub.
 */
export function snapshotOf(repo, native, at) {
  const ids = native.map((n) => `${n.repo}#${n.number}:${n.native_type}`);
  return {
    snapshot_at: at,
    repository: repo,
    native_event_count: native.length,
    native_ids: ids,
    payload_hash: hash(ids.join("|") + native.map((n) => n.created_at).join("|")),
  };
}

function hash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Source fidelity, which is the FIRST GitHub gate.
 *
 * Not equivalence: there was never an old GitHub ingestion path to be
 * equivalent to. The question is only whether the canonical event still says
 * what the source said.
 */
export function auditGithubFidelity(native, events) {
  const byId = new Map(events.map((e) => [e.native_id, e]));
  const failures = [];
  for (const n of native) {
    const action = n.native_type.split(".").pop();
    const id = `${n.repo}#${n.number}:${action === "opened" ? "opened" : action}`;
    const event = byId.get(id);
    if (!event) { failures.push({ id, reason: "no canonical event" }); continue; }
    if (event.text !== n.title) failures.push({ id, reason: "title not preserved exactly" });
    if (event.occurred_at !== n.created_at) failures.push({ id, reason: "timestamp not preserved" });
    if (event.authorship !== "external_system") failures.push({ id, reason: "authorship must be external_system" });
    if (event.actor?.type !== n.actor_type) failures.push({ id, reason: "actor type not preserved" });
    if (n.actor_type === "unknown" && event.trigger !== "unknown") {
      failures.push({ id, reason: "trigger asserted without an established initiator" });
    }
    if (event.external_ref !== (n.url || null)) failures.push({ id, reason: "external reference not preserved" });
    for (const rel of event.relations || []) {
      if (rel.kind === "causes" || rel.kind === "caused_by") failures.push({ id, reason: "causal edge present" });
    }
  }
  return { audited: native.length, failures };
}

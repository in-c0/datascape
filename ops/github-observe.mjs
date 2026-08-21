// github:observe — the real, local, read-only collector run (spec V5.2B).
//
// Uses the `gh` CLI so no token is ever read, stored or printed by this
// process. Only read subcommands are issued, and the collector itself has no
// mutating capability to reach.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { auditGithubFidelity, createGithubCollector, snapshotOf, toAdapterInput } from "../src/continuity/protocol/github-collector.js";
import { githubAdapter } from "../src/continuity/protocol/adapters.js";
import { dedupe } from "../src/continuity/protocol/event.js";

const run = promisify(execFile);
const REPO = process.argv[2] || "in-c0/datascape";
const OUT = process.env.SHADOW_OUT_DIR || "D:/Projects/_hub/shadow/continuity/v5.2/github";

/** The only capability handed to the collector: one read-only gh query. */
const read = async (args) => {
  // Refuse anything that is not a read. Defence in depth: the collector has no
  // write path, and this reader would not carry one out if asked.
  const WRITES = ["merge", "close", "comment", "edit", "review", "delete", "create", "rerun", "label"];
  if (args.some((a) => WRITES.includes(a))) throw new Error(`refusing non-read gh operation: ${args.join(" ")}`);
  const { stdout } = await run("gh", args, { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};

let native = [];
let blocked = null;
try {
  const readDetail = (repo, number) =>
    read(["pr", "view", String(number), "--repo", repo, "--json", "mergedBy,number"]);
  const collector = createGithubCollector({ read, readDetail });
  const result = await collector.observe(REPO, { limit: 40 });
  blocked = result.blocked;
  native = result.native;
} catch (error) {
  // A missing or unauthenticated gh is a genuine collector blocker. Reporting
  // it is the correct outcome; substituting synthetic results and calling them
  // real would make every number downstream a fiction.
  blocked = `collector blocked: ${String(error.message).split("\n")[0]}`;
}

if (blocked) {
  console.log(JSON.stringify({ repository: REPO, blocked, native_events: 0, network_writes: 0 }, null, 2));
  process.exit(1);
}

const { events, rejected } = githubAdapter.ingest(native.map(toAdapterInput));
const { events: canonical } = dedupe(events);
const { events: twice } = dedupe([...events, ...githubAdapter.ingest(native.map(toAdapterInput)).events]);
const fidelity = auditGithubFidelity(native, canonical);
const snapshot = snapshotOf(REPO, native, new Date(Date.parse(native[0]?.created_at || 0) || 0).toISOString());

const byInitiator = { human: 0, bot: 0, app: 0, unknown: 0 };
for (const e of canonical) byInitiator[e.actor?.type || "unknown"] += 1;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "snapshot.json"), JSON.stringify(snapshot, null, 2));

console.log(JSON.stringify({
  repository: REPO,
  blocked: null,
  native_events: native.length,
  native_types: [...new Set(native.map((n) => n.native_type))],
  canonical_events: canonical.length,
  rejected: rejected.length,
  initiators: byInitiator,
  double_import_delta: twice.length - canonical.length,
  fidelity_failures: fidelity.failures,
  snapshot: { snapshot_at: snapshot.snapshot_at, payload_hash: snapshot.payload_hash, count: snapshot.native_event_count },
  // Structural, not a claim: the collector exposes no write operation and the
  // reader refuses non-read subcommands.
  network_writes: 0,
}, null, 2));

process.exit(fidelity.failures.length === 0 && rejected.length === 0 ? 0 : 1);

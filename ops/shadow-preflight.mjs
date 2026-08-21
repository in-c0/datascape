// shadow:preflight — v3.2 PR-A review.
//
// Runs the exact path a real shadow run will take, up to but excluding network
// dispatch. The point is to make the future owner ruling almost boring: once a
// credential appears, the only new variable should be the model's response.
//
// It reads the REAL Security corpus from the authoritative exception store. It
// writes only safe aggregate metadata to stdout; the redacted corpus and the
// assembled payload stay in the local shadow directory and are never committed.
import fs from "node:fs";
import path from "node:path";
import { buildSecuritySnapshot, createProposer } from "../src/continuity/shadow/snapshot.js";
import { buildRequest, createTransport, instructionIsCorpusFree, MODE_PREFLIGHT, PROMPT_TEMPLATE } from "../src/continuity/shadow/request.js";
import { outboundGate } from "../src/continuity/shadow/outbound.js";

const EXCEPTIONS_DIR = process.env.SHADOW_EXCEPTIONS_DIR || "D:/Projects/_ship_inbox/exceptions";
const SHADOW_DIR = process.env.SHADOW_OUT_DIR || "D:/Projects/_hub/shadow/continuity/v3.2/security";
const DOMAIN = process.argv[2] || "security";

/**
 * Read the authoritative Security records.
 *
 * An exception file is the authored record; its front matter carries the
 * domain. Nothing is synthesised here — if the corpus is empty, the preflight
 * says so rather than inventing a corpus to exercise.
 */
function readSecurityCorpus() {
  if (!fs.existsSync(EXCEPTIONS_DIR)) return { records: [], exceptions: [], missing: EXCEPTIONS_DIR };
  const records = [];
  const exceptions = [];
  for (const file of fs.readdirSync(EXCEPTIONS_DIR)) {
    if (!file.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(EXCEPTIONS_DIR, file), "utf8");
    const loop = (raw.match(/^loop:\s*(.+)$/m) || [])[1]?.trim() || "";
    if (!loop.toLowerCase().startsWith(`${DOMAIN}/`)) continue;
    const id = (raw.match(/^id:\s*(.+)$/m) || [])[1]?.trim() || file.replace(/\.md$/, "");
    const title = (raw.match(/^title:\s*(.+)$/m) || [])[1]?.trim() || "";
    const opened = (raw.match(/^opened:\s*(.+)$/m) || [])[1]?.trim() || null;
    const severity = (raw.match(/^severity:\s*(.+)$/m) || [])[1]?.trim() || null;
    const body = raw.replace(/^---[\s\S]*?---\n/, "");
    const evidence = (body.match(/##\s*Evidence\s*\n+([\s\S]*?)(?=\n##|$)/) || [])[1]?.trim() || "";
    const proposed = (body.match(/##\s*Proposed action\s*\n+([\s\S]*?)(?=\n##|$)/) || [])[1]?.trim() || "";

    // The finding itself is a source observation.
    records.push({
      id: `${id}#evidence`, lane: DOMAIN, domain: DOMAIN, at: opened, severity,
      kind: "risk", text: `${title}\n\n${evidence}`.trim(),
    });
    // The proposed action is the owner-facing half and stays a separate record,
    // so a projection cannot absorb the owner action into a summary of it.
    if (proposed) {
      records.push({
        id: `${id}#proposed`, lane: DOMAIN, domain: DOMAIN, at: opened, severity,
        kind: "owner_attention", ownerAction: true, text: proposed,
      });
    }
    exceptions.push({ id: `${id}#proposed`, sourceId: `${id}#evidence`, title, text: proposed || title });
  }
  return { records, exceptions, missing: null };
}

const { records, exceptions, missing } = readSecurityCorpus();
const snapshot = buildSecuritySnapshot(records, exceptions, { domain: DOMAIN });

if (missing) {
  console.log(JSON.stringify({ preflight_status: "blocked", reason: `exception store not found at ${missing}` }, null, 2));
  process.exit(1);
}
if (snapshot.blocked) {
  console.log(JSON.stringify({ preflight_status: "blocked", reason: snapshot.blocked, inventory: snapshot.inventory }, null, 2));
  process.exit(1);
}

// Build the request exactly as a real run would.
const request = buildRequest(snapshot, { promptTemplate: PROMPT_TEMPLATE });
const separation = instructionIsCorpusFree(request, snapshot);
const gate = outboundGate(request.data);

// A transport that would THROW if anything reached it. Preflight must complete
// without touching it; that is the kill switch under test, not an assumption.
let touched = 0;
const transport = createTransport({
  mode: MODE_PREFLIGHT,
  send: () => { touched += 1; throw new Error("preflight must never dispatch"); },
});
const dispatch = await transport.dispatch(request);

const payload = JSON.stringify(request.data);
const proposer = createProposer({ provider: "unconfigured", promptTemplate: PROMPT_TEMPLATE });
const manifest = proposer.manifest(snapshot);

const byType = {};
for (const entry of snapshot.secret_table) byType[entry.type] = (byType[entry.type] || 0) + 1;

// A genuine historical boundary, or an honest report that none exists (§13).
// Nothing is manufactured: the cutoff is chosen from real record times, and if
// two snapshots come back identical the answer is false.
function historicalBoundary() {
  const times = records.map((r) => Date.parse(r.at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 2) return { historical_replay_available: false, reason: "fewer than two dated records" };
  const earliest = times[0];
  const latest = times[times.length - 1];
  // The midpoint of the real span, so the split falls between actual events
  // rather than at a number chosen to produce a pleasing difference.
  const cut = new Date(earliest + Math.floor((latest - earliest) / 2)).toISOString();
  const t0 = buildSecuritySnapshot(records, exceptions, { domain: DOMAIN, cutoff: cut });
  if (t0.blocked || t0.source_count === snapshot.source_count) {
    return { historical_replay_available: false, reason: "no meaningful observation separates the cutoffs" };
  }
  const t0Ids = new Set(t0.source_ids);
  return {
    historical_replay_available: true,
    t0_cutoff: cut,
    t0_snapshot_hash: t0.source_hash,
    t0_source_count: t0.source_count,
    t1_cutoff: null,
    t1_snapshot_hash: snapshot.source_hash,
    t1_source_count: snapshot.source_count,
    added_source_ids: snapshot.source_ids.filter((id) => !t0Ids.has(id)),
    removed_source_ids: t0.source_ids.filter((id) => !snapshot.source_ids.includes(id)),
  };
}

const report = {
  preflight_status: gate.decision === "ALLOW" && separation.clean && touched === 0 ? "ready" : "aborted",
  domain: DOMAIN,
  snapshot_hash: snapshot.source_hash,
  source_count: snapshot.source_count,
  exception_count: snapshot.exception_count,
  explicit_reference_additions: snapshot.reference_hop_count,
  redacted_secret_count_by_type: byType,
  withheld_record_count: snapshot.withheld_count,
  outbound_payload_bytes: Buffer.byteLength(payload, "utf8"),
  outbound_payload_hash: snapshot.source_hash,
  prompt_version: manifest.proposer.prompt_version,
  candidate_schema_version: snapshot.schema_version,
  outbound_gate: { decision: gate.decision, findings: gate.findings.length, scanner: gate.scanner },
  prompt_source_separation: separation,
  network_requests_made: touched,
  transport: dispatch.reason,
  historical: historicalBoundary(),
};

// Artifacts stay local and uncommitted; only the safe aggregate is printed.
fs.mkdirSync(SHADOW_DIR, { recursive: true });
fs.writeFileSync(path.join(SHADOW_DIR, "preflight-report.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(SHADOW_DIR, "source-redacted.jsonl"),
  snapshot.redacted.map((r) => JSON.stringify(r)).join("\n"));

console.log(JSON.stringify(report, null, 2));
process.exit(report.preflight_status === "ready" ? 0 : 1);

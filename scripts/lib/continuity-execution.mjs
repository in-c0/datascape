import { createHash } from "node:crypto";

export const EXECUTION_RESULTS = new Set([
  "success",
  "timeout",
  "explicit-limit",
  "blocked",
  "error",
]);

export const EXECUTION_SERVICES = new Set([
  "chatgpt",
  "github",
  "vercel",
  "cloudflare",
  "web",
  "other",
  "unknown",
]);

export const EXECUTION_LATENCY = new Set(["normal", "slow", "very-slow", "unknown"]);

const stableId = (parts) =>
  `run_${createHash("sha256").update(parts.map((x) => String(x ?? "")).join("\u241f")).digest("hex").slice(0, 16)}`;

export function makeExecutionRecord({
  time,
  worker,
  project,
  sequence,
  result,
  serviceAtFailure = "unknown",
  artifactProgress = false,
  latency = "unknown",
  artifactRef = null,
  note = null,
}) {
  const occurredAt = new Date(time);
  if (Number.isNaN(occurredAt.getTime())) throw new Error(`invalid execution time: ${time}`);
  if (!String(worker || "").trim()) throw new Error("execution record requires worker");
  if (!String(project || "").trim()) throw new Error("execution record requires project");
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("execution sequence must be a positive integer");
  if (!EXECUTION_RESULTS.has(result)) throw new Error(`unsupported execution result: ${result}`);
  if (!EXECUTION_SERVICES.has(serviceAtFailure)) throw new Error(`unsupported execution service: ${serviceAtFailure}`);
  if (!EXECUTION_LATENCY.has(latency)) throw new Error(`unsupported execution latency: ${latency}`);

  return {
    id: stableId([worker.trim(), project.trim(), sequence, occurredAt.toISOString()]),
    time: occurredAt.toISOString(),
    worker: worker.trim(),
    project: project.trim(),
    sequence,
    result,
    serviceAtFailure,
    artifactProgress: Boolean(artifactProgress),
    latency,
    ...(artifactRef ? { artifactRef } : {}),
    ...(note ? { note: String(note).trim() } : {}),
  };
}

export function summarizeExecutionWindow(records = []) {
  const summary = {
    runsAttempted: records.length,
    runsSuccessful: 0,
    timeouts: 0,
    explicitLimits: 0,
    usefulProgressRuns: 0,
    humanBlockers: 0,
    serviceFailures: {},
  };

  for (const record of records) {
    if (record.result === "success") summary.runsSuccessful += 1;
    if (record.result === "timeout") summary.timeouts += 1;
    if (record.result === "explicit-limit") summary.explicitLimits += 1;
    if (record.artifactProgress) summary.usefulProgressRuns += 1;
    if (record.result === "blocked" && record.serviceAtFailure === "other") summary.humanBlockers += 1;
    if (record.result !== "success") {
      summary.serviceFailures[record.serviceAtFailure] = (summary.serviceFailures[record.serviceAtFailure] || 0) + 1;
    }
  }

  return summary;
}

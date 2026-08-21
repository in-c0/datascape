// The supported manual owner CLI (spec V6.1.6-A.2 PR B).
//
// It exists so that closing the browser bypass does not just move the bypass to
// a terminal. It performs owner rulings through the SAME orchestration the HTTP
// route uses — canonical prepared mutation, idempotency before prompting,
// verification, staleness after, one-shot presence, then the exact mutation.
//
// An agent may run this. It will get a bounded Windows prompt and nothing else:
// without a human at the machine the ruling does not complete. That is the
// intended shape — the CLI is not privileged, it is merely convenient.
//
// Lanes withdrawing their own question do not come through here at all; they
// use `--withdraw`, which is lane authority and is recorded as a withdrawal so
// nobody later reads it as her decision.
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

// The orchestration and the policy come from the repo, because argument parsing
// and the withdraw/rule split are this CLI's own logic. The SECURITY layer does
// not: `realDeps()` loads it from the deployed host, so a manual owner ruling
// runs the same reviewed bytes the HTTP route does. Importing the orchestrator
// from here would reintroduce exactly the drift the deployment rule exists to
// prevent — a security layer read out of a mutable working tree.
import { OWNER_ACTIONS, performOwnerRuling } from "../src/continuity/control/owner-ruling.js";
import { authorizeTransition, LANE_WITHDRAWAL_STATUS } from "../src/continuity/control/owner-ruling-policy.js";

export const USAGE = [
  "node ops/owner-rule.mjs <exception-id> <action> [--note \"...\"] [--until <iso>]",
  `  action: ${OWNER_ACTIONS.join(" | ")}`,
  "",
  "node ops/owner-rule.mjs <exception-id> --withdraw --note \"why the lane no longer needs her\"",
  "  lane authority; returns the item to the lane, never records an owner ruling",
].join("\n");

export function parseArgs(argv) {
  const [id, maybeAction, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith("--")) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  if (maybeAction === "--withdraw") return { id, withdraw: true, ...flags };
  return { id, action: maybeAction, ...flags };
}

/**
 * @param deps.host the live-host module (exception access + mutation)
 */
export async function runOwnerRule(argv, deps) {
  const args = parseArgs(argv);
  if (!args.id) return { ok: false, failure: "usage", detail: USAGE };

  const current = deps.readException(args.id);
  if (!current) return { ok: false, failure: "unknown_exception", detail: `no exception ${args.id}` };

  if (args.withdraw) {
    // Lane authority. Deliberately cannot resolve: taking a question back is
    // not the same as it having been answered.
    const verdict = authorizeTransition({ from: current.status, to: LANE_WITHDRAWAL_STATUS });
    if (!verdict.ok) return { ok: false, failure: verdict.failure, detail: verdict.remedy };
    const note = typeof args.note === "string" ? args.note : "";
    return {
      ok: true, class: verdict.class, prompt_shown: false,
      result: deps.withdraw({ id: current.id, status: LANE_WITHDRAWAL_STATUS, note, record_as: verdict.record_as }),
    };
  }

  if (!OWNER_ACTIONS.includes(args.action)) {
    return { ok: false, failure: "invalid_action", detail: USAGE };
  }

  // A CLI invocation is one user action, so it gets one operation id derived
  // from what it asks for — a rerun of the identical command after an ambiguous
  // failure replays rather than ruling twice.
  const operation_id = `cli-${crypto.createHash("sha256")
    .update(JSON.stringify([current.id, args.action, args.note ?? "", args.until ?? ""]))
    .digest("hex").slice(0, 24)}`;

  const outcome = await performOwnerRuling({
    request: { id: current.id, action: args.action, note: args.note, until: args.until, operation_id },
    readException: deps.readException,
    applyMutation: deps.applyMutation,
    verifier: deps.verifier,
    journal: deps.journal,
    budget: deps.budget,
    now: deps.now,
  });

  if (!outcome.ok) return { ok: false, failure: outcome.failure, detail: outcome.reason, prompt_shown: outcome.prompt_shown };
  return {
    ok: true, class: "owner_ruling", replayed: Boolean(outcome.replayed),
    prompt_shown: outcome.prompt_shown, ruling_ref: outcome.operation_ref ?? outcome.result?.ruling_ref,
    result: outcome.result,
  };
}

/** The real dependencies. Built only when the CLI is actually invoked. */
export async function realDeps({ liveDir = "D:/Projects/_ship_inbox/ops", now = () => Date.now() } = {}) {
  const url = (file) => `file:///${path.resolve(liveDir, file).split(path.sep).join("/")}`;
  const host = await import(url("briefing-server.mjs"));
  // The DEPLOYED security layer, not the repo's copy of it.
  const ruling = await import(url("_continuity/owner-ruling.js"));
  const presence = await import(url("_continuity/owner-presence.js"));
  const windows = await import(url("_continuity/owner-presence-windows.js"));

  const journalFile = process.env.OWNER_RULING_JOURNAL
    || path.join(process.env.LOCALAPPDATA || liveDir, "datascape", "live-host", "owner-rulings.json");
  // The same journal file the host uses, so a CLI retry of a ruling the browser
  // already completed replays instead of prompting her twice.
  const journal = ruling.createRulingJournal({ storage: ruling.createRulingJournalStorage(journalFile), now });
  journal.recover(host.readException);

  return {
    now,
    readException: host.readException,
    applyMutation: host.applyOwnerMutation,
    withdraw: host.withdrawOwnerQuestion,
    journal,
    budget: ruling.createPromptBudget({ now }),
    verifier: presence.createOwnerPresenceVerifier({
      // Interactive, because a human is expected to be standing here. This is
      // the ONLY place in the system that asks Windows to show a dialog.
      broker: windows.createWindowsOwnerPresenceBroker({ allowInteractive: true }),
      now,
      randomChallenge: () => crypto.randomUUID(),
    }),
  };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === `file:///${process.argv[1].split(path.sep).join("/")}`;
if (invokedDirectly) {
  const result = await runOwnerRule(process.argv.slice(2), await realDeps());
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

// The supported manual owner CLI (spec V6.1.6-A.2 PR B).
//
// It exists so that closing the browser bypass does not just move the bypass to
// a terminal. It performs owner rulings through the SAME orchestration the HTTP
// route uses, and — this is the part the first version got wrong — through the
// same DEPLOYED BYTES.
//
// The first version imported `performOwnerRuling` and the transition policy at
// the top of this file, from `../src/continuity/control/`. `realDeps()` dutifully
// loaded the deployed modules and then nothing used them, so the HTTP route ran
// reviewed code while the CLI ran whatever happened to be checked out. That is
// the exact drift the file-set deployment rule exists to prevent, reintroduced
// through the terminal.
//
// So this file is now a SHELL: argument parsing and process plumbing. Every
// security decision — which classes exist, what the transaction does, what the
// policy permits — comes from the deployed artifact at call time.
//
// An agent may run this. It will get a bounded Windows prompt and nothing else:
// without a human at the machine the ruling does not complete.
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export const DEFAULT_LIVE_DIR = "D:/Projects/_ship_inbox/ops";

export function usage(actions = []) {
  return [
    "node ops/owner-rule.mjs <exception-id> <action> [--note \"...\"] [--until <iso>]",
    actions.length ? `  action: ${actions.join(" | ")}` : "",
    "",
    "An owner ruling requires the owner. Running this without a human at the",
    "machine produces one bounded prompt and no ruling.",
  ].filter(Boolean).join("\n");
}

export function parseArgs(argv) {
  const [id, ...rest] = argv;
  const flags = {};
  let action;
  for (let i = 0; i < rest.length; i += 1) {
    // The action is the first bare word. Anything starting with `--` is a flag,
    // including in the action position — otherwise `<id> --withdraw` parsed as
    // an action literally named "--withdraw" and never reached the check that
    // refuses it.
    if (!rest[i].startsWith("--")) {
      if (action === undefined) action = rest[i];
      continue;
    }
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return { id, action, ...flags };
}

/**
 * `--withdraw` is deliberately absent.
 *
 * "The filing lane may take its own question back" is a sound idea and a
 * genuinely useful escape from a queue full of stale gates. But this CLI has no
 * trustworthy caller identity: any local process could have run
 *
 *   owner-rule <somebody-else's-gate> --withdraw
 *
 * and removed an item from her queue with no presence and no lane check. That
 * is not lane authority, it is an unauthenticated process claiming it. It comes
 * back when an authenticated lane-control path can establish
 * `caller lane == filing lane`, and not before.
 */
export async function runOwnerRule(argv, deps) {
  const args = parseArgs(argv);
  const actions = deps.OWNER_ACTIONS ?? [];
  if (!args.id) return { ok: false, failure: "usage", detail: usage(actions) };
  if (args.withdraw) {
    return {
      ok: false, failure: "unsupported",
      detail: "lane withdrawal is not available: this interface cannot establish which lane is calling.",
    };
  }

  const current = deps.readException(args.id);
  if (!current) return { ok: false, failure: "unknown_exception", detail: `no exception ${args.id}` };
  if (!actions.includes(args.action)) return { ok: false, failure: "invalid_action", detail: usage(actions) };

  // One CLI invocation is one user action, so its operation id is derived from
  // what it asks for — rerunning the identical command after an ambiguous
  // failure replays rather than ruling twice.
  const operation_id = `cli-${crypto.createHash("sha256")
    .update(JSON.stringify([current.id, args.action, args.note ?? "", args.until ?? ""]))
    .digest("hex").slice(0, 24)}`;

  const outcome = await deps.performOwnerRuling({
    request: { id: current.id, action: args.action, note: args.note, until: args.until, operation_id },
    readException: deps.readException,
    applyMutation: deps.applyMutation,
    verifier: deps.verifier,
    journal: deps.journal,
    budget: deps.budget,
    now: deps.now,
  });

  if (!outcome.ok) {
    return { ok: false, failure: outcome.failure, detail: outcome.reason, prompt_shown: outcome.prompt_shown };
  }
  return {
    ok: true, replayed: Boolean(outcome.replayed), prompt_shown: outcome.prompt_shown,
    ruling_ref: outcome.operation_ref ?? outcome.result?.ruling_ref,
    result: outcome.result,
  };
}

/**
 * Load the DEPLOYED security layer and build the real dependencies.
 *
 * Every module here comes from the live host's `_continuity/`. Nothing security
 * relevant is imported from this repository at run time.
 */
export async function realDeps({ liveDir = DEFAULT_LIVE_DIR, now = () => Date.now() } = {}) {
  const url = (file) => pathToFileURL(path.resolve(liveDir, file)).href;
  const host = await import(url("briefing-server.mjs"));
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
    OWNER_ACTIONS: ruling.OWNER_ACTIONS,
    performOwnerRuling: ruling.performOwnerRuling,
    readException: host.readException,
    applyMutation: host.applyOwnerMutation,
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

// pathToFileURL, not a hand-built `file:///` + path. On POSIX the manual form
// produced `file:////home/...` — four slashes — so this test was false and the
// entry point silently did nothing when spawned. It only ever worked because
// Windows paths start with a drive letter.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = await runOwnerRule(process.argv.slice(2), await realDeps());
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

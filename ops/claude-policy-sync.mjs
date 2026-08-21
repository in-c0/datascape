// Give the owner-gated exception rule provenance.
//
// `D:\Projects\CLAUDE.md` is the instruction file every lane on this machine
// reads, and it is under no version control at all. When the exception store
// began enforcing the owner gate, that document's standing instruction started
// contradicting an enforced machine invariant, so I corrected it in place — and
// a security rule every lane consumes then existed as a file with no history
// behind it, no review, and no way to tell what it said yesterday.
//
// This fixes the provenance without seizing the file. The canonical text lives
// in Git at `ops/policy/owner-gated-exceptions.md`. Here we manage exactly ONE
// bounded block inside CLAUDE.md:
//
//   <!-- DATASCAPE:OWNER-GATED-EXCEPTIONS:BEGIN -->
//   ...canonical text...
//   <!-- DATASCAPE:OWNER-GATED-EXCEPTIONS:END -->
//
// Everything outside those markers is somebody else's writing and is never
// touched. CLAUDE.md does not become a DataScape-owned file; one paragraph of it
// becomes a DataScape-managed quotation.
//
// Refuses rather than guesses: duplicate or crossed markers, or a first install
// with no recognised anchor, both stop. A sync tool that repairs an ambiguous
// document is a tool that silently rewrites instructions nobody reviewed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BEGIN = "<!-- DATASCAPE:OWNER-GATED-EXCEPTIONS:BEGIN -->";
export const END = "<!-- DATASCAPE:OWNER-GATED-EXCEPTIONS:END -->";

/** The canonical text, in version control. */
export const POLICY_SOURCE = path.join(HERE, "policy", "owner-gated-exceptions.md");

/** The real instruction file. Never written during a held PR. */
export const CLAUDE_MD = process.env.CLAUDE_MD_PATH || "D:/Projects/CLAUDE.md";

/**
 * Where the block goes on FIRST install: immediately after this paragraph.
 *
 * An anchor rather than a line number, because the file is hand-edited by
 * people and a line number would silently target the wrong paragraph the moment
 * anyone adds a sentence above it.
 */
export const FIRST_INSTALL_ANCHOR =
  "hides it from the only list she reads.";

const sha = (text) => crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

export function canonicalText() {
  return fs.readFileSync(POLICY_SOURCE, "utf8").trim();
}

/** The exact bytes the managed block should contain, markers included. */
export function renderBlock(text = canonicalText()) {
  return `${BEGIN}\n<!-- Canonical source: datascape ops/policy/owner-gated-exceptions.md — edit there, not here. -->\n\n${text}\n\n${END}`;
}

/**
 * Where is the managed block, and is the document unambiguous about it?
 */
export function locateBlock(document) {
  const begins = [...document.matchAll(new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  const ends = [...document.matchAll(new RegExp(END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];

  if (begins.length === 0 && ends.length === 0) return { state: "absent" };
  if (begins.length !== 1 || ends.length !== 1) {
    return { state: "ambiguous", reason: `expected one marker pair, found ${begins.length} begin / ${ends.length} end` };
  }
  const start = begins[0].index;
  const stop = ends[0].index + END.length;
  if (stop <= start) {
    return { state: "ambiguous", reason: "the end marker appears before the begin marker" };
  }
  return { state: "present", start, stop, current: document.slice(start, stop) };
}

/**
 * Compute the new document. Pure — it writes nothing.
 *
 * Returns `changed: false` when the block already matches, which is what makes
 * a second sync byte-stable.
 */
export function planSync(document, text = canonicalText()) {
  const block = renderBlock(text);
  const found = locateBlock(document);

  if (found.state === "ambiguous") {
    return { ok: false, failure: "ambiguous_markers", reason: found.reason };
  }

  if (found.state === "present") {
    if (found.current === block) {
      return { ok: true, changed: false, action: "already_current", document, region: null };
    }
    const next = document.slice(0, found.start) + block + document.slice(found.stop);
    return {
      ok: true, changed: true, action: "updated", document: next,
      // Exactly where this plan wrote, so a caller can prove it wrote nowhere
      // else without normalising anything away.
      region: { action: "updated", start: found.start, stop: found.stop, newStop: found.start + block.length },
    };
  }

  // First install. Place it after the anchor paragraph, or refuse.
  const at = document.indexOf(FIRST_INSTALL_ANCHOR);
  if (at === -1) {
    return {
      ok: false, failure: "anchor_not_found",
      reason: `no first-install anchor in this document: ${JSON.stringify(FIRST_INSTALL_ANCHOR)}`,
    };
  }
  if (document.indexOf(FIRST_INSTALL_ANCHOR, at + 1) !== -1) {
    return { ok: false, failure: "anchor_ambiguous", reason: "the first-install anchor appears more than once" };
  }
  const insertAt = at + FIRST_INSTALL_ANCHOR.length;
  const inserted = `\n\n${block}`;
  const next = document.slice(0, insertAt) + inserted + document.slice(insertAt);
  return {
    ok: true, changed: true, action: "installed", document: next,
    region: { action: "installed", insertAt, insertedLength: inserted.length },
  };
}

/**
 * What did this change, outside the managed block?
 *
 * The answer must always be "nothing". Computed by removing each document's own
 * block and comparing the remainder, so a sync that nudged a byte elsewhere is
 * visible rather than trusted.
 */
export function unmanagedDelta(before, after, region) {
  // EXACT prefix/suffix comparison, with no whitespace normalisation anywhere.
  //
  // The first version stripped each document's block and then collapsed every
  // run of three-or-more newlines to two, because insertion introduces blank
  // lines. That normalisation also hid any UNRELATED blank-line change: a sync
  // that disturbed somebody's spacing three sections away would still have
  // reported "unmanaged bytes changed: 0".
  //
  // The plan knows exactly where it wrote. Compare against that, byte for byte.
  if (!region) return before === after ? 0 : 1;

  if (region.action === "installed") {
    const { insertAt, insertedLength } = region;
    if (before.slice(0, insertAt) !== after.slice(0, insertAt)) return 1;
    return before.slice(insertAt) === after.slice(insertAt + insertedLength) ? 0 : 1;
  }

  const { start, stop, newStop } = region;
  if (before.slice(0, start) !== after.slice(0, start)) return 1;
  return before.slice(stop) === after.slice(newStop) ? 0 : 1;
}

/**
 * Synchronise the block.
 *
 * `dryRun` is the default: this tool writes only when told to, and during a held
 * PR it is never told to touch the real file.
 */
export function sync({ file = CLAUDE_MD, text = canonicalText(), dryRun = true, backupDir = null } = {}) {
  let document;
  try {
    document = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, failure: "unreadable", reason: `${file}: ${error.message}` };
  }

  const plan = planSync(document, text);
  if (!plan.ok) return { ...plan, file, wrote: false };

  const result = {
    ok: true,
    file,
    action: plan.action,
    changed: plan.changed,
    dry_run: dryRun,
    before_hash: sha(document),
    after_hash: sha(plan.document),
    unmanaged_bytes_changed: unmanagedDelta(document, plan.document, plan.region),
    wrote: false,
  };
  if (result.unmanaged_bytes_changed !== 0) {
    return { ok: false, failure: "unmanaged_write", reason: "the plan would change bytes outside the managed block", ...result };
  }
  if (dryRun || !plan.changed) return result;

  // The exact previous bytes, before anything is replaced.
  const backups = backupDir ?? path.join(
    process.env.LOCALAPPDATA || path.dirname(file), "datascape", "claude-md-backups");
  fs.mkdirSync(backups, { recursive: true });
  const backup = path.join(backups, `CLAUDE.${result.before_hash.slice(0, 12)}.md`);
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, document);

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, plan.document);
  fs.renameSync(tmp, file);
  return { ...result, wrote: true, backup };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Report only. Writing is an explicit, non-default act, and during a held PR
  // it happens on temporary copies rather than on her instruction file.
  console.log(JSON.stringify(sync({ dryRun: !process.argv.includes("--write") }), null, 2));
}

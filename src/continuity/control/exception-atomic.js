// One authoritative exception write per owner ruling.
//
// The previous shape made three:
//
//   defer:  setDeferredUntil -> amend -> setStatus
//   others: amend -> setStatus
//
// Every gap between those is a half-commit. A crash after `amend` left the
// operation_ref in the file with the status never changed, and recovery — which
// only searched for the ref — called that committed, silently losing her
// ruling. A crash after `setDeferredUntil` did the reverse: a real change to
// the file with no ref, which recovery read as "nothing happened".
//
// So the whole end state is composed in memory and lands in a single
// temp-write + rename. A reader sees the exception before the ruling or after
// it, never between.
//
// This knows the store's file format rather than calling its mutators, because
// the mutators are individually durable and that is exactly the problem. The
// store's own bytes are recorded as deployment evidence for the same reason.
import fs from "node:fs";
import path from "node:path";

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse an exception file into frontmatter order, values, and body. */
export function parseException(raw) {
  const match = raw.match(FRONT);
  if (!match) throw new Error("this exception has no frontmatter");
  const keys = [];
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    keys.push(key);
    meta[key] = line.slice(at + 1).trim();
  }
  return { keys, meta, body: raw.slice(match[0].length) };
}

export function serializeException({ keys, meta, body }) {
  // Preserve key order, then append anything new — a ruling must not reshuffle
  // a file somebody else reads by eye.
  const ordered = [...keys, ...Object.keys(meta).filter((k) => !keys.includes(k))];
  const front = ordered.filter((k) => meta[k] !== undefined).map((k) => `${k}: ${meta[k]}`).join("\n");
  return `---\n${front}\n---\n${body}`;
}

/**
 * Apply an entire owner ruling to one exception, atomically.
 *
 * Returns the resulting state so the caller never has to re-read to find out
 * what it just did.
 */
export function applyRulingAtomically({ file, amendment, status = null, deferredUntil = null, at, statusNote = "" }) {
  const raw = fs.readFileSync(file, "utf8");
  const entry = parseException(raw);

  entry.meta.updated = at;
  if (deferredUntil) entry.meta.deferred_until = deferredUntil;
  if (status) entry.meta.status = status;

  // Her words, appended and never overwriting an earlier ruling.
  let body = `${entry.body}\n${amendment}\n`;
  if (status) {
    // The status line REFERS to the ruling rather than repeating it; writing
    // the amendment twice made one ruling look like two.
    body += `\n---\n\n**${at} → ${status}**${statusNote ? ` — ${statusNote}` : ""}\n`;
  }
  entry.body = body;

  const composed = serializeException(entry);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, composed, "utf8");
  fs.renameSync(tmp, file);

  return { status: entry.meta.status, deferred_until: entry.meta.deferred_until ?? null, updated: at };
}

/** Where the store keeps a given exception. */
export function exceptionFile(inbox, id) {
  return path.join(inbox, `${id}.md`);
}

// A stand-in for the host's exception store, for the acceptance world.
//
// The acceptance suite prefers the REAL `_ship_inbox/ops/exception.mjs`, which
// is the component that ultimately changes owner-gated state. This exists so
// the release gate still RUNS where `_ship_inbox` does not — in CI, on another
// machine, in a fresh clone. A gate that silently skips outside one laptop is
// not a gate.
//
// It implements only what an owner ruling touches, with the same observable
// semantics: frontmatter parsed the same way, `updated` bumped on every write,
// notes appended and never overwritten, and lookup by exact id or unique
// prefix. Every acceptance run records which implementation it exercised.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INBOX = process.env.EXCEPTION_INBOX || path.join(HERE, "..", "exceptions");

export const STATUSES = ["new", "investigating", "blocked-on-owner", "resolved"];

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function sydneyIso(date = new Date()) {
  const shifted = new Date(date.getTime() + 10 * 3600 * 1000);
  return `${shifted.toISOString().replace(/\.\d+Z$/, "")}+10:00`;
}

function parse(file) {
  const raw = fs.readFileSync(file, "utf8");
  const match = raw.match(FRONT);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length), file, front: match[1] };
}

function write(entry) {
  const front = Object.entries(entry.meta).map(([k, v]) => `${k}: ${v}`).join("\n");
  fs.writeFileSync(entry.file, `---\n${front}\n---\n${entry.body}`, "utf8");
}

function readAll() {
  if (!fs.existsSync(INBOX)) return [];
  return fs.readdirSync(INBOX)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parse(path.join(INBOX, f)))
    .filter(Boolean);
}

export function find(id) {
  const all = readAll();
  return all.find((e) => e.meta.id === id) || all.find((e) => String(e.meta.id).startsWith(id)) || null;
}

export function setStatus(id, status, note = "") {
  if (!STATUSES.includes(status)) throw new Error(`setStatus: status must be one of ${STATUSES.join("|")}`);
  const e = find(id);
  if (!e) return null;
  const now = sydneyIso();
  e.meta.status = status;
  e.meta.updated = now;
  e.body += `\n---\n\n**${now} → ${status}**${note ? ` — ${note}` : ""}\n`;
  write(e);
  return e.meta.id;
}

export function amend(id, { note = "" } = {}) {
  const e = find(id);
  if (!e) return null;
  const now = sydneyIso();
  e.meta.updated = now;
  if (note) e.body += `\n${note}\n`;
  write(e);
  return e.meta.id;
}

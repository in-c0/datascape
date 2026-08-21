// Static import reachability — spec V6.1.5 PR B §1, §15.
//
// The review route's safety is a claim about its DEPENDENCY GRAPH, so it has to
// be checked against the graph rather than against a runtime flag. A module
// that cannot import a writer cannot write, no matter what a query string says
// or what a future edit forgets.
//
// Deliberately static: it reads source and follows relative imports. A runtime
// probe would only tell us about the paths that happened to execute.

import fs from "node:fs";
import path from "node:path";

const IMPORT_RE = /(?:^|\n)\s*(?:import[\s\S]*?from\s*|export[\s\S]*?from\s*)["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Walk every module reachable from `entry` by relative import.
 *
 * Bare specifiers (react, node:*) are ignored: they cannot be this project's
 * authority writer, and following them would drag in the world.
 */
export function importGraph(entry, seen = new Set()) {
  const resolved = resolveModule(entry);
  if (!resolved || seen.has(resolved)) return seen;
  seen.add(resolved);

  const source = fs.readFileSync(resolved, "utf8");
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match) {
      const spec = match[1];
      if (spec.startsWith(".")) importGraph(path.resolve(path.dirname(resolved), spec), seen);
      match = re.exec(source);
    }
  }
  return seen;
}

function resolveModule(candidate) {
  for (const suffix of ["", ".js", ".jsx", "/index.js"]) {
    const file = `${candidate}${suffix}`;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return path.normalize(file);
  }
  return null;
}

/** Does the graph contain any module whose path ends with one of `needles`? */
export function reachesAny(graph, needles) {
  const normalized = [...graph].map((p) => p.split(path.sep).join("/"));
  return needles.some((needle) => normalized.some((p) => p.endsWith(needle)));
}

/** Which of `needles` are reachable — for reporting, not just a boolean. */
export function reachableModules(graph, needles) {
  const normalized = [...graph].map((p) => p.split(path.sep).join("/"));
  return needles.filter((needle) => normalized.some((p) => p.endsWith(needle)));
}

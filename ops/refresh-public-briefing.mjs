// refresh-public-briefing — push the current blocker picture to her phone.
//
// The Continuity dashboard she checks off-LAN is a STATIC deployment on
// Cloudflare Pages (https://ctn-briefing.pages.dev). Static, so it shows
// whatever data was uploaded at deploy time — which is a feature, not a bug:
// it is CDN-backed and does not depend on this machine staying up, so a power
// outage here cannot take her phone view offline. It went stale, not dark.
//
// The cost of that choice is this script: the data only moves when something
// runs it. It:
//   1. regenerates public/data/continuity-briefing.json from the live
//      exception store (via _ship_inbox/ops/briefing.mjs) — the SAME builder
//      open-dashboard.mjs uses, so the phone view and the local view agree;
//   2. stages that JSON into dist/data/ (dist is the built SPA);
//   3. redeploys dist to the ctn-briefing Pages project.
//
// It rebuilds the SPA bundle only when --build is passed; day to day only the
// data changes, and re-uploading 30 unchanged asset files every tick is waste
// Pages already de-duplicates but need not be asked to.
//
// Usage:
//   node ops/refresh-public-briefing.mjs           # data-only redeploy
//   node ops/refresh-public-briefing.mjs --build   # rebuild SPA + redeploy
//
// Exit 0 only if the deploy reported success; callers (the babysitter tick)
// can trust the code.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BUILDER = path.resolve(REPO, "..", "_ship_inbox", "ops", "briefing.mjs");
const DATA_SRC = path.join(REPO, "public", "data", "continuity-briefing.json");
const DIST = path.join(REPO, "dist");
const DIST_DATA = path.join(DIST, "data");
const PROJECT = "ctn-briefing";

// node.exe lives under "C:\Program Files\" — a space that shell:true splits on.
// So only npx/wrangler (which need the shell on Windows to resolve the .cmd
// shim) run with shell:true; the node builder is spawned directly.
const runNode = (args, opts = {}) =>
  execFileSync(process.execPath, args, { stdio: "inherit", cwd: REPO, ...opts });
const runShell = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: REPO, shell: true, ...opts });

function main() {
  const doBuild = process.argv.includes("--build");

  // 1. regenerate the data from the live exception store
  if (!fs.existsSync(BUILDER)) {
    console.error(`! briefing builder missing at ${BUILDER}; refusing to deploy stale data`);
    process.exit(1);
  }
  // The builder PRINTS to stdout unless given `build --out <path>`; without
  // --out it is a no-op for the file and the phone view silently stays stale.
  runNode([BUILDER, "build", "--out", DATA_SRC]);
  if (!fs.existsSync(DATA_SRC)) {
    console.error(`! builder did not produce ${DATA_SRC}`);
    process.exit(1);
  }

  // 2. (optional) rebuild the SPA, then stage the fresh data into dist
  if (doBuild || !fs.existsSync(path.join(DIST, "index.html"))) {
    runShell("npx", ["vite", "build"], { env: { ...process.env, VITE_DATA_BASE: "/data/" } });
  }
  fs.mkdirSync(DIST_DATA, { recursive: true });
  fs.copyFileSync(DATA_SRC, path.join(DIST_DATA, "continuity-briefing.json"));

  // 3. redeploy
  runShell("npx", ["wrangler", "pages", "deploy", "dist",
    `--project-name=${PROJECT}`, "--branch=main", "--commit-dirty=true"]);

  const gen = JSON.parse(fs.readFileSync(DATA_SRC, "utf8")).generatedAtLocal || "?";
  console.log(`\nphone view refreshed → https://${PROJECT}.pages.dev  (data ${gen})`);
}

main();

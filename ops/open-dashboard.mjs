// Open the Continuity catch-up briefing — one command, any shell.
//
// This exists because "open the dashboard" was three steps that had to be run
// in the right order, in bash, from the right directory:
//
//   1. regenerate public/data/continuity-briefing.json from the exception store
//   2. start vite with VITE_DATA_BASE=/data/ on port 5313
//   3. open http://localhost:5313/?view=briefing
//
// Skip step 1 and the screen shows whatever the last run left behind, which is
// worse than showing nothing: a briefing that looks current and is not is a
// briefing that hides today's blockers.
//
// Usage:  node D:/Projects/datascape-mustreads/ops/open-dashboard.mjs
//
// Ctrl+C stops the server.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PORT = Number(process.env.DASHBOARD_PORT || 5313);
// --detach: leave the server running after this process exits. Use it when
// something other than a person at a terminal is starting the dashboard.
const DETACH = process.argv.includes("--detach");
// 127.0.0.1, not localhost — and the server is bound to match.
//
// Vite defaults to binding [::1] only. curl and Node reach that happily, so
// every check here passed while Chrome got ECONNREFUSED: it asked for
// 127.0.0.1, and nothing was listening on IPv4 at all. Binding IPv4 loopback
// explicitly fixes the browser without putting the port on any network
// interface — `--host` with no argument would bind 0.0.0.0 and publish this
// to the LAN, which is not a trade worth making for a convenience URL.
const HOST = "127.0.0.1";
const URL_ = `http://${HOST}:${PORT}/?view=briefing`;

const BRIEFING_BUILDER = path.resolve(REPO, "..", "_ship_inbox", "ops", "briefing.mjs");
const DATA_FILE = path.join(REPO, "public", "data", "continuity-briefing.json");

const say = (line) => console.log(line);

/** Step 1 — regenerate, and say plainly if it could not. */
function refreshData() {
  return new Promise((resolve) => {
    if (!fs.existsSync(BRIEFING_BUILDER)) {
      say(`! could not find the briefing builder at ${BRIEFING_BUILDER}`);
      say("  the dashboard will open with whatever data is already on disk.");
      return resolve(false);
    }
    execFile(process.execPath, [BRIEFING_BUILDER, "build", "--out", DATA_FILE],
      { cwd: REPO }, (error, stdout, stderr) => {
        if (error) {
          // NOT fatal, and NOT silent. An unrefreshed briefing is still worth
          // reading as long as its age is stated rather than implied.
          say(`! the briefing data could not be regenerated: ${String(stderr || error.message).trim().split("\n")[0]}`);
          say("  opening with the data already on disk — treat it as stale.");
          return resolve(false);
        }
        const summary = String(stdout || "").trim().split("\n").filter(Boolean).pop();
        if (summary) say(`  ${summary}`);
        resolve(true);
      });
  });
}

/**
 * Is the server answering ON THE EXACT URL SHE WILL OPEN?
 *
 * Probe the address you are about to promise, not one that merely resembles it.
 * An earlier version probed 127.0.0.1 while handing out a localhost link; the
 * fix then was to probe localhost, which made both agree and both wrong, because
 * the server was only ever bound to [::1]. Host, probe and link are now one
 * value.
 */
async function reachable() {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch { return false; }
}

/** Open in the default browser, without assuming a shell. */
function openBrowser(url) {
  if (process.platform === "win32") {
    // `start` is a cmd builtin, and the empty "" is the window title cmd
    // otherwise steals from a quoted URL.
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

say("Continuity briefing");
say("");
say("refreshing the data…");
const fresh = await refreshData();
const stat = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE) : null;
if (stat) {
  const minutes = Math.round((Date.now() - stat.mtimeMs) / 60000);
  say(`  data is ${minutes < 1 ? "current" : `${minutes} minute(s) old`}${fresh ? "" : " — NOT refreshed this run"}`);
}

let server = null;
if (await reachable()) {
  say(`\nthe server is already running on ${PORT}.`);
} else {
  say(`\nstarting the server on ${PORT}…`);
  // vite's own entry point, run by THIS node — no npm, and no shell.
  //
  // `spawn("npm.cmd", …)` throws EINVAL on Windows under Node 22, which now
  // refuses to launch a .cmd without a shell; and reaching for `shell: true`
  // to get around that would put the repo path through cmd's quoting rules for
  // no benefit. The binary is right there.
  const vite = path.join(REPO, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(vite)) {
    say(`! vite is not installed at ${vite}`);
    say("  run `npm install` in the repo first.");
    process.exit(1);
  }
  // DETACHED means "outlives whoever started me".
  //
  // Without it the server is a child of this process, and a child dies with its
  // parent. That is correct when SHE runs this in a terminal and leaves it
  // open — Ctrl+C should stop the dashboard. It is wrong when an agent session
  // starts it on her behalf: the session ends, the child is reaped, and the
  // next thing she sees is ERR_CONNECTION_REFUSED on a link she was just
  // handed. That happened twice before this flag existed.
  server = spawn(process.execPath, [vite, "--port", String(PORT), "--strictPort", "--host", HOST],
    {
      cwd: REPO,
      env: { ...process.env, VITE_DATA_BASE: "/data/", MSYS_NO_PATHCONV: "1" },
      stdio: "ignore",
      detached: DETACH,
    });
  server.on("error", (error) => say(`! the server could not start: ${error.message}`));
  if (DETACH) server.unref();

  const deadline = Date.now() + 40000;
  let up = false;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await reachable()) { up = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    say("! the server did not come up within 40 seconds.");
    say(`  try again, or open ${URL_} yourself if it starts late.`);
    process.exitCode = 1;
  }
}

say("");
say(`  ${URL_}`);
say("");
openBrowser(URL_);
if (DETACH) {
  say("opening it in your browser. The server keeps running after this exits.");
} else {
  say("opening it in your browser. Ctrl+C here stops the server.");
}

const stop = () => { try { server?.kill(); } catch { /* already gone */ } process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Phase-0 foundation #1 — the git-walker.
// evidence.json carries commit TOTALS; the Observatory's instruments (the
// Actuary's survival curves, Reaper's taper autopsies, the Standup's
// attention-output divergence, Promissory verification) need the SHAPE of
// each project's life: per-day commits, inter-commit gaps, burstiness, and
// the decay slope of its final months. This re-walks every local repo and
// writes that shape to src/data/git-history.json.
//
// Cadence dates are the same privacy class as evidence.json (already shipped)
// — build history, not corpus — so this file is committed, not vaulted.
//
// Usage: node scripts/git-walk.mjs

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "data", "git-history.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// mirror of build-evidence.mjs — the local dirs behind each project id
const REPOS = {
  // ─────────────────────────────────────────────────────────────────────
  //  CONFIGURE ME — map each project id (must match an id in content.json)
  //  to one or more local folders that contain its .git. The first folder
  //  with a .git wins; a plain folder falls back to file facts only.
  // ─────────────────────────────────────────────────────────────────────
  "tab-tamer": ["C:/code/tab-tamer"],
  "loopdeck": ["C:/code/loopdeck"],
  "field-notes": ["C:/code/field-notes", "C:/code/field-notes-cli"],
};

const sh = (cmd, cwd) => {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }).trim();
  } catch {
    return null;
  }
};

const DAY = 86400000;
const dayStr = (d) => d.toISOString().slice(0, 10);
const monStr = (d) => d.toISOString().slice(0, 7);
// ISO week key, e.g. 2025-W18
function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

// linear regression slope of y over x (least squares)
function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

function bucketCounts(dates, keyFn) {
  const m = new Map();
  for (const d of dates) m.set(keyFn(d), (m.get(keyFn(d)) || 0) + 1);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => ({ k, n }));
}

const NOW = new Date();
const out = {};
let walked = 0, skipped = 0;

for (const [id, candidates] of Object.entries(REPOS)) {
  const dir = candidates.find((c) => fs.existsSync(path.join(c, ".git")));
  if (!dir) { out[id] = null; skipped++; continue; }

  // committer dates across ALL branches, one per commit, ascending
  const raw = sh('git log --all --format=%cI', dir);
  if (!raw) { out[id] = null; skipped++; continue; }
  const dates = raw.split("\n").map((s) => new Date(s.trim())).filter((d) => !isNaN(d))
    .sort((a, b) => a - b);
  if (!dates.length) { out[id] = null; skipped++; continue; }

  const first = dates[0], last = dates[dates.length - 1];
  const spanDays = Math.max(1, Math.round((last - first) / DAY));

  // inter-commit gaps in days (only meaningful with >=2 commits)
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / DAY);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : null;
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const sdGap = gaps.length
    ? Math.sqrt(gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / gaps.length) : null;
  // burstiness B in [-1,1]: +1 = bursty/clumped, 0 = poisson, -1 = regular
  const burstiness = (sdGap != null && meanGap != null && sdGap + meanGap > 0)
    ? (sdGap - meanGap) / (sdGap + meanGap) : null;

  const monthly = bucketCounts(dates, monStr);
  const weekly = bucketCounts(dates, weekKey);

  // taper: log-linear slope of monthly counts over the trailing half of the
  // active span (per month). negative => declining; half-life if it decays.
  const half = monthly.slice(Math.floor(monthly.length / 2));
  const tSlope = slope(half.map((_, i) => i), half.map((b) => Math.log(b.n + 1)));
  const decayHalfLifeMonths = tSlope < -1e-6 ? +(Math.log(2) / -tSlope).toFixed(1) : null;

  const dormancyDays = Math.round((NOW - last) / DAY);
  // longest silence that was later broken (max gap that wasn't the trailing one)
  const maxInnerGap = gaps.length ? Math.max(...gaps) : null;

  out[id] = {
    repo: path.basename(dir),
    firstCommit: dayStr(first),
    lastCommit: dayStr(last),
    commits: dates.length,
    activeSpanDays: spanDays,
    dormancyDays,                                   // today - lastCommit (Reaper, Standup)
    gaps: {                                         // inter-commit gap stats (revival hazard)
      medianDays: median != null ? +median.toFixed(1) : null,
      meanDays: meanGap != null ? +meanGap.toFixed(1) : null,
      maxDays: maxInnerGap != null ? +maxInnerGap.toFixed(1) : null,
    },
    burstiness: burstiness != null ? +burstiness.toFixed(3) : null, // 1% compounding vs sprint
    taper: {                                        // death signature (Reaper autopsy)
      trailingSlopeLogPerMonth: +tSlope.toFixed(4),
      decayHalfLifeMonths,
      last90dCommits: dates.filter((d) => (NOW - d) / DAY <= 90).length,
    },
    monthly,                                        // {k:"2025-04", n} — Standup divergence
    weekly,                                         // {k:"2025-W18", n} — cadence series
    commitDays: bucketCounts(dates, dayStr).map((b) => [b.k, b.n]), // ground truth (Actuary KM)
  };
  walked++;
  process.stdout.write(`${id.padEnd(24)} commits ${String(dates.length).padStart(4)} · span ${String(spanDays).padStart(4)}d · dormant ${String(dormancyDays).padStart(4)}d · B ${burstiness != null ? burstiness.toFixed(2) : " n/a"} · t½ ${decayHalfLifeMonths ?? "—"}\n`);
}

fs.writeFileSync(OUT, JSON.stringify(out));
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`\nwrote ${path.relative(ROOT, OUT)} (${kb} KB) — walked ${walked}, skipped ${skipped}`);

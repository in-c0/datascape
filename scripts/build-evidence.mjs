// Build src/data/evidence.json — real, verifiable facts per project, mined
// from the actual repos on disk: git history spans, commit counts, remotes,
// the stack as it exists in files (not as described), and live-URL hints
// found in configs/readmes. Evidence, not prose.
//
// Usage: node scripts/build-evidence.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "data", "evidence.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// id → candidate repo dirs (first existing git repo wins)
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

const LANG_BY_EXT = {
  ".py": "python", ".js": "javascript", ".jsx": "react", ".ts": "typescript",
  ".tsx": "react", ".cs": "c#", ".cpp": "c++", ".c": "c", ".rs": "rust",
  ".go": "go", ".dart": "dart", ".gd": "gdscript", ".html": "html",
  ".css": "css", ".ipynb": "jupyter", ".astro": "astro", ".vue": "vue",
};
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "venv", ".venv", "__pycache__", "Library", "obj", "bin", ".next", "out"]);

const sh = (cmd, cwd) => {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }).trim();
  } catch {
    return null;
  }
};

function walkLangs(dir, counts, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walkLangs(path.join(dir, e.name), counts, depth + 1);
    } else {
      const lang = LANG_BY_EXT[path.extname(e.name).toLowerCase()];
      if (lang) counts[lang] = (counts[lang] || 0) + 1;
    }
  }
}

function urlHints(dir) {
  const hints = new Set();
  const grab = (txt) => {
    for (const m of txt.matchAll(/https?:\/\/([a-z0-9.-]+\.(?:com|io|app|dev|kim|net|org|xyz))[^\s"')]*/gi)) {
      const host = m[1].toLowerCase();
      if (/github|npmjs|localhost|example|googleapis|shields|vercel\.app$|amazonaws|cloudflare\.com|anthropic|openai|supabase\.co$|firebaseio/.test(host)) continue;
      hints.add(host);
    }
  };
  for (const f of ["package.json", "README.md", "readme.md", "wrangler.toml", "vercel.json", "netlify.toml", "CNAME"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      try { grab(fs.readFileSync(p, "utf8").slice(0, 40000)); } catch { /* skip */ }
    }
  }
  return [...hints].slice(0, 4);
}

// confirmed live links (probed, not guessed): url must have answered 200
const LINKS = {
  "youtube-to-text": { url: "https://youtubetotext.com" },
  "shorts-remover": { store: "https://chrome.google.com/webstore/detail/youtube-shorts-playables/dilmoegnonbiadmhbmaehnhogjlkikdp" },
};

const out = {};
for (const [id, candidates] of Object.entries(REPOS)) {
  const dir = candidates.find((c) => fs.existsSync(path.join(c, ".git")));
  if (!dir) {
    // no git history — fall back to file facts from the plain working folder
    const plain = candidates.find((c) => fs.existsSync(c));
    if (!plain) { out[id] = null; continue; }
    const langs = {};
    walkLangs(plain, langs);
    out[id] = {
      repo: path.basename(plain),
      firstCommit: null, lastCommit: null, commits: 0, remote: null,
      langs: Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l),
      urlHints: [],
      ...(LINKS[id] || {}),
      ungoverned: true, // a working folder without git — honest about it
    };
    console.log(id.padEnd(24), "  (no git — file facts only)", out[id].langs.join("/"));
    continue;
  }
  const first = sh("git log --reverse --format=%cs", dir)?.split("\n")[0] || null;
  const lastLine = sh("git log -1 --format=%cs", dir);
  const commits = parseInt(sh("git rev-list --count HEAD", dir) || "0", 10);
  let remote = sh("git config --get remote.origin.url", dir);
  if (remote) remote = remote.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  const langs = {};
  walkLangs(dir, langs);
  const topLangs = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
  out[id] = {
    repo: path.basename(dir),
    firstCommit: first,
    lastCommit: lastLine || null,
    commits,
    remote: remote || null,
    langs: topLangs,
    urlHints: urlHints(dir),
    ...(LINKS[id] || {}),
  };
  console.log(id.padEnd(24), String(commits).padStart(5), (first || "?") + " → " + (lastLine || "?"), topLangs.join("/"), out[id].urlHints.join(","));
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nwrote ${OUT}`);

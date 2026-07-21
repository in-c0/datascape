// Upload a data folder to a Cloudflare R2 bucket via wrangler, so your site's
// code can stay public while its data lives elsewhere.
//
// Prereqs: `npm i -g wrangler`, `wrangler login`, and a bucket:
//   wrangler r2 bucket create <bucket>
// Then set the CORS policy (docs/cors.json) so browsers may fetch it:
//   wrangler r2 bucket cors put <bucket> --file docs/cors.json
//
// Usage: node scripts/deploy-data.mjs <dir> [bucket]
//   node scripts/deploy-data.mjs public/data my-datascape-data

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const dir = process.argv[2] || "public/data";
const bucket = process.argv[3] || process.env.R2_BUCKET || "my-datascape-data";

if (!fs.existsSync(dir)) {
  console.error(`no such folder: ${dir}`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.error(`no .json files in ${dir}`);
  process.exit(1);
}

console.log(`uploading ${files.length} files from ${dir} → r2://${bucket}\n`);
let ok = 0;
for (const f of files) {
  const src = path.join(dir, f);
  try {
    execSync(
      `wrangler r2 object put ${bucket}/${f} --file "${src}" --content-type application/json`,
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(`  ✓ ${f} (${(fs.statSync(src).size / 1024).toFixed(1)} KB)`);
    ok++;
  } catch (e) {
    console.error(`  ✗ ${f} — ${e.message.split("\n")[0]}`);
  }
}
console.log(`\n${ok}/${files.length} uploaded.`);
console.log(`Expose the bucket at a public URL (R2 custom domain or a Worker/Pages`);
console.log(`in front), then set  dataBase: "https://that-url/"  in datascape.config.js.`);

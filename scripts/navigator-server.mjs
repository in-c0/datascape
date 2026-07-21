// The live navigator — runs on HER machine only, never deployed.
// The public site precomputes its featured answers; when this server is up
// (npm run navigator), free-text questions in the command bar get a real
// LLM turn: question in → { answer, spec } out. When it's down, the site
// says "the navigator is asleep". Zero cloud bill for visitors either way.
//
// Auth: ANTHROPIC_API_KEY env var, or an `ant auth login` profile.
// Usage: node scripts/navigator-server.mjs   (port 8787)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "data", "content.json"), "utf8")
);

const client = new Anthropic();
const PORT = 8787;

const CATALOG = {
  projects: CONTENT.projects.map((p) => `${p.id} (${p.title}, ${p.status})`),
  panels: ["timeline", "eras", "provenance", "comparison", "mirror", "seeds"],
  cameras: ["overview", "top", "core", "terrain"],
  topologies: ["centralized", "clustered", "strata", "semantic"],
  eras: ["2025a", "2025b", "2026"],
  categories: Object.keys(CONTENT.categories),
  statuses: ["live", "soon", "building", "archived"],
};

const SYSTEM = `You are the navigator of ava.kim — an interactive 3D data landscape of Ava's work: ${CONTENT.projects.length} real projects as spheres and 3,492 ChatGPT conversations as a dot cloud, spanning 2023-2026.

A visitor typed a question. You answer with one short line in the site's voice (lowercase, mono, precise, warm-dry — like an instrument readout that read a poem once) AND a dashboard spec that makes the scene itself answer.

Spec vocabulary (use null for anything you don't want to touch):
- panels: up to 3 of ${JSON.stringify(CATALOG.panels)}
- camera: one of ${JSON.stringify(CATALOG.cameras)} (terrain pairs well with topology strata)
- topology: one of ${JSON.stringify(CATALOG.topologies)}
- filters.era: one of ${JSON.stringify(CATALOG.eras)} · filters.category: one of ${JSON.stringify(CATALOG.categories)} · filters.status: one of ${JSON.stringify(CATALOG.statuses)} · filters.korean: 1 to isolate korean thoughts · filters.month: "YYYY-MM" or "YYYY" prefix to isolate a time slice
- focus: a project id to open its card — one of: ${CATALOG.projects.join(", ")}
- viz: COMPOSE A NEW INSTRUMENT that doesn't exist as a component — a chart materializes in the 3D scene. Use it whenever the question is quantitative or about change over time. Shape:
  { "title": short lowercase title, "form": "curve"|"bars"|"scatter",
    "source": "voice"|"thoughts",
    voice → "field": "words"|"questionRate"|"koreanShare"|"vocabRichness"|"build"|"wonder"|"bw"|"convos" (monthly measured series of her writing),
    thoughts → "groupBy": "month"|"year"|"cluster"|"project", "metric": "count"|"avg"|"sum", "field": "uw" (her words)|"kr" (korean ratio)|"qd" (question density)|"dur" (days a conversation spanned)|"n" (messages), optional "filter": same shape as filters }
  examples: {"title":"how deep she goes, by year","form":"bars","source":"thoughts","groupBy":"year","metric":"avg","field":"uw"} · {"title":"the build:wonder tide","form":"curve","source":"voice","field":"bw"}

Prefer showing over telling: compose a viz for quantitative questions; pick filters/panels/camera for navigational ones. The answer line is narration, max ~180 chars.`;

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    spec: {
      type: "object",
      properties: {
        panels: { type: ["array", "null"], items: { type: "string" } },
        camera: { type: ["string", "null"] },
        topology: { type: ["string", "null"] },
        focus: { type: ["string", "null"] },
        filters: {
          type: ["object", "null"],
          properties: {
            era: { type: ["string", "null"] },
            category: { type: ["string", "null"] },
            status: { type: ["string", "null"] },
            korean: { type: ["integer", "null"] },
            month: { type: ["string", "null"] },
          },
          required: ["era", "category", "status", "korean", "month"],
          additionalProperties: false,
        },
        viz: {
          type: ["object", "null"],
          properties: {
            title: { type: "string" },
            form: { type: ["string", "null"] },
            source: { type: "string" },
            field: { type: ["string", "null"] },
            groupBy: { type: ["string", "null"] },
            metric: { type: ["string", "null"] },
            filter: {
              type: ["object", "null"],
              properties: {
                era: { type: ["string", "null"] },
                category: { type: ["string", "null"] },
                status: { type: ["string", "null"] },
                korean: { type: ["integer", "null"] },
                month: { type: ["string", "null"] },
              },
              required: ["era", "category", "status", "korean", "month"],
              additionalProperties: false,
            },
          },
          required: ["title", "form", "source", "field", "groupBy", "metric", "filter"],
          additionalProperties: false,
        },
      },
      required: ["panels", "camera", "topology", "focus", "filters", "viz"],
      additionalProperties: false,
    },
  },
  required: ["answer", "spec"],
  additionalProperties: false,
};

async function navigate(question) {
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: "user", content: question.slice(0, 500) }],
  });
  if (response.stop_reason === "refusal") return null;
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return null;
  const parsed = JSON.parse(text);
  // strip nulls so the client's merge semantics leave untouched state alone
  const spec = {};
  for (const [k, v] of Object.entries(parsed.spec || {})) {
    if (v == null) continue;
    if (k === "filters") {
      const f = Object.fromEntries(Object.entries(v).filter(([, x]) => x != null));
      if (Object.keys(f).length) spec.filters = f;
    } else spec[k] = v;
  }
  return { answer: parsed.answer, spec };
}

http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "POST" || req.url !== "/navigate")
      return res.writeHead(404).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { question } = JSON.parse(body || "{}");
        if (!question || typeof question !== "string")
          return res.writeHead(400).end();
        const out = await navigate(question);
        if (!out) return res.writeHead(422).end();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(out));
        console.log(`? ${question.slice(0, 60)} → ${out.answer.slice(0, 60)}`);
      } catch (e) {
        console.error(e.message);
        res.writeHead(500).end();
      }
    });
  })
  .listen(PORT, () => console.log(`navigator awake on :${PORT}`));

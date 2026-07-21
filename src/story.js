// Story mode — the guided pass for visitors who don't speak 3D.
// Each step is nothing but a dashboard spec plus a dwell time; the story
// is literally a script of the same language the command bar and the
// future LLM navigator emit.
import { NODES } from "./data/nodes.js";

export function buildStory(thoughts) {
  const nProjects = NODES.length;
  const nThoughts = thoughts?.meta?.thoughts?.toLocaleString() || "thousands of";
  const live = NODES.filter((n) => n.status === "live").length;
  const flagshipProject =
    [...NODES].sort((a, b) => b.sig - a.sig)[0] || null;

  return [
    {
      dwell: 9,
      spec: {
        topology: "centralized", camera: "overview",
        panels: [], filters: {}, focus: null,
        narration: `${nProjects} projects orbit one core self — drag anytime, the story waits`,
      },
    },
    {
      dwell: 9,
      spec: {
        camera: "core",
        narration: `beneath them, ${nThoughts} conversations — each dot one chat, drifting near what it means`,
      },
    },
    {
      dwell: 10,
      spec: {
        topology: "strata", camera: "terrain", panels: ["timeline"],
        narration: "time as terrain — every ridge a month of thinking, sedimented into eras",
      },
    },
    {
      dwell: 9,
      spec: {
        topology: "centralized", camera: "overview",
        panels: ["eras"], filters: { era: "2026" },
        narration: `the current era: ${live} services live right now`,
      },
    },
    {
      dwell: 10,
      spec: {
        filters: {}, focus: flagshipProject?.id ?? null, panels: ["provenance"],
        narration: "every project traces back to the conversations that fed it",
      },
    },
    {
      dwell: 10,
      spec: {
        focus: null, camera: "overview", panels: ["mirror"],
        narration: "mirrors: how the machine sees you — honestly labeled, never diagnosis",
      },
    },
    {
      dwell: 9,
      spec: {
        panels: ["seeds"],
        narration: "seeds: your own thoughts, worth planting — press / and explore by words",
      },
    },
  ];
}

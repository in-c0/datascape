import { pathToFileURL } from "node:url";
import { makeObservation, mergeObservationDocuments } from "./continuity-observations.mjs";

function adapterName(module, fallback) {
  return module?.default?.name || module?.adapter?.name || module?.name || fallback;
}

function adapterCollector(module) {
  if (typeof module?.default === "function") return module.default;
  if (typeof module?.default?.collect === "function") return module.default.collect.bind(module.default);
  if (typeof module?.adapter?.collect === "function") return module.adapter.collect.bind(module.adapter);
  if (typeof module?.collect === "function") return module.collect;
  return null;
}

export async function runObservationAdapter(modulePath, { observedAt = new Date().toISOString(), context = {} } = {}) {
  const url = modulePath instanceof URL ? modulePath : pathToFileURL(modulePath);
  const module = await import(url.href);
  const collect = adapterCollector(module);
  if (!collect) throw new Error(`Continuity adapter ${url.href} does not export collect()`);
  const name = adapterName(module, url.pathname.split("/").pop());

  const emitted = await collect({
    observedAt: new Date(observedAt).toISOString(),
    makeObservation,
    context,
  });
  if (!Array.isArray(emitted)) throw new Error(`Continuity adapter ${name} must return an array of observations`);

  for (const [index, observation] of emitted.entries()) {
    if (!observation?.id || !observation?.source?.ref || !observation?.summary) {
      throw new Error(`Continuity adapter ${name} returned an invalid observation at index ${index}`);
    }
  }

  return {
    name,
    document: {
      version: 1,
      generatedAt: new Date(observedAt).toISOString(),
      observations: emitted,
    },
  };
}

export async function runObservationAdapters(modulePaths, options = {}) {
  const observedAt = new Date(options.observedAt || Date.now()).toISOString();
  const runs = [];
  let merged = options.existing || null;

  for (const modulePath of modulePaths) {
    const run = await runObservationAdapter(modulePath, {
      ...options,
      observedAt,
    });
    runs.push({ name: run.name, count: run.document.observations.length });
    merged = mergeObservationDocuments(merged, run.document, observedAt);
  }

  return {
    runs,
    document: merged || { version: 1, generatedAt: observedAt, observations: [] },
  };
}

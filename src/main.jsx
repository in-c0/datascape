import "./index.css";
import "./continuity/continuity.css";
import "./continuity/temporal.css";
import "./continuity/briefing.css";
import "./continuity/semantic.css";
import { loadBriefing, loadData } from "./store.js";
import { config } from "../datascape.config.js";

// dev-only: keep animation frames flowing when the tab is hidden
// (headless verification drives the app in a backgrounded pane)
if (import.meta.env.DEV) {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  let clock = performance.now();
  window.requestAnimationFrame = (cb) => {
    if (document.visibilityState === "hidden") {
      return setTimeout(() => {
        clock += 16.7;
        cb(clock);
      }, 16);
    }
    return nativeRaf(cb);
  };
}

const root = document.getElementById("root");
const requestedView = new URLSearchParams(window.location.search).get("view");
// Continuity ships two planes now: the semantic viewport and the catch-up
// briefing. Both are projections over the same runtime data boundary.
const VIEWS = new Set(["continuity", "briefing"]);
const view = VIEWS.has(requestedView) ? requestedView : "landscape";

function screen(html) {
  root.innerHTML = `<div class="boot">${html}</div>`;
}

// minimal boot screen while the data loads from config.dataBase
screen(`<div class="boot__brand">${config.siteName.toUpperCase()}</div>
  <div class="boot__msg">loading ${view}…</div>`);

(view === "briefing" ? loadBriefing(config.dataBase) : loadData(config.dataBase))
  .then(async () => {
    // Dynamic import AFTER data is in the store. Continuity is another
    // projection over the same runtime data boundary, not a second app/data silo.
    // Its small, ct-* scoped stylesheets are loaded by the shell above so the
    // production build cannot render an unstyled semantic viewport while the
    // dynamically imported JS has already mounted.
    const appModule = view === "continuity"
      ? import("./continuity/ContinuityView.jsx")
      : view === "briefing"
        ? import("./continuity/BriefingView.jsx")
        : import("./App.jsx");
    const [{ StrictMode }, { createRoot }, { default: App }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      appModule,
    ]);
    root.innerHTML = "";
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((err) => {
    screen(`<div class="boot__brand">${config.siteName.toUpperCase()}</div>
      <div class="boot__err">couldn't load the data</div>
      <div class="boot__detail">${String(err.message || err)}</div>
      <div class="boot__hint">check <code>dataBase</code> in datascape.config.js —
      it should point at a folder of JSON (content.json, thoughts.json, …).
      the shipped default is <code>/sample-data/</code>.</div>`);
  });
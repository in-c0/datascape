import "./index.css";
import { loadData } from "./store.js";
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

function screen(html) {
  root.innerHTML = `<div class="boot">${html}</div>`;
}

// minimal boot screen while the data loads from config.dataBase
screen(`<div class="boot__brand">${config.siteName.toUpperCase()}</div>
  <div class="boot__msg">loading landscape…</div>`);

loadData(config.dataBase)
  .then(async () => {
    // dynamic import AFTER data is in the store, so nodes.js and every
    // data-derived module evaluate against populated data
    const [{ StrictMode }, { createRoot }, { default: App }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./App.jsx"),
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

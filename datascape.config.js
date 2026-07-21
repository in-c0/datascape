// ─────────────────────────────────────────────────────────────────────────
//  Datascape — the one file a forker edits.
//  A 3D landscape of your own thinking, grown from your ChatGPT export and
//  your project folders. Point it at your data, name it, ship it.
// ─────────────────────────────────────────────────────────────────────────

export const config = {
  // What your site is called (browser tab, wordmark in the scene, page titles).
  siteName: "Datascape",
  tagline: "a spatial index of thoughts",

  // WHERE THE DATA LOADS FROM (this is the whole point of the template).
  // Data is fetched at runtime, never baked into the bundle — so the code is
  // yours to publish and the data is yours to keep anywhere.
  //   • dev / zero-config:   "/sample-data/"  (the synthetic demo shipped here)
  //   • your real site:      an absolute URL to your hosted JSON, e.g.
  //                          "https://data.your-domain.com/"
  // Override without editing this file via a VITE_DATA_BASE env var.
  dataBase: import.meta.env.VITE_DATA_BASE || "/sample-data/",

  // "public"  → show only projects you've marked visibility:"reveal" (portfolio)
  // "observatory" → show everything (your private, full-corpus build)
  surface: import.meta.env.VITE_SURFACE || "public",

  // Who made it — shown in the footer / about. Blank hides the credit.
  author: {
    name: "",
    url: "",
  },

  // The live "ask anything" navigator can call an LLM you host yourself
  // (see scripts/navigator-server.mjs). Leave null to run on the built-in
  // precomputed answers + local grammar only — never a cloud bill for visitors.
  liveNavigatorUrl: import.meta.env.VITE_NAVIGATOR_URL || null,
};

export default config;

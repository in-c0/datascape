// Brand + corpus totals, derived once from config and the loaded data — so no
// UI string hardcodes a name or a conversation count. Import these instead of
// writing "AVA.KIM" or "3,492 conversations" anywhere.
import { config } from "../datascape.config.js";
import { store } from "./store.js";

export const BRAND = config.siteName.toUpperCase();
export const BRAND_LC = config.siteName.toLowerCase();

const meta = store.thoughts?.meta || {};
const fmt = (n) => (n == null ? "?" : n.toLocaleString("en-US"));

export const TOTALS = {
  thoughts: meta.thoughts || 0,
  messages: meta.messages || 0,
  months: (meta.months || []).length,
  projects: (meta.projects || []).length,
  thoughtsLabel: fmt(meta.thoughts || 0),
  // "101k messages" style compact label
  messagesLabel: meta.messages >= 1000 ? `${Math.round(meta.messages / 1000)}k` : fmt(meta.messages || 0),
};

// owner-presence:probe — the NON-INTERACTIVE availability discovery
// (spec V6.1.6-A.2 PR A).
//
// Answers "could this machine verify the owner?" without asking anybody
// anything. `CheckAvailabilityAsync` reports whether a verifier exists and is
// configured; only `RequestVerificationAsync` opens a dialog, and this script
// never calls it.
//
// That separation is the point: an unattended tick must be able to discover
// the security posture of the host without putting a Windows Hello prompt in
// front of someone who did not ask for one.
import { createWindowsOwnerPresenceBroker } from "../src/continuity/control/owner-presence-windows.js";

const broker = createWindowsOwnerPresenceBroker(); // interactive NOT permitted
const availability = await broker.availability();

const report = {
  platform: process.platform,
  os_release: process.platform === "win32" ? (await import("node:os")).release() : null,
  user_consent_verifier_api: availability === "error" ? "unavailable" : "available",
  verification_device_configured: availability === "available",
  availability,
  // Stated rather than implied: this run cannot have prompted anyone.
  interactive_prompt_shown: "NO",
  // The gate. Device absent, not configured, or disabled by policy are not
  // reasons to fall back to trusting localhost — they are reasons to stop.
  owner_session_mechanism_viable: availability === "available",
  stop_reason: availability === "available" ? null
    : `owner verification is ${availability}; falling back to localhost trust is not permitted`,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.owner_session_mechanism_viable ? 0 : 1);

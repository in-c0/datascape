import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:4173";
await fs.mkdir("test-results", { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader"],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  // Default DataScape remains the existing Landscape.
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("canvas").first().waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.locator(".ct-root").count(), 0, "Landscape must remain the default surface");
  assert.equal(await page.locator(".boot__err").count(), 0, "Landscape booted into an error state");
  await page.screenshot({ path: "test-results/landscape.png", fullPage: true });

  // Continuity loads as an optional projection over the same runtime data source.
  await page.goto(`${baseUrl}/?view=continuity`, { waitUntil: "networkidle" });
  await page.locator(".ct-root").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.locator(".boot__err").count(), 0, "Continuity booted into an error state");

  const center = page.locator(".ct-node--center .ct-node__label");
  assert.equal(await center.textContent(), "Distribution", "Current synthetic snapshot should center the dominant concept");

  const visibleNeighbors = page.locator(".ct-node:not(.ct-node--center):not(.ct-node--faint)");
  assert.ok((await visibleNeighbors.count()) <= 4, "Runtime viewport must not exceed the four-neighbor attention budget");

  // Re-abstract changes the partition but preserves the selected center.
  const labelsBefore = await visibleNeighbors.locator(".ct-node__label").allTextContents();
  await page.locator(".ct-resolution button").last().click();
  assert.equal(await center.textContent(), "Distribution", "Re-abstract must preserve the center concept");
  const labelsAfter = await visibleNeighbors.locator(".ct-node__label").allTextContents();
  assert.notDeepEqual(labelsAfter, labelsBefore, "Re-abstract should change the local semantic partition");

  // A persisted literal concept is traversable; dynamic labels are not required to be persisted nodes.
  const shortForm = page.locator("g.ct-node--clickable", { hasText: "Short-form experiment" });
  await shortForm.click();
  assert.equal(await center.textContent(), "Short-form experiment", "Clicking a literal semantic node should recenter");

  await page.screenshot({ path: "test-results/continuity.png", fullPage: true });

  // Time-travel preserves semantic identity even before that concept existed.
  // Use real keyboard interaction so the controlled React range input follows
  // the same path an accessible keyboard user would take.
  const time = page.locator(".ct-time input[type=range]");
  await time.focus();
  await time.press("Home");
  await page.locator(".ct-node--center.ct-node--absent").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await center.textContent(), "Short-form experiment", "Time travel must not substitute a different historical concept");
  await page.getByText("semantic resolution unavailable", { exact: true }).waitFor();
  await page.screenshot({ path: "test-results/continuity-historical-absence.png", fullPage: true });

  // Return to now and inspect evidence without changing semantic position.
  await time.press("End");
  await page.locator(".ct-node--center.ct-node--live").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "Inspect" }).click();
  await page.locator(".ct-inspect").waitFor({ state: "visible" });
  assert.equal(await center.textContent(), "Short-form experiment", "Inspect must not recenter the semantic viewport");
  await page.getByText("Synthetic demonstration snapshot", { exact: true }).waitFor();

  assert.deepEqual(pageErrors, [], `Browser page errors: ${pageErrors.join(" | ")}`);
  console.log("Runtime smoke passed: Landscape + Continuity core interaction contract");
} finally {
  await browser.close();
}

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

  // Styling is part of the correctness contract. A previous production build
  // mounted the Continuity DOM while its split CSS chunk never applied.
  const rootColor = await page.locator(".ct-root").evaluate((element) => getComputedStyle(element).color);
  assert.equal(rootColor, "rgb(238, 243, 248)", "Continuity shell styles must be applied in the production build");

  // Temporal environment is a separate projection layer: real local time on x,
  // execution state on nodes, supervision as its own envelope/annotation.
  await page.locator(".ct-temporal-field").waitFor({ state: "visible" });
  assert.equal(await page.locator(".ct-autonomy-window").count(), 1, "Synthetic sample should expose one unattended interval");
  assert.equal(await page.locator(".ct-time-marker--now").count(), 1, "Temporal field should expose one NOW cursor");
  await page.getByText("Overnight unattended run", { exact: true }).waitFor();

  const center = page.locator(".ct-node--center .ct-node__label");
  assert.equal(await center.textContent(), "Distribution", "Current synthetic snapshot should center the dominant concept");
  const centerFill = await center.evaluate((element) => getComputedStyle(element).fill);
  assert.equal(centerFill, "rgb(238, 243, 248)", "Continuity SVG labels must remain readable on the temporal field");

  const visibleNeighbors = page.locator(".ct-node:not(.ct-node--center):not(.ct-node--faint)");
  assert.ok((await visibleNeighbors.count()) <= 4, "Runtime viewport must not exceed the four-neighbor attention budget");

  // Re-abstract changes the partition but preserves the selected center.
  const labelsBefore = await visibleNeighbors.locator(".ct-node__label").allTextContents();
  await page.locator(".ct-resolution button").last().click();
  assert.equal(await center.textContent(), "Distribution", "Re-abstract must preserve the center concept");
  const labelsAfter = await visibleNeighbors.locator(".ct-node__label").allTextContents();
  assert.notDeepEqual(labelsAfter, labelsBefore, "Re-abstract should change the local semantic partition");
  assert.equal(new URL(page.url()).searchParams.get("r"), "1", "Resolution should be URL-addressable");
  assert.equal(await page.locator(".ct-node--execution-planned").count(), 1, "Planned future cognition must remain visually distinct from completed history");

  // A persisted literal concept is traversable by keyboard; dynamic labels are
  // not required to become persisted/focusable graph nodes.
  const algorithmic = page.getByRole("button", { name: "Recenter on Algorithmic distribution" });
  await algorithmic.focus();
  assert.equal(await algorithmic.evaluate((element) => element === document.activeElement), true);
  const focusedStroke = await algorithmic.locator(".ct-node__circle").evaluate((element) => getComputedStyle(element).stroke);
  assert.equal(focusedStroke, "rgb(238, 243, 248)", "Keyboard-focused semantic nodes need a visible focus state");
  await algorithmic.press("Enter");
  assert.equal(await center.textContent(), "Algorithmic distribution", "Keyboard activation should recenter a literal semantic node");
  assert.equal(new URL(page.url()).searchParams.get("concept"), "Algorithmic distribution");

  // Semantic traversal participates in browser history: Back returns to the
  // prior concept, Forward restores the drill-in, and Reload preserves it.
  await page.goBack();
  await page.getByText("Distribution", { exact: true }).first().waitFor();
  assert.equal(await center.textContent(), "Distribution", "Back should restore the previous semantic center");
  await page.goForward();
  await page.getByText("Algorithmic distribution", { exact: true }).first().waitFor();
  assert.equal(await center.textContent(), "Algorithmic distribution", "Forward should restore the drilled semantic center");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".ct-root").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await center.textContent(), "Algorithmic distribution", "Reload should preserve URL-addressed semantic position");

  await page.screenshot({ path: "test-results/continuity.png", fullPage: true });

  // Time-travel preserves semantic identity even before that concept existed.
  const time = page.locator(".ct-time input[type=range]");
  await time.focus();
  await time.press("Home");
  await page.locator(".ct-node--center.ct-node--absent").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await center.textContent(), "Algorithmic distribution", "Time travel must not substitute a different historical concept");
  assert.equal(new URL(page.url()).searchParams.get("t"), "5d", "Historical position should use stable snapshot identity");
  await page.getByText("semantic resolution unavailable", { exact: true }).waitFor();
  await page.screenshot({ path: "test-results/continuity-historical-absence.png", fullPage: true });

  // Return to now and inspect evidence without changing semantic position.
  await time.press("End");
  await page.locator(".ct-node--center:not(.ct-node--absent)").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "Inspect" }).click();
  await page.locator(".ct-inspect").waitFor({ state: "visible" });
  assert.equal(await center.textContent(), "Algorithmic distribution", "Inspect must not recenter the semantic viewport");
  await page.getByText("Synthetic demonstration snapshot", { exact: true }).waitFor();
  await page.screenshot({ path: "test-results/continuity-inspect.png", fullPage: true });

  assert.deepEqual(pageErrors, [], `Browser page errors: ${pageErrors.join(" | ")}`);

  // Mobile must reflow the graph rather than scale a 1200-unit desktop canvas
  // down until semantic labels become unreadable.
  const mobile = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(`${baseUrl}/?view=continuity`, { waitUntil: "networkidle" });
  await mobile.locator(".ct-root").waitFor({ state: "visible", timeout: 10_000 });

  const mobileCenter = mobile.locator(".ct-node--center .ct-node__label");
  const mobileCenterBox = await mobileCenter.boundingBox();
  assert.ok(mobileCenterBox?.height >= 10, `Mobile semantic labels are too small (${mobileCenterBox?.height ?? "missing"}px)`);

  const mobileChromeFits = await mobile.evaluate(() => {
    const header = document.querySelector(".ct-top")?.getBoundingClientRect();
    const controls = document.querySelector(".ct-controls")?.getBoundingClientRect();
    if (!header || !controls) return false;
    return header.left >= -1 && header.right <= window.innerWidth + 1
      && controls.left >= -1 && controls.right <= window.innerWidth + 1;
  });
  assert.equal(mobileChromeFits, true, "Mobile Continuity chrome must remain inside the viewport");
  assert.ok((await mobile.locator(".ct-node:not(.ct-node--center):not(.ct-node--faint)").count()) <= 4);
  assert.equal(await mobile.locator(".ct-autonomy-window").count(), 1);
  assert.deepEqual(mobileErrors, [], `Mobile browser page errors: ${mobileErrors.join(" | ")}`);
  await mobile.screenshot({ path: "test-results/continuity-mobile.png", fullPage: true });
  await mobile.close();

  console.log("Runtime smoke passed: Landscape + temporal Continuity desktop/mobile/history/accessibility contract");
} finally {
  await browser.close();
}

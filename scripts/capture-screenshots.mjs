#!/usr/bin/env node
// Capture the product screenshots the website uses.
//
// Every shot comes from the real interface, driven in a browser against the
// built-in demo network, so the images can never show an older UI than the one
// that ships. The networks are entirely fictional, so no real customer,
// hostname, MAC address or address ends up in a published image.
//
//   npm run build
//   npm run preview &
//   npm i --no-save playwright
//   node scripts/capture-screenshots.mjs
//
// PNGs land in site/assets/shots/. Set PLAYWRIGHT_CHROMIUM_PATH to reuse a
// Chromium already on the machine.
//
// The pattern is ArcScan's: drive the shipped demo backend rather than
// maintain a set of mockups that drift away from the product.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const URL = process.env.EXP_URL ?? "http://localhost:4173/";
const OUT = process.env.EXP_SHOTS ?? "site/assets/shots";
/** The window size the application ships with, so the shots match it. */
const VIEWPORT = { width: 1180, height: 780 };

mkdirSync(OUT, { recursive: true });

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
/** Reduced motion, so no shot catches a half-finished transition. */
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
});
const page = await context.newPage();

const problems = [];
page.on("console", (message) => {
  if (message.type() === "error") problems.push(message.text());
});
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

const shots = [];
async function shot(name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(name);
  console.log(`  ${name}.png`);
}

async function setTheme(theme) {
  await page.evaluate((value) => {
    const raw = localStorage.getItem("exp-ip-scanner-settings");
    const settings = raw ? JSON.parse(raw) : {};
    settings.theme = value;
    localStorage.setItem("exp-ip-scanner-settings", JSON.stringify(settings));
    localStorage.setItem("exp-ip-scanner-theme", value);
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(350);
}

async function runScanToCompletion() {
  await page.locator('form button[type="submit"]').click();
  // The button reads Stop while a scan is running, so its disappearance is the
  // signal that the scan finished -- no fixed timeout to get wrong.
  await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForTimeout(450);
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
console.log(`Capturing EXP IP Scanner v${version} screenshots at ${VIEWPORT.width}x${VIEWPORT.height}`);

await page.goto(URL, { waitUntil: "networkidle" });

// --- Light theme ----------------------------------------------------------
await setTheme("light");
await page.locator("#scan-target").waitFor();
await page.waitForTimeout(250);
await shot("ready-light");

await runScanToCompletion();
await shot("scan-light");

// Device details: the domain controller, which has the most to show.
await page.locator("tbody tr", { hasText: "dc01.exp.local" }).dblclick();
await page.getByRole("complementary").waitFor({ timeout: 5_000 });
await page.waitForTimeout(350);
await shot("details-light");
await page.getByRole("button", { name: "Close details" }).click();
await page.waitForTimeout(200);

// --- Dark theme -----------------------------------------------------------
await setTheme("dark");
await runScanToCompletion();
await shot("scan-dark");

// Mid-scan, for the progress strip and the resolving placeholders.
await page.locator('form button[type="submit"]').click();
await page.locator("tbody tr").nth(6).waitFor({ timeout: 15_000 });
await page.waitForTimeout(250);
await shot("scanning-dark");
await page.getByRole("button", { name: "Stop" }).click();
await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 15_000 });
await page.waitForTimeout(300);

// The right-click menu, on a file server where most actions are available.
await runScanToCompletion();
await page.locator("tbody tr", { hasText: "fs01.exp.local" }).click({ button: "right" });
await page.getByRole("menu").waitFor({ timeout: 5_000 });
await page.waitForTimeout(250);
await shot("actions-dark");
await page.keyboard.press("Escape");

// Settings, so the site can show how little there is to configure.
await page.getByLabel("Settings").click();
await page.getByRole("dialog").waitFor({ timeout: 5_000 });
await page.waitForTimeout(250);
await shot("settings-dark");
await page.keyboard.press("Escape");

await browser.close();

console.log(`\n${shots.length} screenshots written to ${OUT}`);
if (problems.length > 0) {
  console.error("\nThe interface logged errors while being captured:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

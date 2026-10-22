#!/usr/bin/env node
// Assembled browser demo only. Never contacts an assessment target.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {},
);
const context = await browser.newContext({
  acceptDownloads: true,
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    localStorage.setItem(
      "exp-ip-scanner-settings",
      JSON.stringify({
        portSpec: "22,9001",
        scanServices: false,
        theme: "light",
      }),
    );
  });
  await page.goto(process.env.EXP_URL ?? "http://localhost:4173");
  await page
    .getByRole("button", { name: "Scan Web Exposure", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Stop", exact: true })
    .waitFor({ state: "detached", timeout: 30000 });
  await page.getByRole("region", { name: "Security assessment" }).waitFor();
  await page.getByText("Demo Safe Scan", { exact: false }).waitFor();
  assert.match(
    await page
      .locator("main, section[aria-label='Security assessment']")
      .last()
      .innerText(),
    /illustrative findings/,
  );
  const detail = page.getByRole("button", {
    name: /View security details for .*\.20$/,
  });
  await detail.click();
  await page
    .getByRole("button", { name: /PHP2Shell exposure assessment/ })
    .click();
  const finding = page.getByRole("dialog", {
    name: "PHP2Shell exposure assessment",
  });
  assert.match(await finding.innerText(), /POSSIBLY VULNERABLE/);
  assert.match(await finding.innerText(), /Remediation/i);
  await finding.getByRole("button", { name: "Close", exact: true }).click();
  for (const size of [
    { width: 1180, height: 780 },
    { width: 860, height: 560 },
  ]) {
    await page.setViewportSize(size);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page
      .getByRole("region", { name: "Security assessment" })
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await page.screenshot({ path: `.tmp-verify/security-${size.width}.png` });
  }
  await page.getByRole("button", { name: "Deep Scan", exact: true }).click();
  const deep = page.getByRole("dialog", { name: "Deep Scan", exact: true });
  assert.match(
    await deep.innerText(),
    /Only scan systems you own or are authorized to test/,
  );
  assert.equal(
    await deep
      .getByRole("button", { name: "Start low-impact verification" })
      .isDisabled(),
    true,
  );
  await deep.getByRole("checkbox").check();
  assert.equal(
    await deep
      .getByRole("button", { name: "Start low-impact verification" })
      .isEnabled(),
    true,
  );
  await deep.getByRole("button", { name: "Cancel", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /EXP-security.*\.json$/);
  const stream = await file.createReadStream();
  let json = "";
  for await (const chunk of stream) json += chunk;
  const report = JSON.parse(json);
  assert.equal(report.schema_version, 1);
  assert.ok(report.summary.devices_assessed > 0);
  assert.match(report.intelligence_notice, /unverified/);
  for (const port of [80, 443, 5000, 5001, 8000, 8080, 8443, 8888, 9001]) {
    assert.ok(
      report.discovery.ports_scanned.includes(port),
      `Missing exposure port ${port}`,
    );
  }
  const settings = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("exp-ip-scanner-settings")),
  );
  assert.equal(settings.portSpec, "22,9001");
  assert.equal(settings.scanServices, false);
  await page.getByRole("button", { name: "Scanner", exact: true }).click();
  assert.ok((await page.locator("tbody tr").count()) > 0);
  await page
    .getByRole("button", { name: "Scan Web Exposure", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Stop discovery", exact: true })
    .click();
  await page
    .getByText(
      "Discovery stopped. Start Safe Scan to assess these partial results.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Export JSON", exact: true })
      .isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS Web exposure discovery, preset/saved settings, cancellation, Security details/layout/consent/JSON, return to scanner",
  );
} finally {
  await browser.close();
}

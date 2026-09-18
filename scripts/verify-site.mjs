#!/usr/bin/env node
// Verification for the download website.
//
// It checks the things that are easy to break and invisible in review: the
// download rules matching the right asset, the page still working when the
// GitHub API does not answer, no horizontal overflow at any width, heading
// structure, alt text, contrast and internal links.
//
//   npx serve site -l 4174      (or any static server on port 4174)
//   npm i --no-save playwright
//   node scripts/verify-site.mjs
//
// Set PLAYWRIGHT_CHROMIUM_PATH to reuse a Chromium already on the machine.

import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.EXP_SITE_URL ?? "http://localhost:4174";
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920];
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

let failures = 0;
const step = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    console.log(`FAIL  ${name} — ${error.message}`);
    failures += 1;
  }
};

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // A blocked or intercepted api.github.com is an environment condition rather
  // than a site defect; the fallback path has its own check below.
  if (/api\.github\.com|ERR_CERT|Failed to load resource|net::ERR/.test(m.text())) return;
  consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });

// --- Content --------------------------------------------------------------

await step("the home page leads with the product and its promise", async () => {
  const h1 = await page.locator("h1").innerText();
  if (h1 !== "EXP IP Scanner") throw new Error(`unexpected h1: ${h1}`);
  const tagline = await page.locator(".tagline").innerText();
  if (!/Scan the network/.test(tagline)) throw new Error(`unexpected tagline: ${tagline}`);
  return `${h1} — ${tagline}`;
});

await step("it states the version, the platform and that no account is needed", async () => {
  const facts = await page.locator(".facts").innerText();
  if (!facts.includes(VERSION)) throw new Error(`the page does not show v${VERSION}: ${facts}`);
  if (!/Windows 10 and 11/.test(facts)) throw new Error("no supported Windows versions");
  if (!/x64/.test(facts)) throw new Error("no architecture");
  if (!/No account/i.test(facts)) throw new Error("does not say no account is needed");
  return facts.replace(/\n/g, " · ");
});

await step("exactly one h1, and heading levels never skip", async () => {
  const levels = await page.$$eval("h1,h2,h3,h4", (nodes) => nodes.map((n) => Number(n.tagName[1])));
  const h1s = levels.filter((l) => l === 1).length;
  if (h1s !== 1) throw new Error(`expected 1 h1, found ${h1s}`);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      throw new Error(`heading jumps from h${levels[i - 1]} to h${levels[i]}`);
    }
  }
  return `${levels.length} headings`;
});

await step("every image has alt text and intrinsic dimensions", async () => {
  const bad = await page.$$eval("img", (imgs) =>
    imgs
      .filter((img) => img.getAttribute("alt") === null || !img.width || !img.height)
      .map((img) => img.getAttribute("src")),
  );
  if (bad.length) throw new Error(`images missing alt or size: ${bad.join(", ")}`);
  return `${await page.locator("img").count()} images`;
});

await step("the screenshots are of the real application and actually load", async () => {
  const shots = await page.$$eval(".shot-tab", (tabs) =>
    tabs.map((t) => t.getAttribute("data-shot")),
  );
  if (shots.length < 3) throw new Error(`only ${shots.length} screenshots offered`);
  for (const shot of shots) {
    const response = await page.request.get(`${BASE}/assets/shots/${shot}.webp`);
    if (!response.ok()) throw new Error(`assets/shots/${shot}.webp is missing (${response.status()})`);
  }
  // And the hero image really rendered, rather than showing a broken icon.
  const loaded = await page.$eval("#shot-image", (img) => img.complete && img.naturalWidth > 0);
  if (!loaded) throw new Error("the hero screenshot did not load");
  return shots.join(", ");
});

await step("the screenshot switcher works by click and by arrow key", async () => {
  const before = await page.getAttribute("#shot-image", "src");
  await page.locator(".shot-tab").nth(1).click();
  const after = await page.getAttribute("#shot-image", "src");
  if (before === after) throw new Error("clicking a tab did not change the image");

  await page.locator(".shot-tab").nth(1).focus();
  await page.keyboard.press("ArrowRight");
  const moved = await page.evaluate(() => document.activeElement?.id);
  if (moved === "tab-scan-light") throw new Error("ArrowRight did not move between tabs");

  await page.locator(".shot-tab").first().click();
  return `${before.split("/").pop()} → ${after.split("/").pop()}`;
});

await step("the privacy claims on the home page match the privacy page", async () => {
  const home = await page.locator("body").innerText();
  if (!/No account, no telemetry/i.test(home)) throw new Error("the home page omits the claim");

  const privacy = await page.request.get(`${BASE}/privacy.html`);
  if (!privacy.ok()) throw new Error(`privacy.html is missing (${privacy.status()})`);
  const text = await privacy.text();
  for (const claim of [
    "Scanning happens on your computer",
    "Scan results are not uploaded",
    "No account, no telemetry, no analytics",
  ]) {
    if (!text.includes(claim)) throw new Error(`privacy.html omits "${claim}"`);
  }
  // The update check is disclosed rather than glossed over, which is what
  // makes the rest of the page believable.
  if (!/Check now/.test(text)) throw new Error("privacy.html does not disclose the update check");
  if (!text.includes(VERSION)) throw new Error(`privacy.html does not name v${VERSION}`);
  return "home and privacy agree";
});

await step("the release history names the current version", async () => {
  const releases = await page.request.get(`${BASE}/releases.html`);
  if (!releases.ok()) throw new Error(`releases.html is missing (${releases.status()})`);
  const text = await releases.text();
  if (!text.includes(VERSION)) throw new Error(`releases.html does not mention ${VERSION}`);
  return `names ${VERSION}`;
});

await step("the current version has a readable what-is-new page", async () => {
  const expected = `whats-new-${VERSION}.html`;
  const href = await page.getAttribute("#release-notes-link", "href");
  if (href !== expected) throw new Error(`release-notes-link points at ${href}, expected ${expected}`);
  const response = await page.request.get(`${BASE}/${expected}`);
  if (!response.ok()) throw new Error(`${expected} is missing (${response.status()})`);
  const text = await response.text();
  if (!text.includes(`EXP IP Scanner ${VERSION}`)) {
    throw new Error(`${expected} does not identify EXP IP Scanner ${VERSION}`);
  }
  return expected;
});

await step("every internal link resolves", async () => {
  const hrefs = await page.$$eval("a[href]", (links) =>
    links.map((a) => a.getAttribute("href")).filter((h) => h && !/^(https?:|mailto:|#)/.test(h)),
  );
  const unique = [...new Set(hrefs)];
  for (const href of unique) {
    const response = await page.request.get(new URL(href, `${BASE}/`).toString());
    if (!response.ok()) throw new Error(`${href} returns ${response.status()}`);
  }
  return `${unique.length} internal links`;
});

await step("no page points a technician at a source-code archive", async () => {
  for (const path of ["/", "/releases.html", "/privacy.html"]) {
    const text = await (await page.request.get(`${BASE}${path}`)).text();
    if (/archive\/refs|zipball|tarball|Source code \(zip\)/i.test(text)) {
      throw new Error(`${path} links to a source archive`);
    }
  }
  return "downloads point at releases, not at source";
});

// --- Downloads ------------------------------------------------------------

await step("both download cards work before any JavaScript runs", async () => {
  // The markup already has to be a working download page, because the GitHub
  // request may never answer.
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const plain = await noJs.newPage();
  await plain.goto(BASE, { waitUntil: "domcontentloaded" });
  const links = await plain.$$eval(".dl [data-field='link']", (as) =>
    as.map((a) => a.getAttribute("href")),
  );
  if (links.length !== 2) throw new Error(`${links.length} download links, expected 2`);
  for (const href of links) {
    if (!/^https:\/\/github\.com\/kingnazz\/EXP-IP-Scanner\/releases/.test(href ?? "")) {
      throw new Error(`a download link points at ${href}`);
    }
  }
  await noJs.close();
  return "both point at the releases page with scripting off";
});

await step("the portable edition is the recommended download", async () => {
  const recommended = await page.$$eval('.dl[data-recommended="true"]', (cards) =>
    cards.map((c) => c.getAttribute("data-kind")),
  );
  if (recommended.length !== 1 || recommended[0] !== "portable") {
    throw new Error(`recommended cards are ${JSON.stringify(recommended)}`);
  }
  const hero = await page.locator("#hero-download").innerText();
  if (!/portable/i.test(hero)) throw new Error(`the primary button says "${hero}"`);
  return `primary call to action: "${hero}"`;
});

await step("the asset rules pick the right file out of a full release", async () => {
  // Every asset a release actually publishes, including the ones that must
  // never be offered to a person.
  const assets = [
    { name: `EXP-IP-Scanner_${VERSION}_x64-setup.exe`, size: 4_000_000 },
    { name: `EXP-IP-Scanner_${VERSION}_x64-setup.exe.sig`, size: 200 },
    { name: `EXP-IP-Scanner_${VERSION}_windows-x64-portable.zip`, size: 3_500_000 },
    { name: "latest.json", size: 500 },
  ];

  const picked = await page.evaluate(
    ([list, version]) => {
      const api = window.__expAssetRules;
      return {
        portable: api.pick(list, api.rules.portable, version)?.name ?? null,
        installer: api.pick(list, api.rules.installer, version)?.name ?? null,
      };
    },
    [assets, VERSION],
  );

  if (picked.portable !== `EXP-IP-Scanner_${VERSION}_windows-x64-portable.zip`) {
    throw new Error(`the portable card picked ${picked.portable}`);
  }
  if (picked.installer !== `EXP-IP-Scanner_${VERSION}_x64-setup.exe`) {
    throw new Error(`the installer card picked ${picked.installer}`);
  }
  return `${picked.portable} and ${picked.installer}`;
});

await step("the asset rules refuse anything that is not a build", async () => {
  const refused = await page.evaluate(
    ([version]) => {
      const api = window.__expAssetRules;
      const only = (name) => [{ name, size: 1 }];
      return {
        // A signature is updater machinery, not a download.
        signature: api.pick(only(`EXP-IP-Scanner_${version}_x64-setup.exe.sig`), api.rules.installer, version),
        manifest: api.pick(only("latest.json"), api.rules.installer, version),
        source: api.pick(only("Source code (zip)"), api.rules.portable, version),
        // The wrong architecture must never satisfy an x64 card.
        arm: api.pick(only(`EXP-IP-Scanner_${version}_windows-arm64-portable.zip`), api.rules.portable, version),
        // A stale asset from an older release must not satisfy a current card.
        stale: api.pick(only("EXP-IP-Scanner_0.9.0_windows-x64-portable.zip"), api.rules.portable, version),
        // And the two cards must never pick each other's file.
        crossed: api.pick(only(`EXP-IP-Scanner_${version}_windows-x64-portable.zip`), api.rules.installer, version),
      };
    },
    [VERSION],
  );

  for (const [what, result] of Object.entries(refused)) {
    if (result !== null) throw new Error(`the rules accepted the ${what} asset: ${result.name}`);
  }
  return `${Object.keys(refused).length} kinds of wrong asset refused`;
});

await step("the page survives GitHub not answering", async () => {
  const offline = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await offline.newPage();
  await page2.route("https://api.github.com/**", (route) => route.abort());
  await page2.goto(BASE, { waitUntil: "networkidle" });
  await page2.waitForTimeout(800);

  const status = await page2.locator("#download-status").innerText();
  if (!/could not be loaded|WebView2/.test(status)) {
    throw new Error(`the status line reads "${status}"`);
  }
  const links = await page2.$$eval(".dl [data-field='link']", (as) =>
    as.map((a) => a.getAttribute("href")),
  );
  for (const href of links) {
    if (!/releases/.test(href ?? "")) throw new Error(`a download link became ${href}`);
  }
  await offline.close();
  return "downloads still reach the releases page";
});

// --- Layout ---------------------------------------------------------------

await step("no horizontal overflow at any supported width", async () => {
  const problems = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(120);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) problems.push(`${width}px overflows by ${overflow}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  if (problems.length) throw new Error(problems.join("; "));
  return `${WIDTHS.length} widths clean`;
});

await step("the comparison table scrolls inside its own container", async () => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(150);
  const scrolls = await page.$eval(".table-scroll", (el) => el.scrollWidth > el.clientWidth);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (!scrolls) throw new Error("the table container does not scroll");
  if (overflow > 0) throw new Error(`the page overflows by ${overflow}px`);
  await page.setViewportSize({ width: 1280, height: 900 });
  return "the table scrolls, the page does not";
});

await step("every control is large enough to tap", async () => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(150);
  const small = await page.$$eval("a.btn, button", (nodes) =>
    nodes
      .filter((n) => n.offsetParent !== null)
      .map((n) => ({ text: n.innerText.trim().slice(0, 24), height: n.getBoundingClientRect().height }))
      .filter((n) => n.height < 32),
  );
  if (small.length) {
    throw new Error(small.map((s) => `"${s.text}" is ${Math.round(s.height)}px tall`).join("; "));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return "all at least 32px tall";
});

await step("the viewport allows pinch zoom", async () => {
  const content = await page.getAttribute('meta[name="viewport"]', "content");
  if (/user-scalable\s*=\s*no|maximum-scale/.test(content ?? "")) {
    throw new Error(`the viewport blocks zoom: ${content}`);
  }
  return content;
});

await step("body text clears 4.5:1 against its background", async () => {
  const ratio = await page.evaluate(() => {
    const parse = (value) => value.match(/\d+/g).slice(0, 3).map(Number);
    const luminance = (rgb) =>
      rgb
        .map((c) => c / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const style = getComputedStyle(document.querySelector(".lede"));
    const bg = getComputedStyle(document.body).backgroundColor;
    const [a, b] = [luminance(parse(style.color)), luminance(parse(bg))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  if (ratio < 4.5) throw new Error(`the lede is only ${ratio.toFixed(1)}:1`);
  return `${ratio.toFixed(1)}:1`;
});

await step("the content policy forbids everything but the GitHub API", async () => {
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', "content");
  if (!csp) throw new Error("no Content-Security-Policy");
  if (!/script-src 'self'/.test(csp)) throw new Error("scripts are not restricted to the site");
  if (!/connect-src 'self' https:\/\/api\.github\.com/.test(csp)) {
    throw new Error(`connect-src is ${csp}`);
  }
  // No analytics, no web fonts, no CDN -- enforced rather than promised.
  const external = await page.$$eval("script[src], link[rel=stylesheet]", (nodes) =>
    nodes.map((n) => n.getAttribute("src") || n.getAttribute("href")).filter((u) => /^https?:/.test(u)),
  );
  if (external.length) throw new Error(`the page loads ${external.join(", ")}`);
  return "self only, plus api.github.com";
});

await step("the site logged no errors of its own", () => {
  if (consoleErrors.length > 0) {
    throw new Error(`${consoleErrors.length} console error(s): ${consoleErrors.join(" | ")}`);
  }
  return "clean console";
});

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nEvery website check passed.");

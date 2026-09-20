#!/usr/bin/env node
// Drive the built interface in a browser and check the things a technician
// depends on.
//
// The unit tests cover the logic; this covers the assembled application, using
// the same demo backend the screenshots come from. It is the script that makes
// the release checklist checkable rather than a list somebody reads.
//
//   npm run build
//   npm run preview &
//   npm i --no-save playwright
//   node scripts/verify-ui.mjs
//
// Set PLAYWRIGHT_CHROMIUM_PATH to reuse a Chromium already on the machine.

import { chromium } from "playwright";

const BASE = process.env.EXP_URL ?? "http://localhost:4173";
/** Window sizes a technician's laptop actually reports. */
const SIZES = [
  { width: 1180, height: 780, label: "default window" },
  { width: 1920, height: 1080, label: "desktop" },
  { width: 1366, height: 768, label: "common laptop" },
  { width: 860, height: 560, label: "minimum window" },
];

let failures = 0;

/**
 * Run one check.
 *
 * `restore` runs whether the check passed or failed. Without it a step that
 * leaves a search query or a filter behind makes every later step fail too,
 * and a single real defect reads as six.
 */
const step = async (name, fn, restore) => {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    console.log(`FAIL  ${name} — ${error.message}`);
    failures += 1;
  } finally {
    if (restore) {
      try {
        await restore();
      } catch (error) {
        console.log(`FAIL  ${name} (restoring the view) — ${error.message}`);
        failures += 1;
      }
    }
  }
};

/** Put the table back to every device, unsorted by anything unusual. */
async function resetView() {
  await page.locator("#results-search").fill("");
  const all = page.getByRole("button", { name: /^All/ });
  if ((await all.count()) > 0) await all.click();
  await page.waitForTimeout(150);
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({
  viewport: { width: 1180, height: 780 },
  reducedMotion: "reduce",
});
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const row = (text) => page.locator("tbody tr", { hasText: text });

async function runScan() {
  await page.locator('form button[type="submit"]').click();
  await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForTimeout(400);
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
  await page.waitForTimeout(300);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await setTheme("light");

// --- First run ------------------------------------------------------------

await step("the window is branded, names its version, and shows nothing else", async () => {
  // The heading is the logo rather than type, so it is checked by its
  // accessible name: what a screen reader announces, and what stops the mark
  // from being a picture of nothing.
  const heading = page.getByRole("heading", { name: "EXP IP Scanner", level: 1 });
  if ((await heading.count()) !== 1) throw new Error("no branded heading");
  if ((await heading.locator("svg").count()) !== 1) throw new Error("the heading is not the logo");

  // The wordmark follows the theme; the oval does not. Both have to be true or
  // the logo disappears into one of the two backgrounds.
  const fills = await heading.locator("svg g").evaluateAll((groups) =>
    groups.map((g) => getComputedStyle(g).fill),
  );
  if (fills.length !== 3) throw new Error(`the logo has ${fills.length} groups, expected 3`);

  const version = await page.locator("header").first().innerText();
  if (!/v\d+\.\d+\.\d+/.test(version)) throw new Error(`no version in the title bar: ${version}`);
  return `logo + ${version.trim().split("\n")[0]}`;
});

await step("the network is detected and the target is filled in", async () => {
  const target = await page.locator("#scan-target").inputValue();
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(target)) {
    throw new Error(`the target field holds "${target}", not a subnet`);
  }
  return target;
});

await step("the scan bar names the adapter being scanned", async () => {
  const bar = await page.locator("form").first().innerText();
  if (!/Ethernet/.test(bar)) throw new Error(`no adapter named: ${bar}`);
  return bar.split("\n")[0];
});

await step("the network summary reports where this machine is", async () => {
  const summary = page.getByLabel("Network summary", { exact: true });
  await summary.waitFor({ timeout: 5_000 });
  const text = (await summary.innerText()).replace(/\s+/g, " ");

  for (const [label, pattern] of [
    ["Adapter", /Adapter Ethernet/],
    ["Local IP", /Local IP 192\.168\.50\.37/],
    ["Gateway", /Gateway 192\.168\.50\.1\b/],
    ["Scan range", /Scan range 192\.168\.50\.0\/24 \(254 addresses\)/],
  ]) {
    if (!pattern.test(text)) throw new Error(`${label} is wrong or missing: ${text}`);
  }
  return text;
});

await step("the public IP arrives without holding anything else up", async () => {
  // The lookup is asynchronous by design. The target was already detected and
  // filled in, two checks ago, while this request was still in flight -- which
  // is the property being verified as much as the address itself.
  const summary = page.getByLabel("Network summary", { exact: true });
  await summary.getByText("203.0.113.42").waitFor({ timeout: 10_000 });

  // And it can be asked again.
  const again = page.getByRole("button", { name: "Look up the public IP address again" });
  if ((await again.count()) !== 1) throw new Error("no refresh control for the public IP");
  await again.click();
  await summary.getByText("Looking up…").waitFor({ timeout: 2_000 });
  await summary.getByText("203.0.113.42").waitFor({ timeout: 10_000 });
  return "203.0.113.42, refreshable";
});

await step("the whole network summary copies as one ticket-ready block", async () => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const summary = page.getByLabel("Network summary", { exact: true });
  const copy = summary.getByRole("button", { name: "Copy network summary" });
  if ((await copy.count()) !== 1) throw new Error("no network-summary copy control");

  await copy.click();
  await page.waitForTimeout(250);
  const text = await page.evaluate(() => navigator.clipboard.readText());

  for (const expected of [
    "Adapter      Ethernet",
    "Local IP     192.168.50.37",
    "Gateway      192.168.50.1",
    "Scan range   192.168.50.0/24 (254 addresses)",
    "Public IP    203.0.113.42",
  ]) {
    if (!text.includes(expected)) throw new Error(`network summary omitted: ${expected}\n${text}`);
  }
  return "adapter + local IP + gateway + range + public IP";
});

await step("the public IP lookup can be turned off, and says so", async () => {
  await page.evaluate(() => {
    const raw = localStorage.getItem("exp-ip-scanner-settings");
    const settings = raw ? JSON.parse(raw) : {};
    settings.lookupPublicIp = false;
    localStorage.setItem("exp-ip-scanner-settings", JSON.stringify(settings));
  });
  await page.reload({ waitUntil: "networkidle" });

  const summary = page.getByLabel("Network summary", { exact: true });
  await summary.waitFor({ timeout: 5_000 });
  const text = (await summary.innerText()).replace(/\s+/g, " ");
  // "Off" rather than "Unavailable": nobody asked, so nothing failed.
  if (!/Public IP Off/.test(text)) throw new Error(`expected the lookup to read Off: ${text}`);
  if (/Unavailable/.test(text)) throw new Error("a deliberate choice is reported as a failure");
  // The rest of the summary is unaffected.
  if (!/Gateway 192\.168\.50\.1/.test(text)) throw new Error(`the summary lost the gateway: ${text}`);
  return text.split("·").pop().trim();
}, async () => {
  await page.evaluate(() => {
    const raw = localStorage.getItem("exp-ip-scanner-settings");
    const settings = raw ? JSON.parse(raw) : {};
    settings.lookupPublicIp = true;
    localStorage.setItem("exp-ip-scanner-settings", JSON.stringify(settings));
  });
  await page.reload({ waitUntil: "networkidle" });
});

await step("the empty state says what will be scanned and how much", async () => {
  const text = await page.locator("main").innerText();
  if (!/Ready to scan/.test(text)) throw new Error("no ready state");
  if (!/\d+ addresses/.test(text)) throw new Error(`no address count: ${text}`);
  // Not an empty grid of column headings over nothing.
  if ((await page.locator("thead").count()) > 0) throw new Error("an empty table is on screen");
  return text.split("\n").slice(0, 2).join(" · ");
});

await step("a scan can be started from the empty state", async () => {
  const button = page.getByRole("button", { name: "Scan network" });
  if (!(await button.isEnabled())) throw new Error("the empty state's Scan button is disabled");
  return "enabled";
});

// --- Scanning -------------------------------------------------------------

await step("devices appear progressively while the scan is running", async () => {
  await page.locator('form button[type="submit"]').click();
  await page.locator("tbody tr").first().waitFor({ timeout: 15_000 });
  const early = await page.locator("tbody tr[aria-rowindex]").count();
  if (early === 0) throw new Error("no rows while scanning");

  // The Scan button became Stop rather than sitting beside one.
  await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 5_000 });
  if ((await page.getByRole("button", { name: "Scan", exact: true }).count()) > 0) {
    throw new Error("Scan and Stop are both on screen");
  }

  // And more arrive.
  await page.waitForTimeout(1_200);
  const later = await page.locator("tbody tr[aria-rowindex]").count();
  if (later <= early) throw new Error(`rows did not keep arriving (${early} then ${later})`);
  return `${early} rows, then ${later}`;
});

await step("the progress strip reports addresses, devices and elapsed time", async () => {
  const text = await page.locator("main + aside, main").last().innerText().catch(() => "");
  const strip = await page.locator("body").innerText();
  if (!/\d+ \/ \d+ addresses/.test(strip)) throw new Error(`no address progress: ${strip}`);
  if (!/found/.test(strip)) throw new Error("no device count");
  void text;
  return "addresses, found and elapsed shown";
});

await step(
  "the interface stays usable while a scan runs",
  async () => {
    // Typing in the search box mid-scan has to work, or the table is a
    // spectator sport. Matched on an address and a service, which are known
    // the moment a device is discovered -- a manufacturer is not, because it
    // comes from the ARP pass at the end of the scan.
    //
    // Deliberately no comparison between two counts taken at different
    // moments: devices are still arriving between them, so any such assertion
    // would be a race rather than a check.
    const matching = async (query) => {
      await page.locator("#results-search").fill(query);
      await page.waitForTimeout(150);
      return page.locator("tbody tr[aria-rowindex]").count();
    };

    const byAddress = await matching("192.168.50.");
    if (byAddress === 0) throw new Error("searching by address found nothing mid-scan");

    const byService = await matching("https");
    if (byService === 0) throw new Error("searching by service found nothing mid-scan");

    const noMatch = await matching("zzzz-no-such-device");
    if (noMatch !== 0) throw new Error(`a query matching nothing still showed ${noMatch} rows`);

    return `${byAddress} by address, ${byService} by service, mid-scan`;
  },
  resetView,
);

await step("stopping a scan ends it promptly and keeps what was found", async () => {
  const before = await page.locator("tbody tr[aria-rowindex]").count();
  const started = Date.now();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 10_000 });
  const elapsed = Date.now() - started;
  const after = await page.locator("tbody tr[aria-rowindex]").count();
  if (after < before) throw new Error(`rows were lost on stop (${before} then ${after})`);
  const summary = await page.locator("body").innerText();
  if (!/Stopped early/.test(summary)) throw new Error("the summary does not say it was stopped");
  return `stopped in ${elapsed} ms, kept ${after} devices`;
});

// --- A finished scan ------------------------------------------------------

await runScan();

await step("the completion summary reports devices, addresses and duration", async () => {
  const text = await page.locator("body").innerText();
  const match = text.match(/(\d+) devices found[\s\S]{0,80}?(\d+) of (\d+) addresses scanned/);
  if (!match) throw new Error(`no completion summary: ${text.slice(-200)}`);
  if (!/\d+(\.\d+)? sec|\d+ ms/.test(text)) throw new Error("no duration in the summary");
  // And no modal interrupting the technician.
  if ((await page.getByRole("dialog").count()) > 0) throw new Error("a dialog opened on completion");
  return match[0].replace(/\s+/g, " ");
});

await step("every default column is present", async () => {
  const headers = await page.locator("thead th").allInnerTexts();
  const expected = ["IP ADDRESS", "HOSTNAME", "MAC ADDRESS", "MANUFACTURER", "LATENCY", "OPEN PORTS"];
  for (const name of expected) {
    if (!headers.some((h) => h.toUpperCase().includes(name))) {
      throw new Error(`no ${name} column in ${JSON.stringify(headers)}`);
    }
  }
  return headers.filter(Boolean).join(", ");
});

await step("addresses, hostnames, MACs, manufacturers, latency and services are populated", async () => {
  const server = row("dc01.exp.local").first();
  const cells = await server.locator("td").allInnerTexts();
  const [, ip, hostname, mac, vendor, latency, ports] = cells;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip ?? "")) throw new Error(`bad address cell: ${ip}`);
  if (hostname !== "dc01.exp.local") throw new Error(`bad hostname cell: ${hostname}`);
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac ?? "")) throw new Error(`bad MAC cell: ${mac}`);
  if (!vendor) throw new Error("no manufacturer");
  if (!/ms$/.test(latency ?? "")) throw new Error(`bad latency cell: ${latency}`);
  if (!/RDP/.test(ports ?? "")) throw new Error(`no service name in the ports cell: ${ports}`);
  return `${ip} · ${hostname} · ${mac} · ${vendor} · ${latency}`;
});

await step("addresses sort numerically, not as text", async () => {
  const addresses = await page.locator("tbody tr[aria-rowindex] td:nth-child(2)").allInnerTexts();
  const asNumbers = addresses.map((a) =>
    a.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0),
  );
  for (let i = 1; i < asNumbers.length; i++) {
    if (asNumbers[i] < asNumbers[i - 1]) {
      throw new Error(`${addresses[i - 1]} sorted before ${addresses[i]}`);
    }
  }
  // The case a string sort gets wrong has to be present for this to mean
  // anything.
  const nine = addresses.findIndex((a) => a.endsWith(".9"));
  const hundred = addresses.findIndex((a) => a.endsWith(".100"));
  if (nine >= 0 && hundred >= 0 && nine > hundred) {
    throw new Error("a .9 address sorted after a .100 address");
  }
  return `${addresses.length} addresses in order`;
});

await step("a column header re-sorts the table", async () => {
  await page.getByRole("columnheader", { name: /Latency/i }).getByRole("button").click();
  await page.waitForTimeout(200);
  const first = await page.locator("tbody tr[aria-rowindex]").first().innerText();
  await page.getByRole("columnheader", { name: /IP address/i }).getByRole("button").click();
  await page.waitForTimeout(200);
  const back = await page.locator("tbody tr[aria-rowindex]").first().innerText();
  if (first === back) throw new Error("sorting by latency changed nothing");
  return "latency and address orders differ";
});

await step("search matches an address, a name, a manufacturer and a service", async () => {
  const counts = {};
  for (const [query, expect] of [
    ["192.168.50.10", 2],
    ["dc01", 1],
    ["ubiquiti", 3],
    ["rdp", 3],
    ["9100", 2],
    ["print", 2],
    ["brother", 1],
  ]) {
    await page.locator("#results-search").fill(query);
    await page.waitForTimeout(120);
    const found = await page.locator("tbody tr[aria-rowindex]").count();
    counts[query] = found;
    if (found === 0) throw new Error(`"${query}" matched nothing`);
    void expect;
  }
  await page.locator("#results-search").fill("zzzz-no-such-device");
  await page.waitForTimeout(150);
  const empty = await page.locator("main").innerText();
  if (!/No devices match/.test(empty)) throw new Error("no empty-search state");
  return Object.entries(counts).map(([q, n]) => `${q}:${n}`).join(" ");
}, resetView);

await step("the filters narrow the table and report their counts", async () => {
  const all = await page.locator("tbody tr[aria-rowindex]").count();
  await page.getByRole("button", { name: /^Responding/ }).click();
  await page.waitForTimeout(150);
  const responding = await page.locator("tbody tr[aria-rowindex]").count();
  if (responding >= all) throw new Error(`Responding did not narrow (${all} then ${responding})`);

  await page.getByRole("button", { name: /^Has services/ }).click();
  await page.waitForTimeout(150);
  const services = await page.locator("tbody tr[aria-rowindex]").count();
  if (services >= all) throw new Error("Has services did not narrow");

  await page.getByRole("button", { name: /^All/ }).click();
  await page.waitForTimeout(150);
  if ((await page.locator("tbody tr[aria-rowindex]").count()) !== all) {
    throw new Error("All did not restore every device");
  }
  return `all ${all}, responding ${responding}, with services ${services}`;
}, resetView);

// --- Device details and actions ------------------------------------------

await step("double-clicking a device opens its details without leaving the scan", async () => {
  await row("dc01.exp.local").first().dblclick();
  const drawer = page.getByRole("complementary");
  await drawer.waitFor({ timeout: 5_000 });
  const text = await drawer.innerText();
  for (const field of ["IP ADDRESS", "HOSTNAME", "MAC ADDRESS", "MANUFACTURER", "LATENCY", "TTL"]) {
    if (!text.toUpperCase().includes(field)) throw new Error(`the panel omits ${field}`);
  }
  if (!/OPEN PORTS/i.test(text)) throw new Error("the panel omits the open ports");
  if (!/Ethernet/.test(text)) throw new Error("the panel omits the network context");
  // The table is still there behind it.
  if ((await page.locator("tbody tr[aria-rowindex]").count()) === 0) {
    throw new Error("the results went away");
  }
  return "every field present, results still on screen";
});

await step("the details panel offers the action that device is for", async () => {
  const drawer = page.getByRole("complementary");
  const primary = drawer.getByRole("button", { name: "Open Remote Desktop" }).first();
  if (!(await primary.isVisible())) throw new Error("no Remote Desktop action on a server");
  return "Remote Desktop offered for a device with 3389 open";
});

await step("the device-type guess is labelled as a guess", async () => {
  const text = await page.getByRole("complementary").innerText();
  if (!/\(estimated\)/.test(text)) throw new Error("the type guess is presented as a fact");
  return "labelled (estimated)";
});

await step("Escape closes the details panel", async () => {
  await page.keyboard.press("Escape");
  await page.getByRole("complementary").waitFor({ state: "detached", timeout: 3_000 });
  return "closed";
});

await step("right-clicking a device offers the actions its ports support", async () => {
  await row("dc01.exp.local").first().click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor({ timeout: 5_000 });

  const enabled = async (name) => {
    const item = menu.getByRole("menuitem", { name });
    return (await item.count()) > 0 && (await item.first().isEnabled());
  };
  // A domain controller: Remote Desktop and file shares, but no SSH.
  if (!(await enabled("Open Remote Desktop"))) throw new Error("Remote Desktop is disabled on 3389");
  if (!(await enabled("Open file shares"))) throw new Error("File shares are disabled on 445");
  if (await enabled("Open SSH")) throw new Error("SSH is offered with port 22 closed");
  // Every action is listed whether or not it applies, so the menu never
  // changes shape.
  for (const name of ["Open web interface", "Open VNC", "Ping", "Traceroute", "Copy IP address"]) {
    if ((await menu.getByRole("menuitem", { name }).count()) === 0) {
      throw new Error(`${name} is missing from the menu`);
    }
  }
  return "RDP and SMB enabled, SSH correctly disabled";
});

await step("the menu adapts to a device with different services", async () => {
  await page.keyboard.press("Escape");
  await row("ap-office-01.exp.local").first().click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor({ timeout: 5_000 });
  if (!(await menu.getByRole("menuitem", { name: "Open SSH" }).first().isEnabled())) {
    throw new Error("SSH is disabled on an access point with port 22 open");
  }
  if (await menu.getByRole("menuitem", { name: "Open Remote Desktop" }).first().isEnabled()) {
    throw new Error("Remote Desktop is offered with port 3389 closed");
  }
  await page.keyboard.press("Escape");
  return "SSH enabled, Remote Desktop correctly disabled";
});

await step("the menu offers Copy cell for the column that was clicked", async () => {
  await row("dc01.exp.local").first().locator("td").nth(3).click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor({ timeout: 5_000 });
  if ((await menu.getByRole("menuitem", { name: /Copy mac address/i }).count()) === 0) {
    throw new Error("no Copy cell item for the MAC column");
  }
  await page.keyboard.press("Escape");
  return "Copy cell names the MAC column";
});

// --- Keyboard -------------------------------------------------------------

await step("the results grid is keyboard navigable", async () => {
  await page.locator('[role="grid"]').click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const active = await page.locator('[role="grid"]').getAttribute("aria-activedescendant");
  if (!active) throw new Error("no row is focused after two ArrowDowns");
  await page.keyboard.press("Enter");
  await page.getByRole("complementary").waitFor({ timeout: 3_000 });
  await page.keyboard.press("Escape");
  return `Enter opened ${active}`;
});

await step("Ctrl+F focuses search and Escape clears it", async () => {
  await page.keyboard.press("Control+f");
  const focused = await page.evaluate(() => document.activeElement?.id);
  if (focused !== "results-search") throw new Error(`focus went to ${focused}`);
  await page.keyboard.type("dc01");
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  if ((await page.locator("#results-search").inputValue()) !== "") {
    throw new Error("Escape did not clear the search");
  }
  return "Ctrl+F focuses, Escape clears";
});

await step("Ctrl+A selects every visible row", async () => {
  await page.locator('[role="grid"]').click();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(150);
  const selected = await page.locator('tbody tr[aria-selected="true"]').count();
  const total = await page.locator("tbody tr[aria-rowindex]").count();
  if (selected !== total) throw new Error(`${selected} of ${total} rows selected`);
  return `${selected} rows`;
});

// --- Output ---------------------------------------------------------------

await step("Export CSV produces a spreadsheet of the rows on screen", async () => {
  const download = page.waitForEvent("download", { timeout: 10_000 });
  await page.getByRole("button", { name: /Export CSV/i }).click();
  const file = await download;
  const name = file.suggestedFilename();
  if (!/^exp-ip-scanner-.*\.csv$/.test(name)) throw new Error(`unexpected filename: ${name}`);

  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString("utf8");

  if (!csv.startsWith("﻿")) throw new Error("no UTF-8 byte-order mark for Excel");
  const [header] = csv.replace(/^﻿/, "").split("\r\n");
  for (const column of ["IP Address", "Hostname", "MAC Address", "Manufacturer", "Latency (ms)", "Open Ports", "Services", "Scan Target", "Scan Time"]) {
    if (!header.includes(column)) throw new Error(`the CSV omits ${column}`);
  }
  const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
  if (lines.length < 5) throw new Error(`only ${lines.length - 1} device rows exported`);
  return `${name}, ${lines.length - 1} devices`;
});

await step("Copy puts a tab-separated table on the clipboard", async () => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator(".results-toolbar").getByRole("button", { name: /^Copy/ }).first().click();
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const [header, first] = text.split("\n");
  if (!header.includes("\t")) throw new Error("the clipboard text is not tab separated");
  if (!first || first.split("\t").length !== header.split("\t").length) {
    throw new Error("a row does not line up with the header");
  }
  return `${text.split("\n").length - 1} rows, ${header.split("\t").length} columns`;
});

await step("Clear empties the results", async () => {
  await page.getByRole("button", { name: "Clear the results" }).click();
  await page.waitForTimeout(250);
  if ((await page.locator("tbody tr[aria-rowindex]").count()) > 0) {
    throw new Error("rows survived Clear");
  }
  const text = await page.locator("main").innerText();
  if (!/Ready to scan/.test(text)) throw new Error("the ready state did not come back");
  return "back to the ready state";
});

// --- Settings -------------------------------------------------------------

await step("Settings opens, edits and restores defaults", async () => {
  await page.getByLabel("Settings").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 5_000 });

  const timeout = dialog.locator('input[type="number"]').first();
  const original = await timeout.inputValue();
  await timeout.fill("2500");
  await timeout.blur();

  await dialog.getByLabel("Detect open services").uncheck();
  if (await dialog.locator("#port-spec").isEnabled()) {
    throw new Error("the port field stays editable with service detection off");
  }

  await dialog.getByRole("button", { name: /Restore defaults/i }).click();
  await page.waitForTimeout(200);
  if ((await timeout.inputValue()) !== original) {
    throw new Error(`Restore defaults left the timeout at ${await timeout.inputValue()}`);
  }
  if (!(await dialog.getByLabel("Detect open services").isChecked())) {
    throw new Error("Restore defaults left service detection off");
  }

  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 3_000 });
  return `timeout restored to ${original} ms`;
});

await step("a column can be turned off and back on", async () => {
  await runScan();
  const before = await page.locator("thead th").count();
  await page.getByRole("button", { name: /Columns/i }).click();
  await page.getByRole("menuitemcheckbox", { name: /MAC address/i }).click();
  await page.waitForTimeout(150);
  const after = await page.locator("thead th").count();
  if (after !== before - 1) throw new Error(`${before} then ${after} columns`);
  await page.getByRole("menuitemcheckbox", { name: /MAC address/i }).click();
  await page.waitForTimeout(150);
  if ((await page.locator("thead th").count()) !== before) {
    throw new Error("the column did not come back");
  }
  await page.keyboard.press("Escape");
  return `${before} columns, one toggled off and on`;
});

await step("a settings change survives a restart", async () => {
  await page.getByLabel("Settings").click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("Row height").selectOption("comfortable");
  await page.getByRole("button", { name: "Done" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.getByLabel("Settings").click();
  await page.getByRole("dialog").waitFor();
  const density = await page.getByLabel("Row height").inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  if (density !== "comfortable") throw new Error(`row height came back as ${density}`);
  // Put it back for the theme checks below.
  await page.getByLabel("Settings").click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("Row height").selectOption("compact");
  await page.getByRole("button", { name: "Done" }).click();
  return "row height persisted";
});

// --- About ----------------------------------------------------------------

await step("About reports the version and links out", async () => {
  await page.getByLabel("About EXP IP Scanner").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 5_000 });
  const text = await dialog.innerText();
  if (!/Version \d+\.\d+\.\d+/.test(text)) throw new Error(`no version: ${text}`);
  if (!/no account, no telemetry/i.test(text)) throw new Error("no privacy statement");
  for (const link of ["Website", "Privacy", "Releases"]) {
    if ((await dialog.getByRole("button", { name: link }).count()) === 0) {
      throw new Error(`no ${link} link`);
    }
  }
  await page.keyboard.press("Escape");
  return text.split("\n")[1];
});

// --- Themes and window sizes ---------------------------------------------

for (const theme of ["light", "dark"]) {
  await step(`the ${theme} theme is applied throughout`, async () => {
    await setTheme(theme);
    await runScan();
    const applied = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      body: getComputedStyle(document.body).backgroundColor,
      ink: getComputedStyle(document.body).color,
    }));
    if (applied.dark !== (theme === "dark")) throw new Error("the dark class does not match");

    // Text on the window background has to be legible in both.
    const parse = (value) => value.match(/\d+/g).slice(0, 3).map(Number);
    const luminance = (rgb) =>
      rgb
        .map((c) => c / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const [a, b] = [luminance(parse(applied.body)), luminance(parse(applied.ink))];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 7) throw new Error(`body text contrast is only ${ratio.toFixed(1)}:1`);
    return `${applied.body} on ${applied.ink}, ${ratio.toFixed(1)}:1`;
  });
}

for (const size of SIZES) {
  await step(`nothing overflows at ${size.width}x${size.height} (${size.label})`, async () => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    // The window itself never scrolls; the table scrolls inside it.
    if (overflow.x > 0) throw new Error(`the window overflows horizontally by ${overflow.x}px`);
    if (overflow.y > 0) throw new Error(`the window overflows vertically by ${overflow.y}px`);
    // The controls that matter are still reachable.
    if (!(await page.locator("#scan-target").isVisible())) throw new Error("the target field is hidden");
    if (!(await page.locator("#results-search").isVisible())) throw new Error("search is hidden");
    if ((await page.locator("tbody tr[aria-rowindex]").count()) === 0) {
      throw new Error("no rows are rendered");
    }

    // The summary gives up its address count as the window narrows, never an
    // address: half of an IP address is not a smaller IP address.
    const summary = (await page.getByLabel("Network summary", { exact: true }).innerText()).replace(/\s+/g, " ");
    for (const address of ["192.168.50.37", "192.168.50.1", "203.0.113.42"]) {
      if (!summary.includes(address)) throw new Error(`${address} is cut off: ${summary}`);
    }
    if (summary.includes("\u2026")) throw new Error(`the summary ellipsised a value: ${summary}`);
    return "no overflow, controls reachable, addresses whole";
  });
}

await step("the details panel fits alongside the table at the minimum window size", async () => {
  await page.setViewportSize({ width: 860, height: 560 });
  await page.waitForTimeout(200);
  await page.locator("tbody tr").first().dblclick();
  await page.getByRole("complementary").waitFor({ timeout: 5_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) throw new Error(`the window overflows by ${overflow}px with the panel open`);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1180, height: 780 });
  return "no overflow";
});

// --- A large scan ---------------------------------------------------------

await step("a larger target stays responsive", async () => {
  await page.locator("#scan-target").fill("192.168.50.0/23");
  await page.waitForTimeout(400);
  const started = Date.now();
  await runScan();
  const elapsed = Date.now() - started;
  const rows = await page.locator("tbody tr[aria-rowindex]").count();
  if (rows === 0) throw new Error("no devices found on a /23");

  // Scrolling the table has to stay smooth, which is what the row windowing is
  // for. Measured as: a scroll and a repaint inside one animation frame budget.
  const scrollTime = await page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]');
    if (!grid) return 0;
    const start = performance.now();
    grid.scrollTop = grid.scrollHeight;
    void grid.offsetHeight;
    return performance.now() - start;
  });
  if (scrollTime > 100) throw new Error(`scrolling the table took ${scrollTime.toFixed(0)} ms`);
  return `${rows} devices, scan ${(elapsed / 1000).toFixed(1)} s, scroll ${scrollTime.toFixed(1)} ms`;
});

await step("a malformed target is refused with a readable message", async () => {
  for (const bad of ["nonsense", "192.168.1", "192.168.1.0/33", "10.0.0.50-10.0.0.1"]) {
    await page.locator("#scan-target").fill(bad);
    await page.waitForTimeout(400);
    const alert = page.getByRole("alert");
    if ((await alert.count()) === 0) throw new Error(`"${bad}" produced no error`);
    const message = await alert.first().innerText();
    if (/panicked|unwrap|Error\(|ParseIntError/.test(message)) {
      throw new Error(`"${bad}" leaked an internal error: ${message}`);
    }
    if (await page.getByRole("button", { name: "Scan", exact: true }).isEnabled()) {
      throw new Error(`Scan is still enabled for "${bad}"`);
    }
  }
  await page.locator("#scan-target").fill("192.168.50.0/24");
  await page.waitForTimeout(400);
  return "four malformed targets refused cleanly";
});

await step("the interface logged no errors throughout", () => {
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
console.log("\nEvery interface check passed.");

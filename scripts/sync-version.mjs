#!/usr/bin/env node
// Propagate the version in package.json to every file that carries a copy.
//
// package.json is the single source of truth. The window reads it through a
// Vite define, and everything below is rewritten from it rather than edited by
// hand, because a release where the installer, the in-app version and the
// website disagree is worse than one that is simply late.
//
//   node scripts/sync-version.mjs           rewrite the files
//   node scripts/sync-version.mjs --check   report drift and exit non-zero
//
// CI runs the --check form, so a bump that missed a file fails the build
// instead of shipping.
//
// Adapted from ArcScan's script: the anchor-on-context approach is the right
// one, because matching a bare version number would rewrite an unrelated one.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`package.json version "${version}" is not a semantic version.`);
  process.exit(1);
}

/**
 * Each target names a file, a pattern that matches exactly the version
 * occurrence, and how to rebuild it. Anchoring on the surrounding context
 * rather than on the number keeps the rewrite off a dependency's version.
 */
const targets = [
  {
    file: "src-tauri/Cargo.toml",
    // The [package] version is the first `version = "..."` in the file.
    pattern: /^(version\s*=\s*")[^"]+(")/m,
  },
  {
    file: "src-tauri/tauri.conf.json",
    pattern: /("version"\s*:\s*")[^"]+(")/,
  },
  {
    file: "src-tauri/updater.conf.json",
    pattern: /("version"\s*:\s*")[^"]+(")/,
  },
  {
    file: "site/index.html",
    // The structured-data version, which is what search results quote.
    pattern: /("softwareVersion"\s*:\s*")[^"]+(")/,
  },
  {
    file: "site/index.html",
    // The version shown before the GitHub API answers. Stale here still means
    // a wrong number in front of a real person.
    pattern: /(<span id="version-fallback">v)[^<]+(<\/span>)/,
  },
  {
    file: "site/index.html",
    // One per download card. Global, because there are two.
    pattern: /(<span data-field="version">)[^<]+(<\/span>)/g,
  },
  {
    file: "site/index.html",
    pattern: /(<span id="release-line-version">v)[^<]+(<\/span>)/,
  },
  {
    file: "site/index.html",
    pattern: /(id="release-notes-link" href="whats-new-)[^"]+(\.html")/,
  },
  {
    file: "site/index.html",
    pattern: /(id="release-notes-link" href="whats-new-[^"]+\.html">What changed in )[^<]+(<\/a>)/,
  },
  {
    file: "site/releases.html",
    pattern: /(<span id="current-version">v)[^<]+(<\/span>)/,
  },
  {
    file: "site/privacy.html",
    pattern: /(<span id="privacy-version">v)[^<]+(<\/span>)/,
  },
];

const problems = [];
const updated = new Set();

for (const target of targets) {
  const path = join(root, target.file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    problems.push(`${target.file}: file not found`);
    continue;
  }

  if (!target.pattern.test(text)) {
    problems.push(`${target.file}: no version placeholder matched ${target.pattern}`);
    continue;
  }
  // A global regex keeps state between calls to test() and replace().
  target.pattern.lastIndex = 0;

  const next = text.replace(target.pattern, (_match, before, after) => `${before}${version}${after}`);
  if (next === text) continue;

  if (check) {
    problems.push(`${target.file}: version is out of date (expected ${version})`);
  } else {
    writeFileSync(path, next);
    updated.add(target.file);
  }
}

if (problems.length > 0) {
  console.error(`Version ${version} is not applied everywhere:`);
  for (const problem of problems) console.error(`  ${problem}`);
  if (check) console.error("\nRun `npm run sync-version` and commit the result.");
  process.exit(1);
}

if (check) {
  console.log(`Version ${version} is consistent across every file.`);
} else if (updated.size === 0) {
  console.log(`Version ${version} was already applied everywhere.`);
} else {
  console.log(`Version ${version} written to:`);
  for (const file of updated) console.log(`  ${file}`);
}

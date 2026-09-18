#!/usr/bin/env node
// A release is not ready until the website explains what changed.
//
// package.json is the version source of truth. For that version we require:
//   site/whats-new-X.Y.Z.html
//   a current-version link from the homepage
//   an entry in the changelog index
//   a matching CHANGELOG.md section
//
// This keeps release communication in the same workflow as the binaries.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const notesName = `whats-new-${version}.html`;
const notesPath = join(root, "site", notesName);

const failures = [];
if (!existsSync(notesPath)) {
  failures.push(`site/${notesName} does not exist`);
} else {
  const notes = readFileSync(notesPath, "utf8");
  if (!notes.includes(`EXP IP Scanner ${version}`)) {
    failures.push(`site/${notesName} does not identify version ${version}`);
  }
}

const home = readFileSync(join(root, "site", "index.html"), "utf8");
if (!home.includes(`id="release-notes-link" href="${notesName}"`)) {
  failures.push(`site/index.html does not link release-notes-link to ${notesName}`);
}
if (!home.includes(`What changed in ${version}`)) {
  failures.push(`site/index.html does not label the current release notes as ${version}`);
}

const releases = readFileSync(join(root, "site", "releases.html"), "utf8");
if (!releases.includes(`href="${notesName}"`)) {
  failures.push(`site/releases.html does not link to ${notesName}`);
}
if (!releases.includes(`>${version}<`)) {
  failures.push(`site/releases.html does not list version ${version}`);
}

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
if (!new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(changelog)) {
  failures.push(`CHANGELOG.md has no ## ${version} section`);
}

if (failures.length) {
  console.error(`Release notes for ${version} are incomplete:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nAdd the changelog entry and readable website release page before publishing.");
  process.exit(1);
}

console.log(`Release notes for ${version} are complete: site/${notesName}`);

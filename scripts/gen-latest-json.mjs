#!/usr/bin/env node
// Build the updater manifest (latest.json) from the artifacts a release built.
//
// The installed edition asks GitHub for this file, compares its version, and
// downloads the named installer if it is newer. Everything in it therefore has
// to be true: the version, the URL and, above all, the signature -- the updater
// refuses a payload whose signature does not verify against the public key
// compiled into the application.
//
//   node scripts/gen-latest-json.mjs v1.1.2 nazar-exp/EXP-IP-Scanner dist
//
// Reads <dir>, writes <dir>/latest.json.
//
// Adapted from ArcScan's generator, with the platform matrix reduced to the one
// target this release supports.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tag, repository, dir = "dist"] = process.argv.slice(2);

if (!tag || !repository) {
  console.error("usage: gen-latest-json.mjs <tag> <owner/repo> [dir]");
  process.exit(1);
}
if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag)) {
  console.error(`"${tag}" is not a release tag (expected vX.Y.Z).`);
  process.exit(1);
}
if (!existsSync(dir)) {
  console.error(`no artifact directory at ${dir}`);
  process.exit(1);
}

const version = tag.replace(/^v/, "");
const files = readdirSync(dir);

/**
 * The platforms this manifest may describe, and how to find each one's payload.
 *
 * A portable ZIP is deliberately absent: it is not an updater payload, it is
 * built without the updater linked, and naming it here would offer installed
 * copies an update that cannot be applied.
 */
const PLATFORMS = [
  {
    key: "windows-x86_64",
    // The NSIS installer is both the download and the updater payload.
    matches: (name) => name === `EXP-IP-Scanner_${version}_x64-setup.exe`,
  },
];

const platforms = {};
for (const platform of PLATFORMS) {
  const payload = files.find(platform.matches);
  if (!payload) {
    console.error(`No updater payload found for ${platform.key} in ${dir}`);
    console.error(`Files present: ${files.join(", ")}`);
    process.exit(1);
  }
  const signatureFile = `${payload}.sig`;
  if (!files.includes(signatureFile)) {
    console.error(
      `${payload} has no signature (${signatureFile}). The build must run with ` +
        "TAURI_SIGNING_PRIVATE_KEY set and --config src-tauri/updater.conf.json.",
    );
    process.exit(1);
  }

  const signature = readFileSync(join(dir, signatureFile), "utf8").trim();
  if (!signature) {
    console.error(`${signatureFile} is empty.`);
    process.exit(1);
  }

  platforms[platform.key] = {
    signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(payload)}`,
  };
  console.log(`  ${platform.key} -> ${payload}`);
}

const manifest = {
  version,
  notes: `See https://github.com/${repository}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

const out = join(dir, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nWrote ${out} for ${tag}`);

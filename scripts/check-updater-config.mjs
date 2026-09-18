#!/usr/bin/env node
// Decide whether this repository can publish signed updater artifacts.
//
// The installed edition's auto-updater needs two things that cannot live in a
// public repository's source: a minisign public key in tauri.conf.json, and the
// matching private key as a repository secret. Until a maintainer has run
// `npm run tauri signer generate` once and set both, there is nothing to sign
// with, and a release that published an unsigned or wrongly signed latest.json
// would offer every installed copy an update it must then refuse.
//
// So the release workflow asks this script first:
//
//   node scripts/check-updater-config.mjs          report, exit 0 either way
//   node scripts/check-updater-config.mjs --require exit 1 if not configured
//
// Configured: the release builds updater artifacts and publishes latest.json.
// Not configured: the release still builds and publishes the installer and the
// portable ZIP, and simply carries no updater manifest. A first release is not
// blocked on a key that has not been generated yet.
//
// It writes `configured=true|false` to $GITHUB_OUTPUT when running in Actions.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The value shipped in the repository, which is not a key.
 *
 * Named here rather than pattern-matched, so replacing it with a real key is
 * the only thing that turns updates on.
 */
export const PLACEHOLDER = "REPLACE_WITH_TAURI_SIGNING_PUBLIC_KEY";

/**
 * Whether a string looks like a key `tauri signer generate` produced.
 *
 * A minisign public key is base64 that decodes to a comment line followed by a
 * second base64 line. Checking the shape catches a truncated paste, which
 * would otherwise fail at update time on a technician's machine rather than
 * here.
 */
export function looksLikeSigningKey(pubkey) {
  if (typeof pubkey !== "string") return false;
  const trimmed = pubkey.trim();
  if (trimmed.length === 0 || trimmed === PLACEHOLDER) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed) || trimmed.length < 80) return false;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return /minisign public key/i.test(decoded) && decoded.trim().split("\n").length >= 2;
  } catch {
    return false;
  }
}

/** Read the public key out of the Tauri config. */
export function configuredPubkey(configPath = join(root, "src-tauri", "tauri.conf.json")) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return config?.plugins?.updater?.pubkey ?? "";
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const pubkey = configuredPubkey();
  const configured = looksLikeSigningKey(pubkey);
  const hasSecret = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
  const ready = configured && hasSecret;

  if (ready) {
    console.log("Updater: configured. This release will publish signed updater artifacts.");
  } else {
    console.log("Updater: not configured. This release will publish the installer and the");
    console.log("portable ZIP without updater artifacts, and no latest.json.");
    if (!configured) {
      console.log(
        pubkey === PLACEHOLDER || pubkey === ""
          ? "  - src-tauri/tauri.conf.json still holds the placeholder public key."
          : "  - the public key in src-tauri/tauri.conf.json is not a minisign key.",
      );
      console.log("    Run `npm run tauri signer generate -- -w ~/.tauri/exp-ip-scanner.key`,");
      console.log("    then paste the printed public key into plugins.updater.pubkey.");
    }
    if (!hasSecret) {
      console.log("  - the TAURI_SIGNING_PRIVATE_KEY repository secret is not set.");
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `configured=${ready}\n`);
  }

  if (process.argv.includes("--require") && !ready) {
    console.error("\nRefusing to continue: updater artifacts were required but cannot be signed.");
    process.exit(1);
  }
}

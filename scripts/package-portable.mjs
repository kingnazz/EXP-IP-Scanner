#!/usr/bin/env node
// Package the Windows portable ZIP.
//
// One script, used by the release workflow and by hand, so the packaging rules
// live in one readable place rather than spread across shell steps in two
// workflows that can drift apart. Everything it can check, it checks, and it
// fails rather than shipping something almost right:
//
//   * the binary it was pointed at exists;
//   * it is a Windows PE for the architecture the ZIP is named after, read out
//     of the PE header rather than inferred from the path;
//   * it is the *portable* build, not the installed one (see below);
//   * the staged payload is exactly the desktop executable, the Backstage
//     console companion, and the README;
//   * nothing else -- no installer, no updater manifest, no signature, no
//     debug symbols -- came along.
//
//   node scripts/package-portable.mjs --version 1.0.0
//                                     --target x86_64-pc-windows-msvc
//                                     --binary <path to the desktop exe>
//                                     --backstage-binary <path to console exe>
//                                     [--out dist-portable]
//
// Adapted from ArcScan's script, including the PE-header check and the
// updater-marker check, both of which exist because the mistakes they catch
// produce a ZIP that looks correct and is not.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function die(message) {
  console.error(`package-portable: ${message}`);
  process.exit(1);
}

/**
 * The Rust targets that get a portable ZIP, and what each is called in the
 * asset name and in a PE header.
 *
 * x64 only for 1.0.0, which is what the release supports. The table is here
 * rather than inline so adding ARM64 later is one entry and no new logic.
 */
export const TARGETS = {
  "x86_64-pc-windows-msvc": { label: "windows-x64", machine: 0x8664, machineName: "x64" },
  "aarch64-pc-windows-msvc": { label: "windows-arm64", machine: 0xaa64, machineName: "ARM64" },
};

/** What the executables are called inside the ZIP. */
export const EXE_NAME = "EXP IP Scanner.exe";
export const BACKSTAGE_EXE_NAME = "EXP IP Scanner Backstage.exe";

/** Exactly what a portable ZIP may contain, and nothing else. */
export const EXPECTED_PAYLOAD = [EXE_NAME, BACKSTAGE_EXE_NAME, "README-PORTABLE.txt"];

/**
 * Strings that are in the binary only because the updater plugin is linked.
 *
 * ArcScan arrived at this list by building both editions and diffing them, and
 * the note it left is worth keeping: the updater *endpoint* is deliberately not
 * on the list, because `tauri::generate_context!` embeds the whole of
 * tauri.conf.json -- `plugins.updater.endpoints` included -- so that URL is in
 * the portable binary too and testing for it would reject every portable build.
 */
export const UPDATER_MARKERS = [
  "tauri-plugin-updater",
  "plugin:updater",
  "download_and_install",
  // The signature verifier the updater uses, and nothing else does.
  "minisign",
];

/** The asset name for a version and target. */
export function assetName(version, target) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`unsupported target ${target}`);
  return `EXP-IP-Scanner_${version}_${spec.label}-portable.zip`;
}

/**
 * Read the machine type out of a Windows PE file.
 *
 * A filename is not evidence. Cross-compiling both Windows targets on one
 * runner makes it entirely possible to pick up the wrong release directory and
 * hand an x64 binary to the ARM64 packaging step, producing a ZIP that is
 * correctly named, correctly sized and unrunnable on the machine it was
 * downloaded for. So the header is read: MZ at 0, the PE offset at 0x3c,
 * "PE\0\0" there, and the machine word right after it.
 */
export function peMachine(buffer, describe = "the binary") {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${describe} is not a Windows executable (no MZ signature)`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${describe} is not a Windows executable (no PE signature)`);
  }
  return buffer.readUInt16LE(peOffset + 4);
}

/**
 * Refuse the installed build.
 *
 * A heuristic, and treated as one: it can say "this is definitely the installed
 * build" and never "this is definitely the portable one". That is enough,
 * because the mistake it exists to catch is the one the portable edition exists
 * to prevent -- shipping the installed executable in a ZIP and calling it
 * portable.
 */
export function updaterMarkersIn(buffer) {
  const text = buffer.toString("latin1");
  return UPDATER_MARKERS.filter((marker) => text.includes(marker));
}

/** Fill the README's placeholders for this build. */
export function renderReadme(template, version, architecture) {
  return template.replaceAll("__VERSION__", version).replaceAll("__ARCH__", architecture);
}

// Imported by the tests, which exercise the functions above without packaging
// anything. Running the file packages.
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (!invokedDirectly) {
  // Nothing else to do: the exports above are the whole interface.
} else {
  main();
}

function main() {
  const version = flag("version");
  const target = flag("target");
  const binary = flag("binary");
  const backstageBinary = flag("backstage-binary");
  const outDir = path.resolve(root, flag("out", "dist-portable"));

  if (!version || !target || !binary || !backstageBinary) {
    die(
      "usage: package-portable.mjs --version <x.y.z> --target <rust target> " +
        "--binary <desktop-exe> --backstage-binary <console-exe> [--out <dir>]",
    );
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) die(`"${version}" is not a semantic version`);

  const spec = TARGETS[target];
  if (!spec) {
    die(`unsupported target "${target}". Portable builds are ${Object.keys(TARGETS).join(", ")}.`);
  }

  const binaryPath = path.resolve(root, binary);
  if (!existsSync(binaryPath)) die(`no binary at ${binaryPath}`);
  const buffer = readFileSync(binaryPath);

  let machine;
  try {
    machine = peMachine(buffer, binaryPath);
  } catch (error) {
    die(error.message);
  }
  if (machine !== spec.machine) {
    const known = Object.values(TARGETS).find((t) => t.machine === machine);
    die(
      `${binaryPath} is a ${known ? known.machineName : `0x${machine.toString(16)}`} binary, ` +
        `but ${target} needs ${spec.machineName}. Refusing to package the wrong architecture.`,
    );
  }

  const markers = updaterMarkersIn(buffer);
  if (markers.length > 0) {
    die(
      `${binaryPath} contains updater strings (${markers.join(", ")}), so it is the installed ` +
        `build. Build the portable edition with --no-default-features --features portable.`,
    );
  }

  const backstagePath = path.resolve(root, backstageBinary);
  if (!existsSync(backstagePath)) die(`no Backstage binary at ${backstagePath}`);
  const backstageBuffer = readFileSync(backstagePath);
  let backstageMachine;
  try {
    backstageMachine = peMachine(backstageBuffer, backstagePath);
  } catch (error) {
    die(error.message);
  }
  if (backstageMachine !== spec.machine) {
    const known = Object.values(TARGETS).find((t) => t.machine === backstageMachine);
    die(
      `${backstagePath} is a ${known ? known.machineName : `0x${backstageMachine.toString(16)}`} binary, ` +
        `but ${target} needs ${spec.machineName}. Refusing to package the wrong architecture.`,
    );
  }
  const backstageMarkers = updaterMarkersIn(backstageBuffer);
  if (backstageMarkers.length > 0) {
    die(
      `${backstagePath} contains updater strings (${backstageMarkers.join(", ")}); ` +
        "the Backstage companion must remain updater-free.",
    );
  }

  // ------------------------------------------------------------- staging

  const name = assetName(version, target);
  const staging = path.join(outDir, `staging-${spec.label}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  copyFileSync(binaryPath, path.join(staging, EXE_NAME));
  copyFileSync(backstagePath, path.join(staging, BACKSTAGE_EXE_NAME));

  const readmeSource = path.join(root, "packaging", "README-PORTABLE.txt");
  if (!existsSync(readmeSource)) die(`no README at ${readmeSource}`);
  writeFileSync(
    path.join(staging, "README-PORTABLE.txt"),
    renderReadme(readFileSync(readmeSource, "utf8"), version, spec.machineName),
  );

  const staged = readdirSync(staging).sort();
  if (JSON.stringify(staged) !== JSON.stringify([...EXPECTED_PAYLOAD].sort())) {
    die(`staged payload is ${JSON.stringify(staged)}, expected ${JSON.stringify(EXPECTED_PAYLOAD)}`);
  }

  // ------------------------------------------------------------- the ZIP

  const zipPath = path.join(outDir, name);
  rmSync(zipPath, { force: true });

  /**
   * Make the archive with whatever this platform has: PowerShell on Windows,
   * where the release is built, and `zip` elsewhere so the packaging is
   * testable on a Linux developer machine and in Linux CI. Both produce a flat
   * archive of the staging directory's contents, which is what the
   * verification then reads back.
   */
  const made =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Compress-Archive -Path '${path.join(staging, "*")}' -DestinationPath '${zipPath}' -Force`,
          ],
          { stdio: "inherit" },
        )
      : spawnSync(
          "zip",
          ["-q", "-X", "-j", zipPath, ...EXPECTED_PAYLOAD.map((f) => path.join(staging, f))],
          { stdio: "inherit" },
        );

  if (made.status !== 0) die("the archive command failed");
  if (!existsSync(zipPath)) die(`no archive at ${zipPath}`);

  rmSync(staging, { recursive: true, force: true });

  const size = statSync(zipPath).size;
  console.log(name);
  console.log(`  path         ${zipPath}`);
  console.log(`  size         ${(size / (1024 * 1024)).toFixed(2)} MB (${size} bytes)`);
  console.log(`  contents     ${EXPECTED_PAYLOAD.join(", ")}`);
  console.log(`  target       ${target}`);
  console.log(`  architecture ${spec.machineName} (PE machine 0x${machine.toString(16)})`);
  console.log(`  edition      portable GUI + Backstage console (no updater strings present)`);
}

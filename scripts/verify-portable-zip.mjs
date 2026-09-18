#!/usr/bin/env node
// Read a packaged portable ZIP back and check it is what was promised.
//
// package-portable.mjs checks the binary before packaging; this checks the
// archive afterwards, which is the artifact a technician actually downloads.
// The two together mean a release cannot ship a ZIP holding the installed
// build, the wrong architecture, or an extra file nobody meant to include.
//
//   node scripts/verify-portable-zip.mjs --zip <path> --architecture x64
//                                        --version 1.0.0
//
// Uses the ZIP central directory directly rather than shelling out to a
// platform tool, so it behaves the same on the Windows release runner and on a
// Linux developer machine.

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { EXPECTED_PAYLOAD, EXE_NAME, TARGETS, peMachine, updaterMarkersIn } from "./package-portable.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

let failures = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    console.log(`FAIL  ${name} — ${error.message}`);
    failures += 1;
  }
};

const zipPath = flag("zip");
const architecture = flag("architecture") ?? "x64";
const version = flag("version");
if (!zipPath) {
  console.error("usage: verify-portable-zip.mjs --zip <path> [--architecture x64] [--version x.y.z]");
  process.exit(1);
}

/**
 * Read every entry out of a ZIP's central directory.
 *
 * Only the two storage methods this packaging produces are supported --
 * stored and deflate -- because an entry compressed any other way did not come
 * from the script above and is itself worth failing on.
 */
function readZip(buffer) {
  // The end-of-central-directory record, found by scanning back for its
  // signature. The comment is empty here, so it is near the end.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${n}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    // The local header, whose own name and extra fields precede the data.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let contents;
    if (method === 0) contents = raw;
    else if (method === 8) contents = inflateRawSync(raw);
    else throw new Error(`${name} uses unsupported compression method ${method}`);

    entries.push({ name, uncompressedSize, contents });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const buffer = readFileSync(zipPath);
console.log(`Verifying ${zipPath} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`);

let entries = [];
check("the archive reads as a ZIP", () => {
  entries = readZip(buffer);
  return `${entries.length} entries`;
});

check("it holds exactly the expected payload, flat", () => {
  const names = entries.map((e) => e.name).sort();
  const expected = [...EXPECTED_PAYLOAD].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`contents are ${JSON.stringify(names)}, expected ${JSON.stringify(expected)}`);
  }
  // A nested folder would make "extract and run" a different instruction.
  if (names.some((n) => n.includes("/") || n.includes("\\"))) {
    throw new Error("the archive contains a directory");
  }
  return names.join(", ");
});

check("the executable is a Windows binary for the right architecture", () => {
  const exe = entries.find((e) => e.name === EXE_NAME);
  if (!exe) throw new Error(`${EXE_NAME} is missing`);
  const machine = peMachine(exe.contents, EXE_NAME);
  const spec = Object.values(TARGETS).find((t) => t.machineName === architecture);
  if (!spec) throw new Error(`unknown architecture "${architecture}"`);
  if (machine !== spec.machine) {
    const found = Object.values(TARGETS).find((t) => t.machine === machine);
    throw new Error(
      `the ZIP is named ${architecture} but holds a ${found ? found.machineName : `0x${machine.toString(16)}`} binary`,
    );
  }
  return `${architecture} (PE machine 0x${machine.toString(16)})`;
});

check("the executable is the portable build, with no updater linked", () => {
  const exe = entries.find((e) => e.name === EXE_NAME);
  const markers = updaterMarkersIn(exe.contents);
  if (markers.length > 0) {
    throw new Error(`it contains updater strings (${markers.join(", ")})`);
  }
  return "no updater strings present";
});

check("the README is filled in and says what portable means", () => {
  const readme = entries.find((e) => e.name === "README-PORTABLE.txt");
  if (!readme) throw new Error("README-PORTABLE.txt is missing");
  const text = readme.contents.toString("utf8");
  const leftover = text.match(/__[A-Z]+__/);
  if (leftover) throw new Error(`an unfilled placeholder remains: ${leftover[0]}`);
  if (version && !text.includes(version)) {
    throw new Error(`it does not mention version ${version}`);
  }
  if (!text.includes(architecture)) throw new Error(`it does not mention ${architecture}`);
  for (const promise of ["never updates itself", "read-only share", "WebView2"]) {
    if (!text.includes(promise)) throw new Error(`it does not mention "${promise}"`);
  }
  return `${text.split("\n").length} lines`;
});

check("nothing that belongs to the installer came along", () => {
  // The mistakes this catches: an NSIS setup, an updater manifest or its
  // signature, or debug symbols, swept up by a wildcard copy.
  const forbidden = /\.(msi|exe\.sig|sig|pdb|nsis\.zip)$|^latest\.json$/i;
  const extra = entries.map((e) => e.name).filter((n) => n !== EXE_NAME && forbidden.test(n));
  if (extra.length > 0) throw new Error(`the archive contains ${extra.join(", ")}`);
  return "installer artifacts absent";
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nThe portable ZIP is what it claims to be.");

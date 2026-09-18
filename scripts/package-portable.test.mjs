// The packaging rules get tests, because they decide what actually ships and
// "the ZIP held the wrong architecture" is not something to learn from a bug
// report.

import { describe, expect, it } from "vitest";
import {
  EXE_NAME,
  EXPECTED_PAYLOAD,
  TARGETS,
  UPDATER_MARKERS,
  assetName,
  peMachine,
  renderReadme,
  updaterMarkersIn,
} from "./package-portable.mjs";

/** A minimal but structurally valid PE header for a given machine type. */
function fakePe(machine) {
  const buffer = Buffer.alloc(0x100);
  buffer.writeUInt16LE(0x5a4d, 0); // "MZ"
  buffer.writeUInt32LE(0x80, 0x3c); // PE header offset
  buffer.writeUInt32LE(0x00004550, 0x80); // "PE\0\0"
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

describe("asset names", () => {
  it("are what the website's download rules look for", () => {
    expect(assetName("1.0.0", "x86_64-pc-windows-msvc")).toBe(
      "EXP-IP-Scanner_1.0.0_windows-x64-portable.zip",
    );
    expect(assetName("1.2.3", "aarch64-pc-windows-msvc")).toBe(
      "EXP-IP-Scanner_1.2.3_windows-arm64-portable.zip",
    );
  });

  it("refuse a target that has no portable build", () => {
    expect(() => assetName("1.0.0", "x86_64-apple-darwin")).toThrow(/unsupported target/);
  });
});

describe("the PE header check", () => {
  it("reads the architecture out of the file rather than trusting the path", () => {
    expect(peMachine(fakePe(0x8664))).toBe(TARGETS["x86_64-pc-windows-msvc"].machine);
    expect(peMachine(fakePe(0xaa64))).toBe(TARGETS["aarch64-pc-windows-msvc"].machine);
  });

  it("refuses something that is not a Windows executable at all", () => {
    // A Linux ELF binary, which is what a target-directory mix-up produces.
    const elf = Buffer.from("\x7fELF" + "\0".repeat(200), "latin1");
    expect(() => peMachine(elf)).toThrow(/no MZ signature/);

    const truncated = Buffer.alloc(8);
    truncated.writeUInt16LE(0x5a4d, 0);
    expect(() => peMachine(truncated)).toThrow(/no MZ signature/);

    // MZ present but the PE header missing: a DOS stub, or a corrupt download.
    const dosOnly = Buffer.alloc(0x100);
    dosOnly.writeUInt16LE(0x5a4d, 0);
    dosOnly.writeUInt32LE(0x80, 0x3c);
    expect(() => peMachine(dosOnly)).toThrow(/no PE signature/);
  });

  it("names what it was looking at, so a failure says which file", () => {
    expect(() => peMachine(Buffer.alloc(4), "target/release/app.exe")).toThrow(
      /target\/release\/app\.exe/,
    );
  });
});

describe("the installed-build check", () => {
  it("spots every updater marker", () => {
    for (const marker of UPDATER_MARKERS) {
      const binary = Buffer.from(`some bytes ${marker} more bytes`, "latin1");
      expect(updaterMarkersIn(binary)).toContain(marker);
    }
  });

  it("passes a binary with none of them", () => {
    const portable = Buffer.from(
      "EXP IP Scanner portable build, scanner, netinfo, oui_data",
      "latin1",
    );
    expect(updaterMarkersIn(portable)).toEqual([]);
  });

  it("does not test for the updater endpoint, which every build embeds", () => {
    // `tauri::generate_context!` embeds the whole of tauri.conf.json, so the
    // feed URL is in the portable binary too. Testing for it would reject
    // every portable build, which is the trap this check exists to avoid.
    const portable = Buffer.from(
      "https://github.com/kingnazz/EXP-IP-Scanner/releases/latest/download/latest.json",
      "latin1",
    );
    expect(updaterMarkersIn(portable)).toEqual([]);
  });
});

describe("the payload", () => {
  it("is the executable and the README, and nothing else", () => {
    expect(EXPECTED_PAYLOAD).toEqual([EXE_NAME, "README-PORTABLE.txt"]);
    expect(EXE_NAME).toBe("EXP IP Scanner.exe");
  });
});

describe("the README", () => {
  it("is filled in for the build it ships with", () => {
    const rendered = renderReadme(
      "EXP IP Scanner __VERSION__ for __ARCH__\nRequires Windows 10, __ARCH__.",
      "1.0.0",
      "x64",
    );
    expect(rendered).toBe("EXP IP Scanner 1.0.0 for x64\nRequires Windows 10, x64.");
    expect(rendered).not.toContain("__");
  });

  it("leaves no placeholder behind in the real file", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const template = readFileSync(join(root, "packaging", "README-PORTABLE.txt"), "utf8");
    const rendered = renderReadme(template, "1.0.0", "x64");
    expect(rendered).not.toMatch(/__[A-Z]+__/);
    // And it says the things a portable user needs to know.
    expect(rendered).toContain("never updates itself");
    expect(rendered).toContain("read-only share");
    expect(rendered).toContain("WebView2");
  });
});

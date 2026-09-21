import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadColumnWidths,
  loadRecentTargets,
  loadSettings,
  pushRecentTarget,
  saveColumnWidths,
  saveSettings,
} from "./prefs";

const SETTINGS_KEY = "exp-ip-scanner-settings";
const THEME_KEY = "exp-ip-scanner-theme";
const COLUMN_KEY = "exp-ip-scanner-columns";
const RECENTS_KEY = "exp-ip-scanner-recent-targets";

beforeEach(() => {
  localStorage.clear();
});

describe("settings round-trip", () => {
  it("reads back exactly what was saved", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      theme: "dark" as const,
      density: "comfortable" as const,
      timeoutMs: 1_500,
      hostConcurrency: 128,
      tcpConcurrency: 512,
      pingConcurrency: 16,
      portSpec: "22, 80, 443",
      resolveHostnames: false,
      scanServices: false,
      hiddenColumns: ["mac" as const, "os" as const],
      sortKey: "latency" as const,
      sortDir: "desc" as const,
      preferredInterface: "Ethernet 3",
    };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
  });

  it("mirrors the theme for the pre-paint script", () => {
    // public/theme-init.js reads this key before the bundle loads, which is
    // what stops the window flashing the wrong theme.
    saveSettings({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("returns the defaults when nothing has been saved", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("settings are read defensively", () => {
  it("survives a blob that is not even JSON", () => {
    localStorage.setItem(SETTINGS_KEY, "{{{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("survives a blob of the wrong shape", () => {
    for (const bad of ["null", '"a string"', "[1,2,3]", "42"]) {
      localStorage.setItem(SETTINGS_KEY, bad);
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("falls back per field, keeping the valid parts of a partly bad blob", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ theme: "neon", density: "comfortable", timeoutMs: "soon" }),
    );
    const settings = loadSettings();
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(settings.timeoutMs).toBe(DEFAULT_SETTINGS.timeoutMs);
    // The one valid field is kept.
    expect(settings.density).toBe("comfortable");
  });

  it("clamps numbers into the ranges the backend will accept", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        timeoutMs: 10_000_000,
        hostConcurrency: 0,
        tcpConcurrency: -5,
        pingConcurrency: 99_999,
      }),
    );
    const settings = loadSettings();
    // These are the scanner's own clamps, so a value the interface shows is
    // never silently changed underneath it.
    expect(settings.timeoutMs).toBe(10_000);
    expect(settings.hostConcurrency).toBe(1);
    expect(settings.tcpConcurrency).toBe(8);
    expect(settings.pingConcurrency).toBe(128);
  });

  it("discards a column name a newer build invented", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ hiddenColumns: ["mac", "not-a-column", 7, null] }),
    );
    expect(loadSettings().hiddenColumns).toEqual(["mac"]);
  });

  it("never lets the status column be hidden", () => {
    // It is a required column; a stored preference asking for it gone would
    // otherwise leave rows with no liveness indicator at all.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ hiddenColumns: ["status", "mac"] }));
    expect(loadSettings().hiddenColumns).toEqual(["mac"]);
  });

  it("treats a missing boolean as on, so an older blob picks up the default", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: "light" }));
    const settings = loadSettings();
    expect(settings.resolveHostnames).toBe(true);
    expect(settings.scanServices).toBe(true);
  });

  it("keeps a deliberate opt-out", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ resolveHostnames: false }));
    expect(loadSettings().resolveHostnames).toBe(false);
  });

  it("ignores a blank preferred adapter", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ preferredInterface: "   " }));
    expect(loadSettings().preferredInterface).toBeNull();
  });

  it("carries on when storage refuses to be written", () => {
    // A full or blocked store must never stop the application working.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    setItem.mockRestore();
  });

  it("carries on when storage refuses to be read", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    getItem.mockRestore();
  });
});

describe("column widths", () => {
  it("round-trip", () => {
    saveColumnWidths({ ip: 150, hostname: 220 });
    expect(loadColumnWidths()).toEqual({ ip: 150, hostname: 220 });
  });

  it("discards a width nobody could have dragged", () => {
    localStorage.setItem(
      COLUMN_KEY,
      JSON.stringify({ ip: 4_000, hostname: -10, mac: 0, vendor: "wide", latency: 90 }),
    );
    // Only the plausible one survives; every other column falls back to its
    // own default rather than to a clamped value nobody chose.
    expect(loadColumnWidths()).toEqual({ latency: 90 });
  });

  it("ignores a column name it does not know", () => {
    localStorage.setItem(COLUMN_KEY, JSON.stringify({ invented: 120, ip: 140 }));
    expect(loadColumnWidths()).toEqual({ ip: 140 });
  });

  it("returns nothing for a corrupt blob", () => {
    localStorage.setItem(COLUMN_KEY, "[]");
    expect(loadColumnWidths()).toEqual({});
    localStorage.setItem(COLUMN_KEY, "nope");
    expect(loadColumnWidths()).toEqual({});
  });
});

describe("recent targets", () => {
  it("keeps the newest first without repeating one", () => {
    pushRecentTarget("192.168.1.0/24");
    pushRecentTarget("10.0.0.0/24");
    pushRecentTarget("192.168.1.0/24");
    expect(loadRecentTargets()).toEqual(["192.168.1.0/24", "10.0.0.0/24"]);
  });

  it("caps the list so the menu stays short", () => {
    for (let n = 1; n <= 12; n++) pushRecentTarget(`10.0.${n}.0/24`);
    expect(loadRecentTargets()).toHaveLength(6);
    expect(loadRecentTargets()[0]).toBe("10.0.12.0/24");
  });

  it("ignores an empty target", () => {
    pushRecentTarget("   ");
    expect(loadRecentTargets()).toEqual([]);
  });

  it("drops anything in the stored list that is not a target", () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(["10.0.0.0/24", 7, null, ""]));
    expect(loadRecentTargets()).toEqual(["10.0.0.0/24"]);
  });
});

describe("the defaults themselves", () => {
  it("match the scanner's own defaults, so Settings shows the truth", () => {
    expect(DEFAULT_SETTINGS.timeoutMs).toBe(900);
    expect(DEFAULT_SETTINGS.hostConcurrency).toBe(64);
    expect(DEFAULT_SETTINGS.tcpConcurrency).toBe(256);
    expect(DEFAULT_SETTINGS.pingConcurrency).toBe(32);
  });

  it("follow the operating system's theme, and scan everything useful", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("system");
    expect(DEFAULT_SETTINGS.resolveHostnames).toBe(true);
    expect(DEFAULT_SETTINGS.scanServices).toBe(true);
    // Empty means the backend's default consultant port set.
    expect(DEFAULT_SETTINGS.portSpec).toBe("");
  });
});

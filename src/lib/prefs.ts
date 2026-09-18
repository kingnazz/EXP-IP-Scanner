// Preferences.
//
// Persisted in the WebView profile with no backend involvement. Deliberately
// small: theme, table layout and scan tuning. Nothing about a customer's
// network is stored, because the same copy of this tool is pointed at many
// unrelated sites and one site's device list has no business surviving into
// the next.
//
// Every read is defensive. A preferences blob written by a newer build, or
// corrupted on disk, must never stop the application from starting.

import { DEFAULT_HIDDEN_COLUMNS, type ColumnKey, type SortDir } from "./table";

const SETTINGS_KEY = "exp-ip-scanner-settings";
const THEME_KEY = "exp-ip-scanner-theme";
const COLUMN_WIDTH_KEY = "exp-ip-scanner-columns";
const RECENT_TARGETS_KEY = "exp-ip-scanner-recent-targets";

const MAX_RECENT_TARGETS = 6;

export type ThemePref = "light" | "dark" | "system";
export type Density = "compact" | "comfortable";

export interface Settings {
  theme: ThemePref;
  density: Density;
  /** Per-probe timeout in milliseconds. */
  timeoutMs: number;
  /** Addresses worked on at once. */
  hostConcurrency: number;
  /** TCP connection attempts in flight across the whole scan. */
  tcpConcurrency: number;
  /** `ping` processes running at once. */
  pingConcurrency: number;
  /**
   * The port list, as typed. Empty means the backend's default technician set,
   * which is what most people should be using.
   */
  portSpec: string;
  resolveHostnames: boolean;
  scanServices: boolean;
  /**
   * Whether the network summary looks up this network's public IP address.
   *
   * On by default, because it is one of the first things a technician wants
   * from a site and the lookup sends no scan results or discovered-device data.
   * It is a setting because it is the
   * only request the application makes on its own, and somebody working on an
   * isolated network is entitled to switch it off.
   */
  lookupPublicIp: boolean;
  hiddenColumns: ColumnKey[];
  sortKey: ColumnKey;
  sortDir: SortDir;
  /** The adapter name the technician last chose, if they chose one. */
  preferredInterface: string | null;
}

/**
 * The defaults.
 *
 * Chosen so that most technicians never open Settings at all. The concurrency
 * numbers are the scanner's own defaults, which are conservative on purpose:
 * small-business network gear drops ARP replies under heavy fan-out, and a
 * gentler sweep finds more devices in one pass.
 */
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  density: "compact",
  timeoutMs: 900,
  hostConcurrency: 64,
  tcpConcurrency: 256,
  pingConcurrency: 32,
  portSpec: "",
  resolveHostnames: true,
  scanServices: true,
  lookupPublicIp: true,
  hiddenColumns: DEFAULT_HIDDEN_COLUMNS,
  sortKey: "ip",
  sortDir: "asc",
  preferredInterface: null,
};

const COLUMN_KEYS: ColumnKey[] = [
  "status",
  "ip",
  "hostname",
  "mac",
  "vendor",
  "latency",
  "ports",
  "os",
];

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable. Preferences are a convenience, so the app
    // carries on with whatever is in memory for this session.
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Read the settings, filling in anything missing or invalid from the defaults. */
export function loadSettings(): Settings {
  const raw = readJson(SETTINGS_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const stored = raw as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;

  return {
    theme: oneOf(stored.theme, ["light", "dark", "system"] as const, d.theme),
    density: oneOf(stored.density, ["compact", "comfortable"] as const, d.density),
    // The bounds match the scanner's own clamps, so a value the interface
    // accepts is never silently changed by the backend.
    timeoutMs: clampNumber(stored.timeoutMs, 50, 10_000, d.timeoutMs),
    hostConcurrency: clampNumber(stored.hostConcurrency, 1, 512, d.hostConcurrency),
    tcpConcurrency: clampNumber(stored.tcpConcurrency, 8, 1_024, d.tcpConcurrency),
    pingConcurrency: clampNumber(stored.pingConcurrency, 1, 128, d.pingConcurrency),
    portSpec: typeof stored.portSpec === "string" ? stored.portSpec : d.portSpec,
    resolveHostnames: stored.resolveHostnames !== false,
    scanServices: stored.scanServices !== false,
    lookupPublicIp: stored.lookupPublicIp !== false,
    hiddenColumns: Array.isArray(stored.hiddenColumns)
      ? (stored.hiddenColumns.filter(
          (c): c is ColumnKey => COLUMN_KEYS.includes(c as ColumnKey) && c !== "status",
        ) as ColumnKey[])
      : d.hiddenColumns,
    sortKey: oneOf(stored.sortKey, COLUMN_KEYS, d.sortKey),
    sortDir: oneOf(stored.sortDir, ["asc", "desc"] as const, d.sortDir),
    preferredInterface:
      typeof stored.preferredInterface === "string" && stored.preferredInterface.trim()
        ? stored.preferredInterface
        : d.preferredInterface,
  };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
  // Mirrored for public/theme-init.js, which runs before the bundle loads and
  // applies the theme before first paint.
  try {
    localStorage.setItem(THEME_KEY, settings.theme);
  } catch {
    // The theme still applies for this session.
  }
}

// --- Column widths ---------------------------------------------------------

export type ColumnWidths = Partial<Record<ColumnKey, number>>;

/**
 * The range a width could have come from.
 *
 * A drag is bounded by the column's own minimum and by the window, so a stored
 * width outside this never came from a technician resizing anything. Such a
 * value is discarded rather than clamped: falling back to the column's default
 * is right, while clamping a stored 4,000 to 900 -- or a stored 0 to 30 --
 * would render a column nobody chose and then have to be found and dragged
 * back.
 */
const MIN_COLUMN_WIDTH = 30;
const MAX_COLUMN_WIDTH = 900;

export function loadColumnWidths(): ColumnWidths {
  const raw = readJson(COLUMN_WIDTH_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ColumnWidths = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!COLUMN_KEYS.includes(key as ColumnKey)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const width = Math.round(value);
    if (width < MIN_COLUMN_WIDTH || width > MAX_COLUMN_WIDTH) continue;
    out[key as ColumnKey] = width;
  }
  return out;
}

export function saveColumnWidths(widths: ColumnWidths): void {
  writeJson(COLUMN_WIDTH_KEY, widths);
}

// --- Recent targets --------------------------------------------------------

export function loadRecentTargets(): string[] {
  const raw = readJson(RECENT_TARGETS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .slice(0, MAX_RECENT_TARGETS);
}

/** Record a target as most recent, de-duplicated and capped. */
export function pushRecentTarget(target: string): string[] {
  const t = target.trim();
  if (!t) return loadRecentTargets();
  const list = [t, ...loadRecentTargets().filter((r) => r !== t)].slice(0, MAX_RECENT_TARGETS);
  writeJson(RECENT_TARGETS_KEY, list);
  return list;
}

// Column definitions, sorting, filtering and search for the results table.
//
// Pure, so the behaviour that matters most -- addresses in numeric order, a
// stable row order while results stream in, and a search that matches what the
// consultant can actually see -- is testable without rendering anything.

import { ipToNum, portWithService, serviceLabel } from "./format";
import { hasServices, isResponding, rowName, type DeviceRow } from "./live";

export type ColumnKey =
  | "status"
  | "ip"
  | "hostname"
  | "mac"
  | "vendor"
  | "latency"
  | "ports"
  | "os";

export type SortDir = "asc" | "desc";

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** Starting width in pixels, before the consultant resizes anything. */
  width: number;
  minWidth: number;
  align?: "right";
  /** Columns that take the remaining space rather than a fixed width. */
  flexible?: boolean;
  /** Never hidden: without these a row means nothing. */
  required?: boolean;
  /** Off by default, available from the column menu. */
  optionalByDefault?: boolean;
  /** Shown in the header tooltip, for a column whose meaning is not obvious. */
  hint?: string;
}

/**
 * Column order.
 *
 * Status, address and hostname first, because that is the order a consultant
 * reads a row in: is it alive, where is it, what is it called. Open ports last
 * and flexible, because it is the widest and most variable value and benefits
 * from whatever space is left.
 */
export const COLUMNS: ColumnDef[] = [
  { key: "status", label: "", width: 30, minWidth: 30, required: true },
  { key: "ip", label: "IP address", width: 124, minWidth: 104, required: true },
  { key: "hostname", label: "Hostname", width: 180, minWidth: 110, required: true },
  { key: "mac", label: "MAC address", width: 142, minWidth: 120 },
  { key: "vendor", label: "Manufacturer", width: 136, minWidth: 96 },
  { key: "latency", label: "Latency", width: 82, minWidth: 68, align: "right" },
  {
    key: "os",
    label: "Device type",
    width: 132,
    minWidth: 100,
    optionalByDefault: true,
    hint: "A guess from the reply TTL, not a reliable identification",
  },
  // Flexible and last, so the widest and most variable value gets whatever
  // room is left on a wide window and keeps a usable minimum on a narrow one.
  { key: "ports", label: "Open ports", width: 300, minWidth: 140, flexible: true },
];

export const COLUMN_BY_KEY: Record<ColumnKey, ColumnDef> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c]),
) as Record<ColumnKey, ColumnDef>;

/** Columns the consultant may switch off. */
export const TOGGLEABLE_COLUMNS = COLUMNS.filter((c) => !c.required);

/** Columns hidden until the consultant asks for them. */
export const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = COLUMNS.filter(
  (c) => c.optionalByDefault,
).map((c) => c.key);

/** Which columns to render: everything required, plus what is switched on. */
export function visibleColumns(hidden: readonly ColumnKey[]): ColumnDef[] {
  return COLUMNS.filter((c) => c.required || !hidden.includes(c.key));
}

export type FilterMode = "all" | "responding" | "services";

export const FILTER_MODES: { id: FilterMode; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every device found" },
  {
    id: "responding",
    label: "Responding",
    hint: "Devices that answered a ping or a TCP probe",
  },
  { id: "services", label: "Has services", hint: "Devices with at least one open port" },
];

/** Everything a search query is matched against, lowercased. */
export function searchHaystack(row: DeviceRow): string {
  const { host } = row;
  return [
    host.ip,
    host.hostname ?? "",
    host.mac ?? "",
    host.vendor ?? "",
    host.os_hint ?? "",
    // Both forms, so "445" and "smb" both find the same device.
    host.open_ports.join(" "),
    host.open_ports.map(serviceLabel).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Filter rows by mode and query.
 *
 * Every whitespace-separated term has to match, so "printer 9100" narrows
 * rather than widens. There is no query language and deliberately so: a
 * consultant should be able to type what they remember.
 */
export function filterRows(
  rows: readonly DeviceRow[],
  mode: FilterMode,
  query: string,
): DeviceRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (mode === "responding" && !isResponding(row)) return false;
    if (mode === "services" && !hasServices(row)) return false;
    if (terms.length === 0) return true;
    const hay = searchHaystack(row);
    return terms.every((term) => hay.includes(term));
  });
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  const left = a?.trim() ?? "";
  const right = b?.trim() ?? "";
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

/**
 * Whether this column has no value for this device.
 *
 * Absence is not a value. A device with no hostname, no MAC or no latency is
 * missing that fact, and sorting it to the top of a reversed column would put
 * the least informative rows where the most informative ones should be. So
 * these are held out of the direction entirely, below.
 */
function isMissing(row: DeviceRow, key: ColumnKey): boolean {
  switch (key) {
    case "hostname":
      return !row.host.hostname?.trim();
    case "mac":
      return !row.host.mac?.trim();
    case "vendor":
      return !row.host.vendor?.trim();
    case "os":
      return !row.host.os_hint?.trim();
    case "latency":
      return row.host.latency_ms == null;
    // An address, a status and a port count are always known.
    case "status":
    case "ip":
    case "ports":
      return false;
  }
}

/** Rank for the status column: devices worth a second look sort first. */
function statusRank(row: DeviceRow): number {
  if (row.host.is_self) return 0;
  if (isResponding(row) && hasServices(row)) return 1;
  if (isResponding(row)) return 2;
  return 3;
}

function compareBy(a: DeviceRow, b: DeviceRow, key: ColumnKey): number {
  switch (key) {
    case "status":
      return statusRank(a) - statusRank(b);
    case "ip":
      return ipToNum(a.host.ip) - ipToNum(b.host.ip);
    case "hostname":
      return compareText(a.host.hostname, b.host.hostname);
    case "mac":
      return compareText(a.host.mac, b.host.mac);
    case "vendor":
      return compareText(a.host.vendor, b.host.vendor);
    case "os":
      return compareText(a.host.os_hint, b.host.os_hint);
    case "ports":
      return a.host.open_ports.length - b.host.open_ports.length;
    case "latency":
      // Both are present here: `isMissing` holds a device that answered
      // nothing out of the ordering entirely, so it cannot pretend to be the
      // fastest thing on the network when the column is reversed.
      return (a.host.latency_ms ?? 0) - (b.host.latency_ms ?? 0);
  }
}

/**
 * Sort rows.
 *
 * Two rules beyond the obvious one. Devices missing the value being sorted on
 * go to the end whichever direction is chosen, so reversing a column never
 * fills the top of the table with blanks. And the address is the tiebreak for
 * every column, so rows with equal values keep a stable order while a scan
 * streams new ones in -- a table that reshuffles under the pointer is
 * unusable.
 */
export function sortRows(
  rows: readonly DeviceRow[],
  key: ColumnKey,
  dir: SortDir,
): DeviceRow[] {
  const factor = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const aMissing = isMissing(a, key);
    const bMissing = isMissing(b, key);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (!aMissing) {
      const primary = compareBy(a, b, key);
      if (primary !== 0) return primary * factor;
    }
    const byAddress = ipToNum(a.host.ip) - ipToNum(b.host.ip);
    return key === "ip" ? byAddress * factor : byAddress;
  });
}

/** Filter then sort, in the order the table renders them. */
export function prepareRows(
  rows: readonly DeviceRow[],
  mode: FilterMode,
  query: string,
  sortKey: ColumnKey,
  sortDir: SortDir,
): DeviceRow[] {
  return sortRows(filterRows(rows, mode, query), sortKey, sortDir);
}

/** The text of one cell, used by the table, the export and Copy cell. */
export function cellText(row: DeviceRow, key: ColumnKey): string {
  const { host } = row;
  switch (key) {
    case "status":
      return host.is_self ? "This computer" : isResponding(row) ? "Responding" : "Quiet";
    case "ip":
      return host.ip;
    case "hostname":
      return host.hostname ?? "";
    case "mac":
      return host.mac ?? "";
    case "vendor":
      return host.vendor ?? "";
    case "latency":
      return host.latency_ms == null ? "" : String(host.latency_ms);
    case "os":
      return host.os_hint ?? "";
    case "ports":
      return host.open_ports.map(portWithService).join(", ");
  }
}

/** The name to show for a device, re-exported so the table has one import. */
export { rowName };

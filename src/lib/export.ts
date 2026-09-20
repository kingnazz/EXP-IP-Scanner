// CSV export and clipboard output.
//
// Two formats, for two different jobs. CSV is a file that has to open cleanly
// in Excel. The clipboard form is tab-separated, because that is what pastes
// into a ticket, a spreadsheet, a Teams message or an email as a table rather
// than as one run-together line.
//
// Deliberately not a report generator. A technician wants the rows they are
// looking at, in something they can paste.

import type { LocalNetwork } from "../types";
import { portWithService } from "./format";
import type { DeviceRow } from "./live";
import { cellText } from "./table";

/** What one device contributes to an export, in column order. */
const COLUMNS: { header: string; value: (row: DeviceRow) => string }[] = [
  { header: "IP Address", value: (r) => r.host.ip },
  { header: "Hostname", value: (r) => r.host.hostname ?? "" },
  { header: "MAC Address", value: (r) => r.host.mac ?? "" },
  { header: "Manufacturer", value: (r) => r.host.vendor ?? "" },
  {
    header: "Latency (ms)",
    value: (r) => (r.host.latency_ms == null ? "" : r.host.latency_ms.toFixed(2)),
  },
  { header: "Open Ports", value: (r) => r.host.open_ports.join(" ") },
  { header: "Services", value: (r) => r.host.open_ports.map(portWithService).join("; ") },
  { header: "Device Type Guess", value: (r) => r.host.os_hint ?? "" },
  { header: "Status", value: (r) => cellText(r, "status") },
];

export interface ExportContext {
  /** The target that was scanned, recorded in every row. */
  target: string;
  /** When the scan finished, as an ISO timestamp. */
  scannedAt: string;
}

const CONTEXT_COLUMNS: { header: string; value: (ctx: ExportContext) => string }[] = [
  { header: "Scan Target", value: (c) => c.target },
  { header: "Scan Time", value: (c) => c.scannedAt },
];

function csvField(value: string): string {
  // A leading =, +, - or @ is how a CSV becomes a formula when Excel opens it.
  // Nothing in a scan result should ever be evaluated, so those are quoted and
  // prefixed. A hostname is attacker-influenced data on an untrusted network.
  const risky = /^[=+\-@\t\r]/.test(value);
  const text = risky ? `'${value}` : value;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Build the CSV.
 *
 * Prefixed with a UTF-8 byte-order mark, because Excel on Windows otherwise
 * reads a UTF-8 file as the local code page and mangles any manufacturer name
 * with an accent in it.
 */
export function buildCsv(rows: readonly DeviceRow[], ctx: ExportContext): string {
  const headers = [...COLUMNS.map((c) => c.header), ...CONTEXT_COLUMNS.map((c) => c.header)];
  const lines = rows.map((row) =>
    [...COLUMNS.map((c) => c.value(row)), ...CONTEXT_COLUMNS.map((c) => c.value(ctx))]
      .map(csvField)
      .join(","),
  );
  // CRLF line endings, which is what Excel and every Windows tool expects.
  return `﻿${[headers.join(","), ...lines].join("\r\n")}\r\n`;
}

/**
 * Build the clipboard form: a tab-separated table with a header row.
 *
 * No scan-context columns here. A paste into a ticket wants the devices, and
 * the person pasting already knows which network they scanned.
 */
export function buildClipboardTable(rows: readonly DeviceRow[]): string {
  const cell = (value: string) => value.replace(/[\t\r\n]+/g, " ").trim();
  const headers = COLUMNS.map((c) => c.header).join("\t");
  const lines = rows.map((row) => COLUMNS.map((c) => cell(c.value(row))).join("\t"));
  return [headers, ...lines].join("\n");
}

/** IP addresses only, one per line, for scripts, tickets and network tools. */
export function buildIpList(rows: readonly DeviceRow[]): string {
  return rows.map((row) => row.host.ip).join("\n");
}

export interface NetworkSummaryContext {
  network: LocalNetwork | null;
  target: string;
  addressCount: number | null;
  /** Human-readable public IP state, e.g. an address, Unavailable, or Off. */
  publicIp: string;
}

/** A compact network snapshot for pasting into a ticket or work note. */
export function buildNetworkSummary(ctx: NetworkSummaryContext): string {
  const range = ctx.target.trim() || "Not set";
  const rangeWithCount =
    ctx.addressCount == null
      ? range
      : `${range} (${ctx.addressCount} ${ctx.addressCount === 1 ? "address" : "addresses"})`;

  return [
    `Adapter      ${ctx.network?.interface ?? "Not detected"}`,
    `Local IP     ${ctx.network?.ip ?? "Unavailable"}`,
    `Gateway      ${ctx.network?.gateway ?? "None"}`,
    `Scan range   ${rangeWithCount}`,
    `Public IP    ${ctx.publicIp}`,
  ].join("\n");
}

/** One device as a readable block, for Copy all details. */
export function buildDeviceDetails(row: DeviceRow): string {
  const { host } = row;
  const lines: string[] = [`IP address    ${host.ip}`];
  if (host.hostname) lines.push(`Hostname      ${host.hostname}`);
  if (host.mac) lines.push(`MAC address   ${host.mac}`);
  if (host.vendor) lines.push(`Manufacturer  ${host.vendor}`);
  if (host.latency_ms != null) lines.push(`Latency       ${host.latency_ms.toFixed(2)} ms`);
  if (host.ttl != null) lines.push(`TTL           ${host.ttl}`);
  if (host.os_hint) lines.push(`Device type   ${host.os_hint} (estimated)`);
  lines.push(
    host.open_ports.length > 0
      ? `Open ports    ${host.open_ports.map(portWithService).join(", ")}`
      : "Open ports    none found",
  );
  return lines.join("\n");
}

/** A filename that says what was scanned and when. */
export function csvFilename(target: string, now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");
  const slug =
    target
      .replace(/[^a-zA-Z0-9.-]+/g, "_")
      // A dot belongs in an address, but a run of them does not, and a default
      // filename that reads like a path traversal is worth not producing even
      // though the technician picks the real destination in the save dialog
      // and the backend validates it again.
      .replace(/\.{2,}/g, ".")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 40) || "scan";
  return `exp-ip-scanner-${slug}-${stamp}.csv`;
}

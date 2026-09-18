// Keeping the results table in step with a scan that is still running.
//
// The scanner reports a device as soon as it answers, then reports it again as
// its hostname, MAC and manufacturer resolve. Those updates arrive separately
// and can arrive out of order, so rows are merged field by field rather than
// replaced: a fact already known is never lost to a later event that does not
// carry it.

import type { HostResult } from "../types";

/** One row in the results table. */
export interface DeviceRow {
  host: HostResult;
  /**
   * True while enrichment is still expected for this device, which is what the
   * table uses to show a name or MAC cell as "resolving" rather than empty.
   */
  pending: boolean;
}

/** Drop an event that belongs to a scan the interface is no longer showing. */
export function isStaleEvent(eventScanId: number, activeScanId: number | null): boolean {
  return activeScanId == null || eventScanId !== activeScanId;
}

/**
 * Merge one device into the row set.
 *
 * A value that is present wins over one that is absent, in both directions:
 * the final update carries everything and settles the row, while an
 * intermediate update carrying only a hostname cannot erase a MAC that arrived
 * first. `open_ports` and the latencies are final from the moment a device is
 * discovered -- its probe is complete by then -- so a later event only ever
 * confirms them.
 */
export function upsertHost(rows: DeviceRow[], host: HostResult, pending: boolean): DeviceRow[] {
  const index = rows.findIndex((row) => row.host.ip === host.ip);
  if (index === -1) {
    return [...rows, { host, pending }];
  }
  const existing = rows[index];
  if (!existing) return [...rows, { host, pending }];

  const merged: DeviceRow = {
    host: {
      ...existing.host,
      ...host,
      hostname: host.hostname ?? existing.host.hostname,
      mac: host.mac ?? existing.host.mac,
      vendor: host.vendor ?? existing.host.vendor,
      os_hint: host.os_hint ?? existing.host.os_hint,
      ttl: host.ttl ?? existing.host.ttl,
      icmp_ms: host.icmp_ms ?? existing.host.icmp_ms,
      tcp_ms: host.tcp_ms ?? existing.host.tcp_ms,
      latency_ms: host.latency_ms ?? existing.host.latency_ms,
      // A device's open ports only ever grow within one scan, and an empty
      // list in a later event means "not re-measured", not "nothing open".
      open_ports: host.open_ports.length > 0 ? host.open_ports : existing.host.open_ports,
    },
    // Once an update says a device is settled it stays settled: a second
    // event must not put the row back into a resolving state.
    pending: existing.pending && pending,
  };

  const next = rows.slice();
  next[index] = merged;
  return next;
}

/** Withdraw a device the scanner decided was not real after all. */
export function removeHostByIp(rows: DeviceRow[], ip: string): DeviceRow[] {
  const index = rows.findIndex((row) => row.host.ip === ip);
  if (index === -1) return rows;
  const next = rows.slice();
  next.splice(index, 1);
  return next;
}

/**
 * Mark every row settled.
 *
 * Called when a scan ends, so nothing is left looking half-resolved if an
 * update event was dropped under backpressure.
 */
export function settleRows(rows: DeviceRow[]): DeviceRow[] {
  if (rows.every((row) => !row.pending)) return rows;
  return rows.map((row) => (row.pending ? { ...row, pending: false } : row));
}

/** Build the row set from a finished scan result. */
export function rowsFromResult(hosts: HostResult[]): DeviceRow[] {
  return hosts.map((host) => ({ host, pending: false }));
}

/** The name to show for a device: its hostname, or its address. */
export function rowName(row: DeviceRow): string {
  const hostname = row.host.hostname?.trim();
  return hostname && hostname.length > 0 ? hostname : row.host.ip;
}

/**
 * Whether a device answered a probe, as opposed to only appearing in the ARP
 * cache.
 *
 * Both are real devices. The difference is worth showing: a device with no
 * latency ignored every probe, which is normal for a printer or a hardened
 * workstation and tells a technician why they cannot ping it.
 */
export function isResponding(row: DeviceRow): boolean {
  return row.host.latency_ms != null;
}

export function hasServices(row: DeviceRow): boolean {
  return row.host.open_ports.length > 0;
}

// Realistic mock devices, shared by the tests.
//
// Every one is a thing a technician actually meets on a customer network, and
// each exists because it exercises something different: a Windows server that
// answers everything, a printer that answers nothing but ARP, an access point
// with only a management page, a camera on an odd port, a NAS, a firewall, a
// workstation. Testing against a uniform set of "hosts with port 80 open"
// would pass while the awkward cases broke.

import type { HostResult, LocalNetwork } from "../types";
import type { DeviceRow } from "../lib/live";

export function host(overrides: Partial<HostResult> & { ip: string }): HostResult {
  return {
    hostname: null,
    mac: null,
    vendor: null,
    open_ports: [],
    icmp_ms: null,
    tcp_ms: null,
    latency_ms: null,
    ttl: null,
    os_hint: null,
    is_self: false,
    seen_at: "2026-09-18T09:30:00.000Z",
    ...overrides,
  };
}

export function row(overrides: Partial<HostResult> & { ip: string }, pending = false): DeviceRow {
  return { host: host(overrides), pending };
}

/** A domain controller: answers ICMP, and nearly every Windows service. */
export const WINDOWS_SERVER = host({
  ip: "192.168.50.10",
  hostname: "dc01.exp.local",
  mac: "00:15:5D:3A:91:22",
  vendor: "Microsoft",
  open_ports: [53, 135, 139, 389, 445, 3389, 5985],
  icmp_ms: 0.62,
  tcp_ms: 1.0,
  latency_ms: 0.62,
  ttl: 128,
  os_hint: "Windows",
});

/**
 * A printer that ignores every probe and is found only through ARP.
 *
 * The case a ping sweep misses entirely, and the reason the ARP pass exists.
 */
export const SILENT_PRINTER = host({
  ip: "192.168.50.26",
  mac: "00:00:AA:1D:42:07",
  vendor: "Xerox",
});

/** A network printer that does answer, on printing ports. */
export const PRINTER = host({
  ip: "192.168.50.27",
  hostname: "hp-mfp-reception.exp.local",
  mac: "94:57:A5:13:6B:02",
  vendor: "HP",
  open_ports: [80, 443, 515, 631, 9100],
  icmp_ms: 2.8,
  latency_ms: 2.8,
  ttl: 64,
  os_hint: "Linux / Unix / macOS",
});

/** An access point: SSH and a management page, nothing else. */
export const ACCESS_POINT = host({
  ip: "192.168.50.31",
  hostname: "ap-office-01.exp.local",
  mac: "F4:92:BF:0D:19:77",
  vendor: "Ubiquiti",
  open_ports: [22, 80, 443],
  icmp_ms: 1.9,
  latency_ms: 1.9,
  ttl: 64,
  os_hint: "Linux / Unix / macOS",
});

/** The gateway firewall, at the bottom of the range. */
export const FIREWALL = host({
  ip: "192.168.50.1",
  hostname: "fw-edge-01.exp.local",
  mac: "F4:92:BF:1C:44:0A",
  vendor: "Ubiquiti",
  open_ports: [22, 53, 80, 443],
  icmp_ms: 0.84,
  latency_ms: 0.84,
  ttl: 64,
  os_hint: "Linux / Unix / macOS",
});

/** An ordinary Windows workstation, with Remote Desktop enabled. */
export const WORKSTATION = host({
  ip: "192.168.50.9",
  hostname: "ws-reception.exp.local",
  mac: "8C:16:45:11:7B:30",
  vendor: "Lenovo",
  open_ports: [135, 139, 445, 3389],
  icmp_ms: 1.6,
  latency_ms: 1.6,
  ttl: 128,
  os_hint: "Windows",
});

/** A NAS: SSH, a web interface and file shares. */
export const NAS = host({
  ip: "192.168.50.100",
  hostname: "nas-backup.exp.local",
  mac: "00:11:32:6D:A1:55",
  vendor: "Synology",
  open_ports: [22, 80, 443, 445],
  icmp_ms: 1.4,
  latency_ms: 1.4,
  ttl: 64,
  os_hint: "Linux / Unix / macOS",
});

/** An IP camera with no hostname, answering on an unusual port. */
export const IP_CAMERA = host({
  ip: "192.168.50.51",
  mac: "BC:AD:28:5F:31:0B",
  vendor: "Hikvision",
  open_ports: [80, 554, 8000],
  icmp_ms: 5.1,
  latency_ms: 5.1,
  ttl: 64,
  os_hint: "Linux / Unix / macOS",
});

/** This machine. Always kept, and marked in the table. */
export const THIS_COMPUTER = host({
  ip: "192.168.50.37",
  hostname: "tech-laptop.exp.local",
  mac: "8C:16:45:9A:02:DE",
  vendor: "Lenovo",
  open_ports: [135, 139, 445],
  icmp_ms: 0.11,
  latency_ms: 0.11,
  ttl: 128,
  os_hint: "Windows",
  is_self: true,
});

/**
 * The devices in an order that is deliberately *not* correct, so a test that
 * forgets to sort fails.
 */
export const ALL_DEVICES: HostResult[] = [
  WINDOWS_SERVER,
  SILENT_PRINTER,
  PRINTER,
  ACCESS_POINT,
  FIREWALL,
  WORKSTATION,
  NAS,
  IP_CAMERA,
  THIS_COMPUTER,
];

export const ALL_ROWS: DeviceRow[] = ALL_DEVICES.map((h) => ({ host: h, pending: false }));

export const ETHERNET: LocalNetwork = {
  interface: "Ethernet",
  ip: "192.168.50.37",
  prefix: 24,
  cidr: "192.168.50.0/24",
  suggested_cidr: "192.168.50.0/24",
  suggested_hosts: 254,
  kind: "ethernet",
  kind_label: "Ethernet",
  is_private: true,
  recommended: true,
};

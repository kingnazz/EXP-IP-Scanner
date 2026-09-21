// The browser demo backend.
//
// The whole interface runs without Tauri against a fictional network, which is
// what makes it developable, testable and screenshotable in a browser with no
// Rust build and no real network access. The website's screenshots come from
// here, so they are always of the real interface rather than a mockup that
// drifts away from the product.
//
// Nothing in this file is reachable from the packaged application: `api.ts`
// only falls back to it when the Tauri bridge is absent. The networks are
// entirely invented, so no real customer, hostname, MAC address or serial
// number can end up in a published image.

import type {
  HostResult,
  LocalNetwork,
  PingOutcome,
  RuntimeInfo,
  ScanOptions,
  ScanPreview,
  ScanResult,
  ServiceInfo,
} from "../types";
import { APP_VERSION } from "../version";
import type { ScanListeners } from "./api";
import type { PublicIpResult } from "./publicip";

/** The interfaces a consultant's laptop plausibly has, in the order the real
 * adapter ranking would produce. */
const NETWORKS: LocalNetwork[] = [
  {
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
    gateway: "192.168.50.1",
  },
  {
    interface: "Wi-Fi",
    ip: "10.20.30.18",
    prefix: 24,
    cidr: "10.20.30.0/24",
    suggested_cidr: "10.20.30.0/24",
    suggested_hosts: 254,
    kind: "wireless",
    kind_label: "Wi-Fi",
    is_private: true,
    recommended: false,
    gateway: "10.20.30.1",
  },
  {
    interface: "Cisco AnyConnect VA",
    ip: "172.19.4.51",
    prefix: 22,
    cidr: "172.19.4.0/22",
    suggested_cidr: "172.19.4.0/22",
    suggested_hosts: 1022,
    kind: "vpn",
    kind_label: "VPN",
    is_private: true,
    recommended: false,
    gateway: "172.19.4.1",
  },
  {
    interface: "vEthernet (Default Switch)",
    ip: "172.26.32.1",
    prefix: 20,
    cidr: "172.26.32.0/20",
    suggested_cidr: "172.26.32.0/20",
    suggested_hosts: 4094,
    kind: "virtual",
    kind_label: "Virtual",
    is_private: true,
    recommended: false,
    // A Hyper-V switch really does have no default route, and the summary
    // says so rather than inventing one.
    gateway: null,
  },
];

/** One fictional device, positioned by its last octet. */
interface DemoDevice {
  octet: number;
  hostname: string | null;
  mac: string | null;
  vendor: string | null;
  ports: number[];
  /** Milliseconds, or null for a device that answers nothing but ARP. */
  latency: number | null;
  ttl: number | null;
  isSelf?: boolean;
}

/**
 * A plausible small-business network: a gateway, a domain controller, a file
 * server, printers, access points, cameras, phones, a NAS, a switch and a
 * spread of workstations -- including the awkward ones a consultant actually
 * has to deal with, like a printer that answers nothing but ARP.
 */
const DEVICES: DemoDevice[] = [
  {
    octet: 1,
    hostname: "fw-edge-01.exp.local",
    mac: "F4:92:BF:1C:44:0A",
    vendor: "Ubiquiti",
    ports: [22, 53, 80, 443],
    latency: 0.84,
    ttl: 64,
  },
  {
    octet: 2,
    hostname: "sw-core-01.exp.local",
    mac: "00:1B:21:7E:11:C3",
    vendor: "Intel",
    ports: [22, 80, 443],
    latency: 1.1,
    ttl: 255,
  },
  {
    octet: 10,
    hostname: "dc01.exp.local",
    mac: "00:15:5D:3A:91:22",
    vendor: "Microsoft",
    ports: [53, 135, 139, 389, 445, 3389, 5985],
    latency: 0.62,
    ttl: 128,
  },
  {
    octet: 11,
    hostname: "fs01.exp.local",
    mac: "B0:83:FE:22:7D:19",
    vendor: "Dell",
    ports: [135, 139, 445, 3389, 5985],
    latency: 0.71,
    ttl: 128,
  },
  {
    octet: 12,
    hostname: "sql01.exp.local",
    mac: "B0:83:FE:4A:08:61",
    vendor: "Dell",
    ports: [135, 445, 1433, 3389, 5985],
    latency: 0.68,
    ttl: 128,
  },
  {
    octet: 14,
    hostname: "app01.exp.local",
    mac: "00:50:56:9C:12:44",
    vendor: "VMware",
    ports: [22, 80, 443, 8080],
    latency: 0.93,
    ttl: 64,
  },
  {
    octet: 20,
    hostname: "nas-backup.exp.local",
    mac: "00:11:32:6D:A1:55",
    vendor: "Synology",
    ports: [22, 80, 443, 445, 5000],
    latency: 1.4,
    ttl: 64,
  },
  {
    octet: 25,
    hostname: null,
    mac: "00:80:77:41:C2:8E",
    vendor: "Brother",
    ports: [80, 515, 631, 9100],
    latency: 3.2,
    ttl: 64,
  },
  {
    // The printer that ignores every probe and is only found through ARP.
    // Exactly the device a ping sweep misses.
    octet: 26,
    hostname: null,
    mac: "00:00:AA:1D:42:07",
    vendor: "Xerox",
    ports: [],
    latency: null,
    ttl: null,
  },
  {
    octet: 27,
    hostname: "hp-mfp-reception.exp.local",
    mac: "94:57:A5:13:6B:02",
    vendor: "HP",
    ports: [80, 443, 515, 631, 9100],
    latency: 2.8,
    ttl: 64,
  },
  {
    octet: 31,
    hostname: "ap-office-01.exp.local",
    mac: "F4:92:BF:0D:19:77",
    vendor: "Ubiquiti",
    ports: [22, 80, 443],
    latency: 1.9,
    ttl: 64,
  },
  {
    octet: 32,
    hostname: "ap-office-02.exp.local",
    mac: "F4:92:BF:0D:19:A1",
    vendor: "Ubiquiti",
    ports: [22, 80, 443],
    latency: 2.2,
    ttl: 64,
  },
  {
    octet: 37,
    hostname: "tech-laptop.exp.local",
    mac: "8C:16:45:9A:02:DE",
    vendor: "Lenovo",
    ports: [135, 139, 445],
    latency: 0.11,
    ttl: 128,
    isSelf: true,
  },
  {
    octet: 41,
    hostname: "ws-reception.exp.local",
    mac: "8C:16:45:11:7B:30",
    vendor: "Lenovo",
    ports: [135, 139, 445, 3389],
    latency: 1.6,
    ttl: 128,
  },
  {
    octet: 42,
    hostname: "ws-accounts-01.exp.local",
    mac: "D8:9E:F3:44:1A:60",
    vendor: "Dell",
    ports: [135, 139, 445],
    latency: 1.8,
    ttl: 128,
  },
  {
    octet: 43,
    hostname: "ws-accounts-02.exp.local",
    mac: "D8:9E:F3:44:1A:61",
    vendor: "Dell",
    ports: [135, 139, 445, 3389],
    latency: 2.1,
    ttl: 128,
  },
  {
    octet: 44,
    hostname: null,
    mac: "3C:22:FB:71:04:9C",
    vendor: "Apple",
    ports: [22, 5900],
    latency: 4.6,
    ttl: 64,
  },
  {
    octet: 51,
    hostname: "cam-carpark.exp.local",
    mac: "BC:AD:28:5F:31:0B",
    vendor: "Hikvision",
    ports: [80, 554, 8000],
    latency: 5.1,
    ttl: 64,
  },
  {
    octet: 52,
    hostname: "cam-loading-bay.exp.local",
    mac: "BC:AD:28:5F:31:2D",
    vendor: "Hikvision",
    ports: [80, 554, 8000],
    latency: 5.8,
    ttl: 64,
  },
  {
    octet: 61,
    hostname: "phone-reception.exp.local",
    mac: "00:04:F2:8A:11:03",
    vendor: "Polycom",
    ports: [80, 443, 5060],
    latency: 3.4,
    ttl: 64,
  },
  {
    octet: 62,
    hostname: null,
    mac: "00:04:F2:8A:11:44",
    vendor: "Polycom",
    ports: [80, 5060],
    latency: 3.9,
    ttl: 64,
  },
  {
    octet: 70,
    hostname: "ups-comms-room.exp.local",
    mac: "00:C0:B7:2E:55:81",
    vendor: "American Power Conversion",
    ports: [80, 443],
    latency: 6.2,
    ttl: 64,
  },
  {
    octet: 88,
    hostname: null,
    mac: "B8:27:EB:4C:1F:90",
    vendor: "Raspberry Pi",
    ports: [22, 80],
    latency: 2.4,
    ttl: 64,
  },
  {
    octet: 120,
    hostname: "ws-warehouse-01.exp.local",
    mac: "8C:16:45:33:2C:14",
    vendor: "Lenovo",
    ports: [135, 445],
    latency: 8.7,
    ttl: 128,
  },
  {
    octet: 121,
    hostname: null,
    mac: "8C:16:45:33:2C:15",
    vendor: "Lenovo",
    ports: [135, 445],
    latency: 9.4,
    ttl: 128,
  },
  {
    octet: 200,
    hostname: "guest-portal.exp.local",
    mac: "F4:92:BF:77:12:C0",
    vendor: "Ubiquiti",
    ports: [80, 443, 8443],
    latency: 2.6,
    ttl: 64,
  },
];

// ---------------------------------------------------------------------------
// Demo-only target maths
//
// The real application asks the backend, which is the authority on what a
// target means. These few functions exist so the demo can size a scan in the
// browser, where there is no backend at all.
// ---------------------------------------------------------------------------

interface DemoTarget {
  /** The first three octets, when the target is a single subnet. */
  base: string | null;
  /** Last octets the target covers. */
  octets: number[];
  total: number;
}

function parseDemoTarget(target: string): DemoTarget | null {
  const text = target.trim();
  const cidr = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (cidr) {
    const prefix = Number(cidr[5]);
    if (prefix < 0 || prefix > 32) return null;
    const base = `${cidr[1]}.${cidr[2]}.${cidr[3]}`;
    const size = 2 ** (32 - prefix);
    const total = prefix >= 31 ? size : Math.max(size - 2, 0);
    if (prefix < 24) {
      // Wider than a /24: the demo still shows one subnet's worth of devices,
      // and only the address count grows.
      return { base, octets: range(1, 254), total };
    }
    const firstOctet = Number(cidr[4]) & (256 - size);
    const lo = prefix >= 31 ? firstOctet : firstOctet + 1;
    const hi = prefix >= 31 ? firstOctet + size - 1 : firstOctet + size - 2;
    return { base, octets: range(lo, hi), total };
  }

  const dashed = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*-\s*(\d{1,3})$/);
  if (dashed) {
    const lo = Number(dashed[4]);
    const hi = Number(dashed[5]);
    if (hi < lo) return null;
    return {
      base: `${dashed[1]}.${dashed[2]}.${dashed[3]}`,
      octets: range(lo, hi),
      total: hi - lo + 1,
    };
  }

  const single = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (single) {
    return {
      base: `${single[1]}.${single[2]}.${single[3]}`,
      octets: [Number(single[4])],
      total: 1,
    };
  }
  return null;
}

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let n = Math.max(lo, 0); n <= Math.min(hi, 255); n++) out.push(n);
  return out;
}

/** The devices the demo places inside a given target. */
function devicesForTarget(target: DemoTarget): { device: DemoDevice; ip: string }[] {
  if (!target.base) return [];
  const covered = new Set(target.octets);
  return DEVICES.filter((d) => covered.has(d.octet)).map((device) => ({
    device,
    ip: `${target.base}.${device.octet}`,
  }));
}

function hostFrom(device: DemoDevice, ip: string, enriched: boolean, ports: number[]): HostResult {
  const open = device.ports.filter((p) => ports.includes(p));
  return {
    ip,
    hostname: enriched ? device.hostname : null,
    mac: enriched ? device.mac : null,
    vendor: enriched ? device.vendor : null,
    open_ports: open,
    icmp_ms: device.latency,
    tcp_ms: open.length > 0 && device.latency != null ? device.latency + 0.4 : null,
    latency_ms: device.latency,
    ttl: device.ttl,
    os_hint: osHint(device.ttl),
    is_self: device.isSelf === true,
    seen_at: new Date().toISOString(),
  };
}

function osHint(ttl: number | null): string | null {
  if (ttl == null) return null;
  if (ttl > 128) return "Network device";
  if (ttl > 64) return "Windows";
  if (ttl > 32) return "Linux / Unix / macOS";
  return null;
}

/** The same set src-tauri/src/ports.rs probes, so the demo cannot show a
 * device answering on a port the real scanner never asks about. */
const DEFAULT_PORTS = [
  20, 21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 389, 443, 445, 515, 587, 631, 993, 995, 1433,
  1723, 3306, 3389, 5060, 5432, 5900, 5985, 5986, 8000, 8080, 8443, 9100,
];

const SERVICES: ServiceInfo[] = [
  { port: 20, name: "FTP" },
  { port: 21, name: "FTP" },
  { port: 22, name: "SSH" },
  { port: 23, name: "Telnet" },
  { port: 25, name: "SMTP" },
  { port: 53, name: "DNS" },
  { port: 80, name: "HTTP" },
  { port: 110, name: "POP3" },
  { port: 135, name: "MS RPC" },
  { port: 139, name: "NetBIOS" },
  { port: 143, name: "IMAP" },
  { port: 389, name: "LDAP" },
  { port: 443, name: "HTTPS" },
  { port: 445, name: "SMB" },
  { port: 515, name: "LPD" },
  { port: 554, name: "RTSP" },
  { port: 587, name: "SMTP" },
  { port: 631, name: "IPP" },
  { port: 993, name: "IMAPS" },
  { port: 995, name: "POP3S" },
  { port: 1433, name: "MSSQL" },
  { port: 1723, name: "PPTP" },
  { port: 3306, name: "MySQL" },
  { port: 3389, name: "RDP" },
  { port: 5000, name: "UPnP" },
  { port: 5060, name: "SIP" },
  { port: 5432, name: "PostgreSQL" },
  { port: 5900, name: "VNC" },
  { port: 5985, name: "WinRM" },
  { port: 5986, name: "WinRM TLS" },
  { port: 8000, name: "HTTP alt" },
  { port: 8080, name: "HTTP alt" },
  { port: 8443, name: "HTTPS alt" },
  { port: 9100, name: "Print" },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Cancellation, keyed the way the real backend keys it. */
let activeScan = 0;
let cancelledScan = 0;
let nextScanId = 1;

/**
 * How long a simulated scan takes.
 *
 * Long enough that the progressive streaming is visible, which is the
 * behaviour the demo exists to exercise, and short enough to be pleasant to
 * develop against.
 */
export const DEMO_SCAN_MS = 3_200;

let scanDurationMs = DEMO_SCAN_MS;

/**
 * Shorten a simulated scan.
 *
 * For the tests, which assert on the event sequence rather than on how long it
 * takes to arrive. Nothing in the application calls this.
 */
export function setDemoScanDuration(ms: number): void {
  scanDurationMs = Math.max(0, ms);
}

export const demo = {
  runtimeInfo(): RuntimeInfo {
    return {
      version: APP_VERSION,
      edition: "installed",
      edition_label: "Browser demo",
      platform: "Browser",
      architecture: "demo",
      update_mode: "manual",
    };
  },

  detectNetworks(): LocalNetwork[] {
    return NETWORKS.map((n) => ({ ...n }));
  },

  /**
   * The demo's public address.
   *
   * Fixed, and from the documentation range, so the screenshots and the
   * interface checks are deterministic and no real address is ever published.
   * The browser demo makes no outbound request of any kind.
   */
  async publicIp(): Promise<PublicIpResult | null> {
    await sleep(320);
    return { ip: "203.0.113.42", host: "api.ipify.org" };
  },

  serviceCatalog(): ServiceInfo[] {
    return SERVICES.map((s) => ({ ...s }));
  },

  defaultPorts(): number[] {
    return [...DEFAULT_PORTS];
  },

  parsePortSpec(spec: string): number[] {
    const text = spec.trim();
    if (!text) return [...DEFAULT_PORTS];
    const out = new Set<number>();
    for (const token of text.split(/[,;\s]+/).filter(Boolean)) {
      const r = token.match(/^(\d+)-(\d+)$/);
      if (r) {
        const lo = Math.min(Number(r[1]), Number(r[2]));
        const hi = Math.max(Number(r[1]), Number(r[2]));
        for (let p = lo; p <= hi; p++) out.add(p);
        continue;
      }
      const n = Number(token);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`\`${token}\` is not a port number.`);
      }
      out.add(n);
    }
    return [...out].sort((a, b) => a - b);
  },

  previewScan(opts: ScanOptions): ScanPreview {
    const target = parseDemoTarget(opts.target);
    if (!target) throw new Error(`\`${opts.target}\` is not a network this can scan.`);
    const portCount = opts.scan_services ? Math.max(opts.ports.length, DEFAULT_PORTS.length) : 5;
    const workload = target.total * portCount;
    return {
      total: target.total,
      port_count: portCount,
      workload,
      warning:
        workload > 250_000
          ? `Large scan: ${workload.toLocaleString()} connection attempts across ${target.total.toLocaleString()} addresses. This will take a while.`
          : null,
    };
  },

  cancelScan(): void {
    cancelledScan = activeScan;
  },

  async ping(ip: string): Promise<PingOutcome> {
    await sleep(240);
    const octet = Number(ip.split(".")[3] ?? "0");
    const device = DEVICES.find((d) => d.octet === octet);
    if (!device || device.latency == null) {
      return {
        ip,
        replied: false,
        rtt_ms: null,
        ttl: null,
        summary: `No reply from ${ip} within 1500 ms. The device may be off, or may be configured not to answer ping.`,
      };
    }
    return {
      ip,
      replied: true,
      rtt_ms: device.latency,
      ttl: device.ttl,
      summary: `Reply from ${ip} in ${device.latency.toFixed(2)} ms, TTL ${device.ttl}`,
    };
  },

  /**
   * Run a simulated scan, streaming the same events in the same order as the
   * real backend: discovered first, then enriched.
   */
  async scan(opts: ScanOptions, listeners: ScanListeners = {}): Promise<ScanResult> {
    const target = parseDemoTarget(opts.target);
    if (!target) throw new Error(`\`${opts.target}\` is not a network this can scan.`);

    const scanId = nextScanId++;
    activeScan = scanId;
    cancelledScan = 0;
    const startedAt = Date.now();
    const ports = opts.scan_services
      ? opts.ports.length > 0
        ? opts.ports
        : DEFAULT_PORTS
      : [22, 80, 443, 445, 3389];

    const found = devicesForTarget(target);
    listeners.onStarted?.({
      scan_id: scanId,
      target: opts.target,
      total: target.total,
      port_count: ports.length,
      warning: null,
    });

    const stopped = () => cancelledScan === scanId;
    // Discoveries are spread across the run so the table visibly fills, with
    // the per-device step derived from the count rather than fixed, so a
    // single-address scan does not take as long as a /24.
    const step = found.length > 0 ? scanDurationMs / (found.length + 4) : 0;
    const hosts: HostResult[] = [];
    let probed = 0;
    /** The devices the sweep actually reached before it ended. */
    const reached: typeof found = [];

    // Hostname lookups run alongside the sweep in the real backend and land as
    // their own updates, which is what the table's field-by-field merge exists
    // to handle. The demo does the same rather than revealing every name at the
    // end, so the behaviour being developed against is the real one.
    const nameUpdates: Promise<void>[] = [];

    for (const [index, entry] of found.entries()) {
      if (stopped()) break;
      await sleep(step);
      probed = Math.round(((index + 1) / found.length) * target.total);
      const host = hostFrom(entry.device, entry.ip, false, ports);
      reached.push(entry);
      listeners.onHostDiscovered?.({ scan_id: scanId, host });
      listeners.onProgress?.({
        scan_id: scanId,
        done: probed,
        total: target.total,
        found: index + 1,
        phase: "probing",
        elapsed_ms: Date.now() - startedAt,
      });

      if (entry.device.hostname) {
        nameUpdates.push(
          sleep(step * (1.5 + (index % 3))).then(() => {
            if (stopped()) return;
            listeners.onHostUpdated?.({
              scan_id: scanId,
              host: { ...host, hostname: entry.device.hostname },
              is_final: false,
            });
          }),
        );
      }
    }

    if (!stopped()) {
      listeners.onProgress?.({
        scan_id: scanId,
        done: target.total,
        total: target.total,
        found: found.length,
        phase: "resolving",
        elapsed_ms: Date.now() - startedAt,
      });
      await sleep(step * 2);
    }
    await Promise.all(nameUpdates);

    // Enrichment, in address order, exactly as the real scan finishes -- and
    // only for the devices the sweep reached, so a stopped scan reports what it
    // found rather than the whole fixture.
    for (const entry of reached) {
      const host = hostFrom(entry.device, entry.ip, true, ports);
      hosts.push(host);
      listeners.onHostUpdated?.({ scan_id: scanId, host, is_final: true });
    }

    const cancelled = stopped();
    listeners.onProgress?.({
      scan_id: scanId,
      done: cancelled ? probed : target.total,
      total: target.total,
      found: hosts.length,
      phase: cancelled ? "cancelled" : "done",
      elapsed_ms: Date.now() - startedAt,
    });
    activeScan = 0;

    return {
      scan_id: scanId,
      target: opts.target,
      duration_ms: Date.now() - startedAt,
      scanned: target.total,
      probed: cancelled ? probed : target.total,
      hosts,
      cancelled,
      ports,
    };
  },
};

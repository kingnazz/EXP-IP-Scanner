// Formatting helpers and the service-name lookup.
//
// Pure functions, so the things most easily got wrong -- numeric address order,
// a latency that reads the same for a wired and a wireless device, a port that
// shows as a bare number -- are testable without rendering anything.

import type { ServiceInfo } from "../types";

/** An address as a sortable number. The whole reason IP sorting is correct. */
export function ipToNum(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return 0;
  let total = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    total = total * 256 + (Number.isFinite(octet) ? octet : 0);
  }
  return total;
}

/**
 * Latency for display.
 *
 * A sub-millisecond response keeps two decimals, so a switched wired link does
 * not read identically to a slow wireless one. Above 10 ms the extra precision
 * is noise and is rounded away.
 */
export function formatLatency(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

/** A duration for the completion line: "4.8 sec", "1m 12s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} sec`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** A timestamp for the details panel. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Services
//
// The backend owns the service table and hands it over once at startup, so the
// interface keeps no second copy to drift out of step. Until it arrives (or in
// the browser demo) this fallback covers the default consultant set, which is
// enough that the table never shows a bare number where a word belongs.
// ---------------------------------------------------------------------------

const FALLBACK_SERVICES: ServiceInfo[] = [
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
  { port: 587, name: "SMTP" },
  { port: 631, name: "IPP" },
  { port: 993, name: "IMAPS" },
  { port: 995, name: "POP3S" },
  { port: 1433, name: "MSSQL" },
  { port: 1723, name: "PPTP" },
  { port: 3306, name: "MySQL" },
  { port: 3389, name: "RDP" },
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

let serviceMap = new Map<number, string>(FALLBACK_SERVICES.map((s) => [s.port, s.name]));

/** Install the catalog fetched from the backend. */
export function setServiceCatalog(services: ServiceInfo[]): void {
  if (services.length === 0) return;
  serviceMap = new Map(services.map((s) => [s.port, s.name]));
}

/** The service word for a port, or null when this build cannot name it. */
export function serviceName(port: number): string | null {
  return serviceMap.get(port) ?? null;
}

/** The service word, falling back to the number so a cell is never empty. */
export function serviceLabel(port: number): string {
  return serviceMap.get(port) ?? String(port);
}

/** "22 SSH", the form the Open Ports column and search both use. */
export function portWithService(port: number): string {
  const name = serviceMap.get(port);
  return name ? `${port} ${name}` : String(port);
}

/**
 * Ports that lead somewhere a consultant can click through to.
 *
 * Used to emphasise them in the table: across a full /24 this is what makes a
 * server, a printer and a switch distinguishable at a glance.
 */
const ACTIONABLE_PORTS = new Set([22, 80, 443, 445, 3389, 5900, 8080, 8443, 8000, 5985, 5986]);

export function isActionablePort(port: number): boolean {
  return ACTIONABLE_PORTS.has(port);
}

/**
 * The port a web action should use, preferring HTTPS and then the ordinary
 * management ports, so "Open web interface" lands on the right one when a
 * device answers on several.
 */
export function webPort(ports: readonly number[]): number | null {
  for (const p of [443, 8443, 80, 8080, 8000, 5986, 9100]) {
    if (ports.includes(p)) return p;
  }
  return null;
}

/** The SMB port a device answers on, if any. */
export function smbPort(ports: readonly number[]): number | null {
  if (ports.includes(445)) return 445;
  if (ports.includes(139)) return 139;
  return null;
}

/** The VNC port a device answers on, if any. */
export function vncPort(ports: readonly number[]): number | null {
  for (const p of [5900, 5901, 5902]) {
    if (ports.includes(p)) return p;
  }
  return null;
}

/** The phase word shown in the progress strip. */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "probing":
      return "Scanning";
    case "confirming":
      return "Confirming quiet devices";
    case "resolving":
      return "Resolving names";
    case "done":
      return "Finished";
    case "cancelled":
      return "Stopped";
    default:
      return "Scanning";
  }
}

/**
 * Parse a port specification for immediate feedback while typing.
 *
 * The backend re-parses every specification before a scan runs and is the
 * authority. This exists only so the Settings field can show a count and an
 * error without a round trip, and it deliberately uses the same wording.
 */
export function parsePorts(input: string, cap = 1024): { ports: number[]; error: string | null } {
  const text = input.trim();
  if (!text) return { ports: [], error: null };
  const set = new Set<number>();
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

  for (const raw of text.split(/[,;\s]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      let a = Number.parseInt(range[1] ?? "", 10);
      let b = Number.parseInt(range[2] ?? "", 10);
      if (a > b) [a, b] = [b, a];
      if (!valid(a) || !valid(b)) {
        return { ports: [], error: `\`${token}\` is out of range. Ports are 1 to 65535.` };
      }
      if (set.size + (b - a + 1) > cap) {
        return {
          ports: [],
          error: `\`${token}\` adds ${b - a + 1} ports, taking the list past the ${cap} port limit. Use a narrower range.`,
        };
      }
      for (let p = a; p <= b; p++) set.add(p);
      continue;
    }
    if (!/^\d+$/.test(token)) {
      return { ports: [], error: `\`${token}\` is not a port number.` };
    }
    const n = Number.parseInt(token, 10);
    if (!valid(n)) {
      return { ports: [], error: `\`${token}\` is out of range. Ports are 1 to 65535.` };
    }
    set.add(n);
    if (set.size > cap) {
      return {
        ports: [],
        error: `More than ${cap} ports selected. Use a shorter port list.`,
      };
    }
  }

  if (set.size === 0) return { ports: [], error: "That port list contains no ports." };
  return { ports: [...set].sort((a, b) => a - b), error: null };
}

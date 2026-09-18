// The Rust/TypeScript interface, in one place.
//
// Every type here mirrors a `#[derive(Serialize)]` struct in `src-tauri/src`.
// Field names are snake_case because that is what crosses the IPC boundary;
// renaming them on the way in would only create two vocabularies for the same
// data and a place for them to disagree.

/** What kind of adapter an interface appears to be. Mirrors `InterfaceKind`. */
export type InterfaceKind = "ethernet" | "wireless" | "vpn" | "virtual" | "other";

/** One usable local network. Mirrors `netinfo::LocalNetwork`. */
export interface LocalNetwork {
  /** The adapter name the operating system reports, e.g. `Ethernet 2`. */
  interface: string;
  /** This machine's own address on the interface. */
  ip: string;
  prefix: number;
  /** The interface's own network, in CIDR form. */
  cidr: string;
  /** The network the Scan button should target, narrowed on very large nets. */
  suggested_cidr: string;
  suggested_hosts: number;
  kind: InterfaceKind;
  kind_label: string;
  is_private: boolean;
  /** True for the single interface picked as the default. */
  recommended: boolean;
}

/** One discovered device. Mirrors `scanner::HostResult`. */
export interface HostResult {
  ip: string;
  hostname: string | null;
  mac: string | null;
  vendor: string | null;
  open_ports: number[];
  icmp_ms: number | null;
  tcp_ms: number | null;
  /** Fastest response of any kind. What the Latency column shows. */
  latency_ms: number | null;
  ttl: number | null;
  /** A coarse guess from the TTL, labelled as a guess wherever it is shown. */
  os_hint: string | null;
  is_self: boolean;
  seen_at: string;
}

/** Mirrors `scanner::ScanPhase`. */
export type ScanPhase = "probing" | "confirming" | "resolving" | "done" | "cancelled";

/** Mirrors `scanner::ScanProgress`. */
export interface ScanProgress {
  scan_id: number;
  done: number;
  total: number;
  found: number;
  phase: ScanPhase;
  elapsed_ms: number;
}

/** Mirrors `scanner::ScanStarted`. */
export interface ScanStarted {
  scan_id: number;
  target: string;
  total: number;
  port_count: number;
  warning: string | null;
}

/** Mirrors `scanner::ScanResult`. */
export interface ScanResult {
  scan_id: number;
  target: string;
  duration_ms: number;
  scanned: number;
  probed: number;
  hosts: HostResult[];
  cancelled: boolean;
  ports: number[];
}

/** Mirrors `scanner::ScanOptions`. */
export interface ScanOptions {
  target: string;
  ports: number[];
  timeout_ms: number;
  concurrency: number;
  tcp_concurrency: number;
  ping_concurrency: number;
  resolve_hostnames: boolean;
  scan_services: boolean;
}

/** Mirrors `commands::ScanPreview`. */
export interface ScanPreview {
  total: number;
  port_count: number;
  workload: number;
  warning: string | null;
}

/** Mirrors `commands::ServiceInfo`. */
export interface ServiceInfo {
  port: number;
  name: string;
}

/** Mirrors `runtime::RuntimeInfo`. */
export interface RuntimeInfo {
  version: string;
  edition: "installed" | "portable";
  edition_label: string;
  platform: string;
  architecture: string;
  /** `installer` can self-update; `manual` means download the next ZIP. */
  update_mode: "installer" | "manual";
}

/** Mirrors `launch::PingOutcome`. */
export interface PingOutcome {
  ip: string;
  replied: boolean;
  rtt_ms: number | null;
  ttl: number | null;
  summary: string;
}

export interface HostEvent {
  scan_id: number;
  host: HostResult;
  /**
   * True only for the last update a device will receive in this scan.
   *
   * Absent from a discovery event and from an intermediate update, which is
   * what lets the table show "resolving…" for a MAC that has not been read yet
   * rather than the em dash that means "there is none".
   */
  is_final?: boolean;
}

export interface HostRemovedEvent {
  scan_id: number;
  ip: string;
}

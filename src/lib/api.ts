// The single interface to the backend.
//
// It detects whether the application is running inside Tauri and, if not, falls
// back to the browser demo, so the whole interface is developable and testable
// without a Rust build. Nothing else in `src/` imports `@tauri-apps/api`
// directly, which is what keeps that fallback honest: there is one place where
// native and demo can diverge, and it is this file.

import type {
  HostEvent,
  HostRemovedEvent,
  LocalNetwork,
  PingOutcome,
  RuntimeInfo,
  ScanOptions,
  ScanPreview,
  ScanProgress,
  ScanResult,
  ScanStarted,
  ServiceInfo,
} from "../types";
import { demo } from "./demo";
import { fetchPublicIp, type PublicIpResult } from "./publicip";
import { fetchLatestRelease, isNewerVersion, type UpdateCheckResult } from "./update";
import { APP_VERSION } from "../version";

/** True when running inside the packaged desktop application. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(cmd, args);
}

/** The callbacks a caller supplies to receive a scan's streamed events. */
export interface ScanListeners {
  onStarted?: (started: ScanStarted) => void;
  onProgress?: (progress: ScanProgress) => void;
  onHostDiscovered?: (event: HostEvent) => void;
  onHostUpdated?: (event: HostEvent) => void;
  onHostRemoved?: (event: HostRemovedEvent) => void;
}

export const api = {
  /** True in the packaged application, false in the browser demo. */
  native: isTauri(),

  async runtimeInfo(): Promise<RuntimeInfo> {
    if (isTauri()) return invoke<RuntimeInfo>("runtime_info");
    return demo.runtimeInfo();
  },

  async detectNetworks(): Promise<LocalNetwork[]> {
    if (isTauri()) return invoke<LocalNetwork[]>("detect_networks");
    return demo.detectNetworks();
  },

  async serviceCatalog(): Promise<ServiceInfo[]> {
    if (isTauri()) return invoke<ServiceInfo[]>("service_catalog");
    return demo.serviceCatalog();
  },

  async defaultPorts(): Promise<number[]> {
    if (isTauri()) return invoke<number[]>("default_ports");
    return demo.defaultPorts();
  },

  async parsePortSpec(spec: string): Promise<number[]> {
    if (isTauri()) return invoke<number[]>("parse_port_spec", { spec });
    return demo.parsePortSpec(spec);
  },

  async previewScan(opts: ScanOptions): Promise<ScanPreview> {
    if (isTauri()) return invoke<ScanPreview>("preview_scan", { opts });
    return demo.previewScan(opts);
  },

  /**
   * Run a scan.
   *
   * Events are subscribed to before the command is invoked, so no device found
   * in the first milliseconds can be missed.
   */
  async scan(opts: ScanOptions, listeners: ScanListeners = {}): Promise<ScanResult> {
    if (!isTauri()) return demo.scan(opts, listeners);

    const { listen } = await import("@tauri-apps/api/event");
    const unlisten: Array<() => void> = [];
    const subscribe = async <T,>(name: string, handler: ((payload: T) => void) | undefined) => {
      if (!handler) return;
      unlisten.push(await listen<T>(name, (e) => handler(e.payload)));
    };

    await Promise.all([
      subscribe<ScanStarted>("scan:started", listeners.onStarted),
      subscribe<ScanProgress>("scan:progress", listeners.onProgress),
      subscribe<HostEvent>("scan:host-discovered", listeners.onHostDiscovered),
      subscribe<HostEvent>("scan:host-updated", listeners.onHostUpdated),
      subscribe<HostRemovedEvent>("scan:host-removed", listeners.onHostRemoved),
    ]);

    try {
      return await invoke<ScanResult>("scan_network", { opts });
    } finally {
      for (const off of unlisten) off();
    }
  },

  /** Ask the running scan to stop. It resolves with the devices found so far. */
  async cancelScan(): Promise<void> {
    if (isTauri()) return invoke<void>("cancel_scan");
    demo.cancelScan();
  },

  async ping(ip: string): Promise<PingOutcome> {
    if (isTauri()) return invoke<PingOutcome>("ping_host", { ip });
    return demo.ping(ip);
  },

  /**
   * This network's public IP address, or null if no service answered.
   *
   * The only outbound request the application makes on its own, and the only
   * one that does not go through a Rust command. It stays in the webview
   * deliberately: `connect-src` in `tauri.conf.json` names the two hosts it may
   * reach, which is a stronger and more auditable limit than a constant in
   * Rust, and it keeps an HTTP client and a TLS stack out of the portable
   * binary, which has neither and is 1.9 MB because of it. Nothing is sent, and
   * the reply is validated as an address before it is shown.
   */
  async publicIp(): Promise<PublicIpResult | null> {
    if (isTauri()) return fetchPublicIp();
    return demo.publicIp();
  },

  // --- Technician actions --------------------------------------------------

  async openWeb(ip: string, port: number | null): Promise<void> {
    if (isTauri()) return invoke<void>("open_web", { ip, port });
    window.open(`${port === 443 || port === 8443 ? "https" : "http"}://${ip}`, "_blank");
  },

  async openSmb(ip: string): Promise<void> {
    if (isTauri()) return invoke<void>("open_smb", { ip });
    throw new Error(`Opening \\\\${ip} needs the desktop application.`);
  },

  async openRdp(ip: string): Promise<void> {
    if (isTauri()) return invoke<void>("open_rdp", { ip });
    throw new Error(`Remote Desktop for ${ip} needs the desktop application.`);
  },

  async openSsh(ip: string): Promise<void> {
    if (isTauri()) return invoke<void>("open_ssh", { ip });
    throw new Error(`SSH to ${ip} needs the desktop application.`);
  },

  async openVnc(ip: string, port: number | null): Promise<void> {
    if (isTauri()) return invoke<void>("open_vnc", { ip, port });
    throw new Error(`VNC to ${ip} needs the desktop application.`);
  },

  async openPingConsole(ip: string): Promise<void> {
    if (isTauri()) return invoke<void>("open_ping_console", { ip });
    throw new Error("A command prompt needs the desktop application.");
  },

  async openTracerouteConsole(ip: string): Promise<void> {
    if (isTauri()) return invoke<void>("open_traceroute_console", { ip });
    throw new Error("A command prompt needs the desktop application.");
  },

  // --- Export and links ----------------------------------------------------

  /**
   * Save text the interface built to a file the technician chooses.
   *
   * Returns false when the save dialog was dismissed, so the caller can stay
   * quiet rather than reporting a cancelled save as a failure. In the browser
   * demo it downloads instead, which is what makes the export testable there.
   */
  async saveCsv(filename: string, contents: string): Promise<boolean> {
    if (isTauri()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: filename,
        filters: [{ name: "CSV spreadsheet", extensions: ["csv"] }],
      });
      if (!path) return false;
      await invoke<void>("save_text", { path, contents });
      return true;
    }
    const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  },

  async copyToClipboard(text: string): Promise<void> {
    // The WebView's own clipboard, which needs no capability of its own.
    await navigator.clipboard.writeText(text);
  },

  async openSite(): Promise<void> {
    if (isTauri()) return invoke<void>("open_site");
    window.open("https://nazar-exp.github.io/EXP-IP-Scanner/", "_blank");
  },

  async openReleases(): Promise<void> {
    if (isTauri()) return invoke<void>("open_releases");
    window.open("https://github.com/nazar-exp/EXP-IP-Scanner/releases", "_blank");
  },

  async openPrivacy(): Promise<void> {
    if (isTauri()) return invoke<void>("open_privacy");
    window.open("https://nazar-exp.github.io/EXP-IP-Scanner/privacy.html", "_blank");
  },

  /**
   * Ask the installed edition to check GitHub for a newer version.
   *
   * Only ever called when `runtime_info` reports `update_mode: "installer"`:
   * the portable build does not link the updater plugin at all, so there is
   * nothing here for it to reach.
   */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    if (!isTauri()) return { available: false };

    // GitHub Releases answers the user-facing question first: is there a newer
    // version? The signed Tauri manifest answers a different question: can this
    // installed build apply it in-place? Keeping those separate means update
    // checking still works before updater signing is configured.
    const latest = await fetchLatestRelease();
    if (!isNewerVersion(latest.version, APP_VERSION)) {
      return { available: false };
    }

    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update && update.version === latest.version) {
        return {
          available: true,
          version: latest.version,
          installable: true,
          releaseUrl: latest.url,
        };
      }
    } catch {
      // A missing/unsigned latest.json is not a failed update check. We still
      // know a newer GitHub release exists, so offer its download instead.
    }

    return {
      available: true,
      version: latest.version,
      installable: false,
      releaseUrl: latest.url,
    };
  },

  /** Download and install the update found by `checkForUpdate`, then relaunch. */
  async installUpdate(): Promise<void> {
    if (!isTauri()) return;
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

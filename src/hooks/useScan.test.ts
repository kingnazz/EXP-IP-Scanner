import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRINTER, SILENT_PRINTER, WINDOWS_SERVER, host } from "../test/devices";
import { api, type ScanListeners } from "../lib/api";
import type { ScanOptions, ScanResult } from "../types";
import { useScan } from "./useScan";

const OPTIONS: ScanOptions = {
  target: "192.168.50.0/24",
  ports: [],
  timeout_ms: 900,
  concurrency: 64,
  tcp_concurrency: 256,
  ping_concurrency: 32,
  resolve_hostnames: true,
  scan_services: true,
};

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    scan_id: 1,
    target: OPTIONS.target,
    duration_ms: 3_100,
    scanned: 254,
    probed: 254,
    hosts: [],
    cancelled: false,
    ports: [22, 80, 443],
    ...overrides,
  };
}

let onError: (message: string) => void;

beforeEach(() => {
  onError = vi.fn();
});

/** Drive the events a scan would stream, then resolve it. */
function stubScan(script: (listeners: ScanListeners) => ScanResult | Promise<ScanResult>) {
  return vi.spyOn(api, "scan").mockImplementation(async (_opts, listeners = {}) => script(listeners));
}

describe("a scan that finds devices", () => {
  it("streams rows in and settles them from the returned result", async () => {
    stubScan((listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      // Discovered with no name yet, exactly as the backend reports it.
      listeners.onHostDiscovered?.({
        scan_id: 1,
        host: host({ ip: WINDOWS_SERVER.ip, open_ports: [445, 3389], latency_ms: 0.62 }),
      });
      listeners.onProgress?.({
        scan_id: 1,
        done: 128,
        total: 254,
        found: 1,
        phase: "probing",
        elapsed_ms: 900,
      });
      listeners.onHostUpdated?.({ scan_id: 1, host: WINDOWS_SERVER, is_final: true });
      return result({ hosts: [WINDOWS_SERVER] });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.run(OPTIONS);
    });

    await waitFor(() => expect(hook.current.mode).toBe("finished"));
    expect(hook.current.rows).toHaveLength(1);
    expect(hook.current.rows[0]?.host.hostname).toBe("dc01.exp.local");
    expect(hook.current.rows[0]?.pending).toBe(false);
    expect(hook.current.summary).toEqual({
      target: OPTIONS.target,
      durationMs: 3_100,
      scanned: 254,
      probed: 254,
      found: 1,
      cancelled: false,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves a row pending until its final update arrives", async () => {
    // The scan is held open, so the state while it is still running is
    // observable rather than immediately overwritten by the result.
    let finish: (() => void) | null = null;
    stubScan(async (listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      listeners.onHostDiscovered?.({
        scan_id: 1,
        host: host({ ip: PRINTER.ip, open_ports: [9100], latency_ms: 2.8 }),
      });
      // A hostname that resolved mid-scan is not the last word on this device:
      // its MAC has not been read yet, so the row must still read as resolving.
      listeners.onHostUpdated?.({
        scan_id: 1,
        host: host({ ip: PRINTER.ip, hostname: PRINTER.hostname, open_ports: [9100] }),
        is_final: false,
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      listeners.onHostUpdated?.({ scan_id: 1, host: PRINTER, is_final: true });
      return result({ hosts: [PRINTER] });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    const running = hook.current.run(OPTIONS);

    await waitFor(() => expect(hook.current.rows).toHaveLength(1));
    expect(hook.current.rows[0]?.host.hostname).toBe(PRINTER.hostname);
    expect(hook.current.rows[0]?.host.mac).toBeNull();
    expect(hook.current.rows[0]?.pending).toBe(true);

    await act(async () => {
      finish?.();
      await running;
    });
    expect(hook.current.rows[0]?.pending).toBe(false);
    expect(hook.current.rows[0]?.host.mac).toBe(PRINTER.mac);
  });

  it("withdraws a device the scanner retracted", async () => {
    stubScan((listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      listeners.onHostDiscovered?.({ scan_id: 1, host: WINDOWS_SERVER });
      listeners.onHostDiscovered?.({ scan_id: 1, host: SILENT_PRINTER });
      // Proxy ARP made this address look occupied; it is not a device.
      listeners.onHostRemoved?.({ scan_id: 1, ip: SILENT_PRINTER.ip });
      return result({ hosts: [WINDOWS_SERVER] });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.run(OPTIONS);
    });
    expect(hook.current.rows.map((r) => r.host.ip)).toEqual([WINDOWS_SERVER.ip]);
  });

  it("ignores events from a scan the table is no longer showing", async () => {
    stubScan((listeners) => {
      listeners.onStarted?.({
        scan_id: 9,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      listeners.onHostDiscovered?.({ scan_id: 9, host: WINDOWS_SERVER });
      // A straggler from the scan before this one.
      listeners.onHostDiscovered?.({ scan_id: 8, host: SILENT_PRINTER });
      listeners.onProgress?.({
        scan_id: 8,
        done: 9_999,
        total: 9_999,
        found: 500,
        phase: "done",
        elapsed_ms: 1,
      });
      return result({ scan_id: 9, hosts: [WINDOWS_SERVER] });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.run(OPTIONS);
    });
    expect(hook.current.rows.map((r) => r.host.ip)).toEqual([WINDOWS_SERVER.ip]);
  });

  it("rebuilds the table from the result, so a dropped event cannot leave it wrong", async () => {
    // The scanner drops advisory events under backpressure. The returned
    // result is the source of truth and has to win.
    stubScan((listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      listeners.onHostDiscovered?.({ scan_id: 1, host: WINDOWS_SERVER });
      return result({ hosts: [WINDOWS_SERVER, PRINTER, SILENT_PRINTER] });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.run(OPTIONS);
    });
    expect(hook.current.rows).toHaveLength(3);
    expect(hook.current.rows.every((r) => !r.pending)).toBe(true);
  });
});

describe("stopping a scan", () => {
  it("asks the backend to stop and keeps what was already found", async () => {
    const cancel = vi.spyOn(api, "cancelScan").mockResolvedValue(undefined);
    let stop: (() => void) | null = null;

    stubScan(async (listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      listeners.onHostDiscovered?.({ scan_id: 1, host: WINDOWS_SERVER });
      await new Promise<void>((resolve) => {
        stop = resolve;
      });
      return result({ hosts: [WINDOWS_SERVER], cancelled: true, probed: 91 });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    const running = hook.current.run(OPTIONS);
    await waitFor(() => expect(hook.current.scanning).toBe(true));

    await act(async () => {
      await hook.current.cancel();
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(hook.current.stopping).toBe(true);

    await act(async () => {
      stop?.();
      await running;
    });

    expect(hook.current.mode).toBe("finished");
    expect(hook.current.stopping).toBe(false);
    expect(hook.current.summary?.cancelled).toBe(true);
    expect(hook.current.summary?.probed).toBe(91);
    // A stopped scan keeps its partial results.
    expect(hook.current.rows).toHaveLength(1);
  });

  it("does nothing when there is no scan running", async () => {
    const cancel = vi.spyOn(api, "cancelScan").mockResolvedValue(undefined);
    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.cancel();
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reports a stop that failed rather than leaving the button stuck", async () => {
    vi.spyOn(api, "cancelScan").mockRejectedValue(new Error("the bridge is gone"));
    let stop: (() => void) | null = null;
    stubScan(async (listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      await new Promise<void>((resolve) => {
        stop = resolve;
      });
      return result();
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    const running = hook.current.run(OPTIONS);
    await waitFor(() => expect(hook.current.scanning).toBe(true));
    await act(async () => {
      await hook.current.cancel();
    });
    expect(onError).toHaveBeenCalledWith("the bridge is gone");
    expect(hook.current.stopping).toBe(false);
    await act(async () => {
      stop?.();
      await running;
    });
  });
});

describe("a scan that fails", () => {
  it("reports the message and goes back to idle", async () => {
    vi.spyOn(api, "scan").mockRejectedValue(
      new Error("`nonsense` is not a valid IPv4 address."),
    );
    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.run({ ...OPTIONS, target: "nonsense" });
    });
    expect(onError).toHaveBeenCalledWith("`nonsense` is not a valid IPv4 address.");
    expect(hook.current.mode).toBe("idle");
    expect(hook.current.rows).toEqual([]);
    expect(hook.current.progress).toBeNull();
  });
});

describe("clearing", () => {
  it("empties the table and forgets the last scan", async () => {
    stubScan((listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      return result({ hosts: [WINDOWS_SERVER] });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.run(OPTIONS);
    });
    expect(hook.current.rows).toHaveLength(1);

    act(() => hook.current.clear());
    expect(hook.current.rows).toEqual([]);
    expect(hook.current.summary).toBeNull();
    expect(hook.current.started).toBeNull();
    expect(hook.current.mode).toBe("idle");
  });
});

describe("starting a new scan", () => {
  it("drops the previous results before the first event arrives", async () => {
    stubScan((listeners) => {
      listeners.onStarted?.({
        scan_id: 1,
        target: OPTIONS.target,
        total: 254,
        port_count: 31,
        warning: null,
      });
      return result({ hosts: [WINDOWS_SERVER] });
    });

    const { result: hook } = renderHook(() => useScan({ onError }));
    await act(async () => {
      await hook.current.run(OPTIONS);
    });

    stubScan((listeners) => {
      listeners.onStarted?.({
        scan_id: 2,
        target: "10.0.0.0/24",
        total: 254,
        port_count: 31,
        warning: null,
      });
      return result({ scan_id: 2, target: "10.0.0.0/24", hosts: [PRINTER] });
    });

    await act(async () => {
      await hook.current.run({ ...OPTIONS, target: "10.0.0.0/24" });
    });
    expect(hook.current.rows.map((r) => r.host.ip)).toEqual([PRINTER.ip]);
    expect(hook.current.summary?.target).toBe("10.0.0.0/24");
  });
});

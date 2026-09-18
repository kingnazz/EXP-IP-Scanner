import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  isStaleEvent,
  removeHostByIp,
  rowsFromResult,
  settleRows,
  upsertHost,
  type DeviceRow,
} from "../lib/live";
import type {
  HostEvent,
  HostRemovedEvent,
  ScanOptions,
  ScanProgress,
  ScanResult,
  ScanStarted,
} from "../types";

export type ScanMode = "idle" | "scanning" | "finished";

/** What the completion line reports about the scan just finished. */
export interface ScanSummary {
  target: string;
  durationMs: number;
  scanned: number;
  probed: number;
  found: number;
  cancelled: boolean;
}

/** A queued event, applied in batches rather than one render at a time. */
type Queued =
  | { kind: "upsert"; host: HostEvent["host"]; pending: boolean }
  | { kind: "remove"; ip: string };

/**
 * Roughly ten repaints a second while results stream in: fast enough to feel
 * live, cheap enough that a /22 does not drive a React render per device.
 */
const FLUSH_INTERVAL_MS = 100;

export interface UseScanOptions {
  onError: (message: string) => void;
}

/**
 * Runs scans and keeps the results table in step with them.
 *
 * Two things here carry their weight. Events are queued and applied on an
 * interval, so a wide sweep cannot drive one render per device. And every event
 * is checked against the scan the interface is currently showing, so a stopped
 * scan winding down in the background cannot inject devices into the next one.
 */
export function useScan({ onError }: UseScanOptions) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [mode, setMode] = useState<ScanMode>("idle");
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [started, setStarted] = useState<ScanStarted | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);

  /** The scan whose events the interface accepts. */
  const activeScanId = useRef<number | null>(null);
  const queue = useRef<Queued[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, []);

  const flush = useCallback(() => {
    flushTimer.current = null;
    const batch = queue.current;
    if (batch.length === 0) return;
    queue.current = [];
    setRows((current) => {
      let next = current;
      for (const item of batch) {
        next =
          item.kind === "upsert"
            ? upsertHost(next, item.host, item.pending)
            : removeHostByIp(next, item.ip);
      }
      return next;
    });
  }, []);

  const enqueue = useCallback(
    (item: Queued) => {
      queue.current.push(item);
      if (flushTimer.current == null) {
        flushTimer.current = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
    },
    [flush],
  );

  const clearQueue = useCallback(() => {
    queue.current = [];
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
  }, []);

  const run = useCallback(
    async (opts: ScanOptions) => {
      // Claiming the slot before the first await means a second Scan while this
      // one is starting cannot interleave two sets of events.
      activeScanId.current = null;
      clearQueue();

      setRows([]);
      setProgress(null);
      setStarted(null);
      setSummary(null);
      setStopping(false);
      setMode("scanning");

      try {
        const result: ScanResult = await api.scan(opts, {
          onStarted: (event) => {
            activeScanId.current = event.scan_id;
            setStarted(event);
          },
          onProgress: (event) => {
            if (isStaleEvent(event.scan_id, activeScanId.current)) return;
            setProgress(event);
          },
          onHostDiscovered: (event: HostEvent) => {
            if (isStaleEvent(event.scan_id, activeScanId.current)) return;
            // Still pending: the hostname, MAC and manufacturer arrive later.
            enqueue({ kind: "upsert", host: event.host, pending: true });
          },
          onHostUpdated: (event: HostEvent) => {
            if (isStaleEvent(event.scan_id, activeScanId.current)) return;
            // Only the final update settles a row. A hostname that resolved
            // mid-scan must not make the MAC and manufacturer -- which are not
            // read until the ARP pass at the end -- look like they are missing.
            enqueue({ kind: "upsert", host: event.host, pending: event.is_final !== true });
          },
          onHostRemoved: (event: HostRemovedEvent) => {
            if (isStaleEvent(event.scan_id, activeScanId.current)) return;
            enqueue({ kind: "remove", ip: event.ip });
          },
        });

        flush();
        if (!mounted.current) return;

        // Rebuild from the returned result, which is the source of truth: if an
        // update event was dropped under backpressure, the table still ends up
        // exactly what the scan found.
        setRows(settleRows(rowsFromResult(result.hosts)));
        setMode("finished");
        setStopping(false);
        setSummary({
          target: result.target,
          durationMs: result.duration_ms,
          scanned: result.scanned,
          probed: result.probed,
          found: result.hosts.length,
          cancelled: result.cancelled,
        });
      } catch (error) {
        if (!mounted.current) return;
        activeScanId.current = null;
        clearQueue();
        setMode("idle");
        setStopping(false);
        setProgress(null);
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    [clearQueue, enqueue, flush, onError],
  );

  const cancel = useCallback(async () => {
    if (mode !== "scanning" || stopping) return;
    setStopping(true);
    try {
      await api.cancelScan();
    } catch (error) {
      setStopping(false);
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [mode, stopping, onError]);

  /** Clear the table without starting anything. */
  const clear = useCallback(() => {
    activeScanId.current = null;
    clearQueue();
    setRows([]);
    setProgress(null);
    setStarted(null);
    setSummary(null);
    setMode("idle");
  }, [clearQueue]);

  return {
    rows,
    mode,
    scanning: mode === "scanning",
    stopping,
    progress,
    started,
    summary,
    run,
    cancel,
    clear,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  compareWatchResults,
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
  HostResult,
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

export interface ScanRunOptions {
  /** Keep the last completed table visible and compare this result against it. */
  watch?: boolean;
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
 * Normal scans stream results into an empty table. Watch scans deliberately do
 * not: they keep the last completed table stable while the next pass runs, then
 * swap in one comparison at completion. That is what makes New, Changed, and
 * Offline useful instead of making the table flicker every few seconds.
 */
export function useScan({ onError }: UseScanOptions) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [mode, setMode] = useState<ScanMode>("idle");
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [started, setStarted] = useState<ScanStarted | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [lastRunFailed, setLastRunFailed] = useState(false);

  /** The scan whose events the interface accepts. */
  const activeScanId = useRef<number | null>(null);
  const queue = useRef<Queued[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  /** The last completed online set, plus devices retained as offline. */
  const watchBaseline = useRef<HostResult[] | null>(null);
  const watchOffline = useRef<Map<string, HostResult>>(new Map());

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
    async (opts: ScanOptions, runOptions: ScanRunOptions = {}): Promise<boolean> => {
      const watch = runOptions.watch === true;

      // Claiming the slot before the first await means a second Scan while this
      // one is starting cannot interleave two sets of events.
      activeScanId.current = null;
      clearQueue();

      if (!watch) {
        watchBaseline.current = null;
        watchOffline.current.clear();
        setRows([]);
        setSummary(null);
      }
      setProgress(null);
      setStarted(null);
      setStopping(false);
      setLastRunFailed(false);
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
            if (watch || isStaleEvent(event.scan_id, activeScanId.current)) return;
            enqueue({ kind: "upsert", host: event.host, pending: true });
          },
          onHostUpdated: (event: HostEvent) => {
            if (watch || isStaleEvent(event.scan_id, activeScanId.current)) return;
            enqueue({ kind: "upsert", host: event.host, pending: event.is_final !== true });
          },
          onHostRemoved: (event: HostRemovedEvent) => {
            if (watch || isStaleEvent(event.scan_id, activeScanId.current)) return;
            enqueue({ kind: "remove", ip: event.ip });
          },
        });

        if (!watch) flush();
        if (!mounted.current) return false;

        if (watch) {
          // A user stopping Watch Mode should not turn every unprobed address
          // into a false Offline result. Keep the last completed table instead.
          if (!result.cancelled) {
            const comparison = compareWatchResults(
              watchBaseline.current,
              result.hosts,
              watchOffline.current,
            );
            watchBaseline.current = [...result.hosts];
            watchOffline.current = comparison.offline;
            setRows(comparison.rows);
          }
        } else {
          const settled = settleRows(rowsFromResult(result.hosts));
          watchBaseline.current = [...result.hosts];
          setRows(settled);
        }

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
        return true;
      } catch (error) {
        if (!mounted.current) return false;
        activeScanId.current = null;
        clearQueue();
        setMode(watch && summary ? "finished" : "idle");
        setStopping(false);
        setProgress(null);
        setLastRunFailed(true);
        onError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [clearQueue, enqueue, flush, onError, summary],
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

  /**
   * Leave Watch Mode without leaving its comparison ghosts behind.
   * The table returns to the most recent completed online set.
   */
  const endWatch = useCallback(() => {
    watchOffline.current.clear();
    setRows((current) => {
      const online =
        watchBaseline.current ??
        current.filter((row) => row.watchState !== "offline").map((row) => row.host);
      return settleRows(rowsFromResult([...online]));
    });
  }, []);

  const clearFailure = useCallback(() => setLastRunFailed(false), []);

  /** Clear the table without starting anything. */
  const clear = useCallback(() => {
    activeScanId.current = null;
    clearQueue();
    watchBaseline.current = null;
    watchOffline.current.clear();
    setRows([]);
    setProgress(null);
    setStarted(null);
    setSummary(null);
    setLastRunFailed(false);
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
    lastRunFailed,
    run,
    cancel,
    endWatch,
    clearFailure,
    clear,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AssessmentRun, DeviceAssessment } from "../security-types";
import type { ScanResult } from "../types";

let nextAssessmentId = Date.now();
/** Each discovery owns one security generation. Starting discovery, clearing,
 * stopping, or unmounting invalidates callbacks before cancelling native I/O. */
export function useSecurity(source: ScanResult | null) {
  const [devices, setDevices] = useState<DeviceAssessment[]>([]);
  const [run, setRun] = useState<AssessmentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<number | null>(null);
  const observed = useRef(new Map<string, DeviceAssessment>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDevices([...observed.current.values()]);
  }, []);
  const cancel = useCallback(() => {
    const id = active.current;
    active.current = null;
    flush();
    setBusy(false);
    setRun((current) =>
      current
        ? {
            ...current,
            cancelled: true,
            completed_at: new Date().toISOString(),
          }
        : current,
    );
    if (id != null) void api.cancelSecurity(id).catch(() => {});
  }, [flush]);
  const start = useCallback(
    async (deep = false) => {
      if (!source) return;
      cancel();
      const id = ++nextAssessmentId;
      active.current = id;
      observed.current.clear();
      setDevices([]);
      setBusy(true);
      setError(null);
      const started = new Date().toISOString();
      setRun({
        assessment_id: id,
        scan_id: source.scan_id,
        mode: deep ? "Deep Scan · low-impact verification only" : "Safe Scan",
        started_at: started,
        completed_at: started,
        cancelled: false,
        devices: [],
      });
      try {
        const result = await api.assessSecurity(source, id, deep, (event) => {
          if (
            active.current !== id ||
            event.assessment_id !== id ||
            event.scan_id !== source.scan_id
          )
            return;
          for (const device of event.devices)
            observed.current.set(device.device_ip, device);
          if (timer.current == null) timer.current = setTimeout(flush, 100);
        });
        if (active.current !== id) return;
        observed.current = new Map(result.devices.map((d) => [d.device_ip, d]));
        flush();
        setRun(result);
        setBusy(false);
        active.current = null;
      } catch (e) {
        if (active.current !== id) return;
        flush();
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        active.current = null;
        setRun((current) =>
          current
            ? {
                ...current,
                cancelled: true,
                completed_at: new Date().toISOString(),
              }
            : null,
        );
      }
    },
    [source, cancel, flush],
  );
  useEffect(() => {
    setDevices([]);
    setRun(null);
    setError(null);
    // Stop discovery must also stop automatic network activity. Partial
    // results remain available for an explicit Safe Scan action.
    if (source && !source.cancelled) void start();
    return cancel;
  }, [source, start, cancel]);
  return { devices, run, busy, error, cancel, start };
}

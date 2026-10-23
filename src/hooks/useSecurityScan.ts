import { useCallback, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { DeviceRow } from "../lib/live";
import type { SecurityAssessment } from "../types";

const WEB_SECURITY_PORTS = new Set([80, 443, 5000, 5001, 8000, 8008, 8080, 8443, 8888]);
const SECURITY_CONCURRENCY = 4;

export interface SecurityRunSummary {
  total: number;
  critical: number;
  attention: number;
  clear: number;
  unknown: number;
}

/**
 * Network-wide passive web security assessment.
 *
 * The normal discovery scan stays fast and predictable. This second pass is
 * explicit, only checks devices where discovery already found a supported web
 * port, and runs a small number of assessments in parallel so a customer LAN
 * is not hammered just because it contains many management interfaces.
 */
export function useSecurityScan(rows: readonly DeviceRow[]) {
  const [assessments, setAssessments] = useState<Record<string, SecurityAssessment>>({});
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  const eligibleRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.watchState !== "offline" &&
          row.host.open_ports.some((port) => WEB_SECURITY_PORTS.has(port)),
      ),
    [rows],
  );

  const counts = useMemo(() => {
    const result = { critical: 0, attention: 0, clear: 0, unknown: 0 };
    for (const assessment of Object.values(assessments)) {
      result[assessment.status] += 1;
    }
    return result;
  }, [assessments]);

  const statuses = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(assessments).map(([ip, assessment]) => [ip, assessment.status]),
      ) as Record<string, SecurityAssessment["status"]>,
    [assessments],
  );

  const recordAssessment = useCallback((assessment: SecurityAssessment) => {
    setAssessments((current) => ({ ...current, [assessment.target]: assessment }));
  }, []);

  const clear = useCallback(() => {
    setAssessments({});
    setProgress({ done: 0, total: 0 });
    setFlaggedOnly(false);
  }, []);

  const runAll = useCallback(async (): Promise<SecurityRunSummary | null> => {
    if (scanning || eligibleRows.length === 0) return null;

    setScanning(true);
    setAssessments({});
    setFlaggedOnly(false);
    setProgress({ done: 0, total: eligibleRows.length });

    const completed: Record<string, SecurityAssessment> = {};
    let cursor = 0;
    let done = 0;

    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const row = eligibleRows[index];
        if (!row) return;

        let assessment: SecurityAssessment;
        try {
          assessment = await api.securityAssessment(row.host.ip, row.host.open_ports);
        } catch (error) {
          assessment = {
            target: row.host.ip,
            checked_at: new Date().toISOString(),
            status: "unknown",
            summary:
              error instanceof Error
                ? error.message
                : "The passive security check could not be completed for this device.",
            web_services: [],
            findings: [],
          };
        }

        completed[row.host.ip] = assessment;
        setAssessments((current) => ({ ...current, [row.host.ip]: assessment }));
        done += 1;
        setProgress({ done, total: eligibleRows.length });
      }
    };

    try {
      const workers = Math.min(SECURITY_CONCURRENCY, eligibleRows.length);
      await Promise.all(Array.from({ length: workers }, () => worker()));

      const summary: SecurityRunSummary = {
        total: eligibleRows.length,
        critical: 0,
        attention: 0,
        clear: 0,
        unknown: 0,
      };
      for (const assessment of Object.values(completed)) {
        summary[assessment.status] += 1;
      }
      return summary;
    } finally {
      setScanning(false);
    }
  }, [eligibleRows, scanning]);

  return {
    assessments,
    statuses,
    counts,
    eligibleCount: eligibleRows.length,
    checkedCount: Object.keys(assessments).length,
    scanning,
    progress,
    flaggedOnly,
    setFlaggedOnly,
    recordAssessment,
    clear,
    runAll,
  };
}

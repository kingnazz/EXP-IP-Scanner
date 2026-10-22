import type {
  AssessmentRun,
  DeviceAssessment,
  Finding,
  Severity,
} from "../security-types";
import type { ScanResult } from "../types";

export const actionable = (f: Finding) =>
  f.status !== "NotAffected" && f.status !== "Informational";
export function counts(devices: DeviceAssessment[]): Record<Severity, number> {
  const result: Record<Severity, number> = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Informational: 0,
  };
  for (const device of devices)
    for (const f of device.findings) if (actionable(f)) result[f.severity]++;
  return result;
}
export function securityReport(
  source: ScanResult,
  run: AssessmentRun,
  devices: DeviceAssessment[],
) {
  const findings = devices.flatMap((d) => d.findings).filter(actionable);
  return {
    schema_version: 1,
    tool: "EXP-IP-Scanner",
    assessment_label:
      "EXP-IP-Scanner assessment score; not an industry standard or a guarantee of security",
    target_network: source.target,
    scan_timestamp: source.hosts[0]?.seen_at ?? run.started_at,
    discovery: {
      scan_id: source.scan_id,
      addresses_scanned: source.probed,
      addresses_in_scope: source.scanned,
      devices_discovered: source.hosts.length,
      ports_scanned: source.ports,
      cancelled: source.cancelled,
    },
    summary: {
      devices_assessed: devices.length,
      counts: counts(devices),
      critical_high_findings: findings.filter(
        (f) => f.severity === "Critical" || f.severity === "High",
      ),
      affected_systems: [...new Set(findings.map((f) => f.device_ip))],
      recommended_remediation: [...new Set(findings.map((f) => f.remediation))],
    },
    intelligence_notice:
      "PHP2Shell identifiers and thresholds are user-supplied and unverified. PATCHED means at or above the supplied threshold. Vendor confirmation is required.",
    assessment: { ...run, devices },
  };
}

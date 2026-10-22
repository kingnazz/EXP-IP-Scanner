/** Illustration only: no network calls, no browser-side detection engine. */
import type {
  AssessmentRun,
  DeviceAssessment,
  Finding,
  SecurityEvent,
  WebService,
} from "../security-types";
import type { ScanResult } from "../types";
export async function demoAssessment(
  source: ScanResult,
  id: number,
  deep: boolean,
  emit: (event: SecurityEvent) => void,
): Promise<AssessmentRun> {
  const now = new Date().toISOString();
  const devices: DeviceAssessment[] = source.hosts.map((host) => {
    const port = host.open_ports.includes(5000) ? 5000 : 80;
    const sample = host.vendor === "Synology" && host.open_ports.includes(port);
    const service: WebService = {
      port,
      protocol: "http",
      endpoint: `http://${host.ip}:${port}/`,
      status: 200,
      redirect_destination: null,
      title: "Synology DiskStation",
      server: "nginx",
      technologies: [
        {
          product: "Synology DSM",
          version: null,
          confidence: "High",
          evidence: ["Sample DSM title and webman asset path"],
        },
        {
          product: "PHP",
          version: "8.2.30",
          confidence: "High",
          evidence: ["Sample X-Powered-By PHP header"],
        },
      ],
      admin_interfaces: ["Synology DSM"],
      tls: null,
      body_truncated: false,
      error: null,
    };
    const base: Finding = {
      finding_id: `${host.ip}:sample-php`,
      title: "PHP2Shell exposure assessment",
      severity: "Critical",
      status: "Possible",
      exposure_status: "POSSIBLY_VULNERABLE",
      device_ip: host.ip,
      hostname: host.hostname,
      port,
      protocol: "http",
      product: "PHP",
      detected_version: "8.2.30",
      cve_ids: ["CVE-2026-109618", "CVE-2026-109619"],
      confidence: "Low",
      evidence: [
        "Illustrative PHP 8.2.30 banner",
        "User-supplied, unverified intelligence",
      ],
      description:
        "Sample data. The supplied version range suggests possible exposure. Vendor advisory and backport status require verification.",
      remediation:
        "Verify the vendor advisory and upgrade to a supported patched PHP release.",
      references: ["https://www.php.net/supported-versions.php"],
      timestamp: now,
      score_category: null,
    };
    const admin: Finding = {
      ...base,
      finding_id: `${host.ip}:sample-admin`,
      title: "Exposed Administrative Interface",
      severity: "Medium",
      status: "Confirmed",
      exposure_status: null,
      product: "Synology DSM",
      detected_version: null,
      cve_ids: [],
      confidence: "High",
      evidence: ["Sample DSM management page reachable on HTTP"],
      description:
        "Exposure increases attack surface and is not necessarily a vulnerability. Internet reachability was not tested.",
      remediation:
        "Restrict management to an administration VLAN or VPN; enable HTTPS and MFA.",
      references: [],
      score_category: "admin_interface",
    };
    return {
      device_ip: host.ip,
      hostname: host.hostname,
      services: sample ? [service] : [],
      findings: sample ? [base, admin] : [],
      score: {
        value: sample ? 65 : 100,
        factors: sample
          ? [
              { finding_id: base.finding_id, title: base.title, deduction: 30 },
              {
                finding_id: admin.finding_id,
                title: admin.title,
                deduction: 5,
              },
            ]
          : [],
      },
      assessed_at: now,
      complete: false,
      coverage_notes: [
        "Browser demo: illustrative assessment only. No devices were contacted. Desktop Safe Scan performs local analysis.",
      ],
    };
  });
  for (const device of devices)
    emit({ scan_id: source.scan_id, assessment_id: id, devices: [device] });
  return {
    assessment_id: id,
    scan_id: source.scan_id,
    mode: deep ? "Demo Deep Scan · low-impact only" : "Demo Safe Scan",
    started_at: now,
    completed_at: now,
    cancelled: false,
    devices,
  };
}

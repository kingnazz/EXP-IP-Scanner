import { describe, expect, it } from "vitest";
import {
  actionable,
  counts,
  securityReport,
  webExposureScanOptions,
} from "./security";
import { sampleSecurityRun, securitySource } from "../test/security";

describe("security report", () => {
  it("exports scope, evidence, remediation and coverage without page content", async () => {
    const run = await sampleSecurityRun();
    const report = securityReport(securitySource, run, run.devices);
    expect(report.target_network).toBe(securitySource.target);
    expect(report.summary.counts).toMatchObject({
      Critical: 1,
      Medium: 1,
      High: 0,
    });
    expect(report.summary.devices_assessed).toBe(1);
    expect(report.summary.affected_systems).toEqual([
      securitySource.hosts[0]?.ip,
    ]);
    expect(report.summary.recommended_remediation.length).toBe(2);
    expect(report.assessment.devices[0]?.coverage_notes.length).toBeGreaterThan(
      0,
    );
    expect(report.intelligence_notice).toContain("unverified");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
  it("does not count informational or patched results as vulnerabilities", async () => {
    const run = await sampleSecurityRun();
    const d = run.devices[0]!;
    d.findings = d.findings.map((f) => ({ ...f, status: "NotAffected" }));
    expect(counts([d]).Critical).toBe(0);
    expect(d.findings.filter(actionable)).toHaveLength(0);
  });
});

describe("web exposure discovery preset", () => {
  it("includes common web ports and custom services without changing saved options", async () => {
    const options = {
      target: "192.168.50.0/24",
      ports: [9001, 22, 443],
      timeout_ms: 900,
      concurrency: 64,
      tcp_concurrency: 256,
      ping_concurrency: 32,
      resolve_hostnames: true,
      scan_services: false,
    };
    const before = structuredClone(options);
    const exposure = webExposureScanOptions(options, [22, 80, 443, 445]);
    expect(exposure.ports).toEqual([
      22, 80, 443, 5000, 5001, 8000, 8080, 8443, 8888, 9001,
    ]);
    expect(exposure.scan_services).toBe(true);
    expect(exposure.target).toBe(options.target);
    expect(exposure.tcp_concurrency).toBe(options.tcp_concurrency);
    expect(options).toEqual(before);
  });
  it("keeps default consultant services when no custom ports are selected", async () => {
    const result = webExposureScanOptions(
      {
        target: "192.168.50.1-254",
        ports: [],
        timeout_ms: 900,
        concurrency: 64,
        tcp_concurrency: 256,
        ping_concurrency: 32,
        resolve_hostnames: false,
        scan_services: false,
      },
      [22, 80, 443, 445, 3389],
    );
    expect(result.ports).toEqual([
      22, 80, 443, 445, 3389, 5000, 5001, 8000, 8080, 8443, 8888,
    ]);
    expect(result.resolve_hostnames).toBe(false);
  });
});

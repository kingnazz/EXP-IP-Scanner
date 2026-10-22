import { describe, expect, it } from "vitest";
import { actionable, counts, securityReport } from "./security";
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

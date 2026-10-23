import { describe, expect, it } from "vitest";
import type { SecurityAssessment, WebServiceFingerprint } from "../types";
import { phpServiceChip } from "./phpService";

function service(overrides: Partial<WebServiceFingerprint> = {}): WebServiceFingerprint {
  return {
    port: 80,
    scheme: "http",
    status: 200,
    server: "nginx",
    powered_by: null,
    php_version: null,
    product: null,
    title: null,
    note: null,
    ...overrides,
  };
}

function assessment(web_services: WebServiceFingerprint[]): SecurityAssessment {
  return {
    target: "192.168.1.10",
    checked_at: "2026-10-23T00:00:00Z",
    status: "clear",
    summary: "test",
    web_services,
    findings: [],
  };
}

describe("phpServiceChip", () => {
  it("shows the disclosed PHP version", () => {
    expect(phpServiceChip(assessment([service({ php_version: "8.2.35" })]))).toEqual({
      label: "PHP 8.2.35",
      title: "PHP 8.2.35 detected by the passive Security pass.",
    });
  });

  it("shows PHP without guessing a hidden version", () => {
    expect(
      phpServiceChip(
        assessment([service({ powered_by: "PHP", product: "PHP web application" })]),
      )?.label,
    ).toBe("PHP");
  });

  it("does not label a normal web server as PHP", () => {
    expect(phpServiceChip(assessment([service({ product: "nginx" })]))).toBeNull();
  });

  it("summarises multiple PHP versions in one compact chip", () => {
    const chip = phpServiceChip(
      assessment([
        service({ php_version: "8.2.35" }),
        service({ port: 443, scheme: "https", php_version: "8.3.36" }),
      ]),
    );
    expect(chip?.label).toBe("PHP 8.2.35 +1");
    expect(chip?.title).toContain("8.3.36");
  });
});

import type { SecurityAssessment } from "../types";

const PHP_PRODUCTS = new Set(["PHP web application", "WordPress", "phpMyAdmin"]);

export interface PhpServiceChip {
  label: string;
  title: string;
}

/**
 * Turn a passive security assessment into one compact service-table chip.
 *
 * PHP is an application runtime, not an open port, so it is deliberately kept
 * separate from HostResult.open_ports. The results table can still show it next
 * to HTTP/HTTPS once the explicit Security pass has positively identified PHP.
 */
export function phpServiceChip(assessment: SecurityAssessment | undefined): PhpServiceChip | null {
  if (!assessment) return null;

  const versions = Array.from(
    new Set(
      assessment.web_services
        .map((service) => service.php_version?.trim())
        .filter((version): version is string => Boolean(version)),
    ),
  );

  const phpDetected =
    versions.length > 0 ||
    assessment.web_services.some((service) => {
      const poweredBy = service.powered_by?.toLowerCase() ?? "";
      return poweredBy.includes("php") || PHP_PRODUCTS.has(service.product ?? "");
    }) ||
    assessment.findings.some((finding) => finding.id.startsWith("php"));

  if (!phpDetected) return null;

  if (versions.length === 0) {
    return {
      label: "PHP",
      title: "PHP detected by the passive Security pass; version not disclosed.",
    };
  }

  if (versions.length === 1) {
    return {
      label: `PHP ${versions[0]}`,
      title: `PHP ${versions[0]} detected by the passive Security pass.`,
    };
  }

  return {
    label: `PHP ${versions[0]} +${versions.length - 1}`,
    title: `Multiple PHP versions detected by the passive Security pass: ${versions.join(", ")}.`,
  };
}

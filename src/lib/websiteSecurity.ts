import type { SecurityAssessment } from "../types";
import { isTauri } from "./api";

/**
 * Run the hostname-aware passive website assessment.
 *
 * Kept separate from the network-device API for this feature pass because a
 * website target is not a discovered HostResult. The native command preserves
 * the hostname in the URL so TLS SNI and HTTP virtual-host routing stay correct.
 */
export async function websiteSecurityAssessment(target: string): Promise<SecurityAssessment> {
  if (!isTauri()) {
    return {
      target,
      checked_at: new Date().toISOString(),
      status: "unknown",
      summary: "Website security checks run in the Windows desktop application.",
      web_services: [],
      findings: [],
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SecurityAssessment>("website_security_assessment", { target });
}

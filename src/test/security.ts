import type { ScanResult } from "../types";
import { NAS } from "./devices";
import { demoAssessment } from "../lib/security-demo";
export const securitySource: ScanResult = {
  scan_id: 42,
  target: "192.168.50.0/24",
  hosts: [NAS],
  ports: [80, 443, 5000],
  scanned: 254,
  probed: 254,
  cancelled: false,
  duration_ms: 1000,
};
export const sampleSecurityRun = () =>
  demoAssessment(securitySource, 1, false, () => {});

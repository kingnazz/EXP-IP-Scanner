/** Mirrors exp-security's serde models. Remote HTML never enters these types. */
export type Severity = "Critical" | "High" | "Medium" | "Low" | "Informational";
export type Confidence = "High" | "Medium" | "Low";
export type FindingStatus =
  | "Confirmed"
  | "Likely"
  | "Possible"
  | "Informational"
  | "NotAffected";
export type ExposureStatus =
  | "NOT_APPLICABLE"
  | "PATCHED"
  | "POSSIBLY_VULNERABLE"
  | "LIKELY_VULNERABLE"
  | "UNKNOWN";
export interface Technology {
  product: string;
  version: string | null;
  confidence: Confidence;
  evidence: string[];
}
export interface TlsResult {
  certificate_subject: string | null;
  certificate_issuer: string | null;
  expires_at: string | null;
  expired: boolean | null;
  not_yet_valid: boolean | null;
  hostname_mismatch: boolean | null;
  self_signed_indication: boolean | null;
  trusted: boolean;
  error: string | null;
  obsolete_protocols_tested: boolean;
}
export interface WebService {
  port: number;
  protocol: string;
  endpoint: string;
  status: number | null;
  redirect_destination: string | null;
  title: string | null;
  server: string | null;
  technologies: Technology[];
  admin_interfaces: string[];
  tls: TlsResult | null;
  body_truncated: boolean;
  error: string | null;
}
export interface Finding {
  finding_id: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  exposure_status: ExposureStatus | null;
  device_ip: string;
  hostname: string | null;
  port: number;
  protocol: string;
  product: string;
  detected_version: string | null;
  cve_ids: string[];
  confidence: Confidence;
  evidence: string[];
  description: string;
  remediation: string;
  references: string[];
  timestamp: string;
  score_category: string | null;
}
export interface DeviceAssessment {
  device_ip: string;
  hostname: string | null;
  services: WebService[];
  findings: Finding[];
  score: {
    value: number;
    factors: { finding_id: string; title: string; deduction: number }[];
  };
  assessed_at: string;
  complete: boolean;
  coverage_notes: string[];
}
export interface AssessmentRun {
  assessment_id: number;
  scan_id: number;
  mode: string;
  started_at: string;
  completed_at: string;
  cancelled: boolean;
  devices: DeviceAssessment[];
}
export interface SecurityEvent {
  scan_id: number;
  assessment_id: number;
  devices: DeviceAssessment[];
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Informational,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Confidence {
    High,
    Medium,
    Low,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FindingStatus {
    Confirmed,
    Likely,
    Possible,
    Informational,
    NotAffected,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExposureStatus {
    NotApplicable,
    Patched,
    PossiblyVulnerable,
    LikelyVulnerable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceTarget {
    pub ip: String,
    pub hostname: Option<String>,
    pub open_ports: Vec<u16>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Technology {
    pub product: String,
    pub version: Option<String>,
    pub confidence: Confidence,
    pub evidence: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TlsResult {
    pub certificate_subject: Option<String>,
    pub certificate_issuer: Option<String>,
    pub expires_at: Option<String>,
    pub expired: Option<bool>,
    pub not_yet_valid: Option<bool>,
    pub hostname_mismatch: Option<bool>,
    pub self_signed_indication: Option<bool>,
    pub trusted: bool,
    pub error: Option<String>,
    pub obsolete_protocols_tested: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebService {
    pub port: u16,
    pub protocol: String,
    pub endpoint: String,
    pub status: Option<u16>,
    pub redirect_destination: Option<String>,
    pub title: Option<String>,
    pub server: Option<String>,
    pub technologies: Vec<Technology>,
    pub admin_interfaces: Vec<String>,
    pub tls: Option<TlsResult>,
    pub body_truncated: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub finding_id: String,
    pub title: String,
    pub severity: Severity,
    pub status: FindingStatus,
    pub exposure_status: Option<ExposureStatus>,
    pub device_ip: String,
    pub hostname: Option<String>,
    pub port: u16,
    pub protocol: String,
    pub product: String,
    pub detected_version: Option<String>,
    pub cve_ids: Vec<String>,
    pub confidence: Confidence,
    pub evidence: Vec<String>,
    pub description: String,
    pub remediation: String,
    pub references: Vec<String>,
    pub timestamp: String,
    pub score_category: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreFactor {
    pub finding_id: String,
    pub title: String,
    pub deduction: u8,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityScore {
    pub value: u8,
    pub factors: Vec<ScoreFactor>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAssessment {
    pub device_ip: String,
    pub hostname: Option<String>,
    pub services: Vec<WebService>,
    pub findings: Vec<Finding>,
    pub score: SecurityScore,
    pub assessed_at: String,
    pub complete: bool,
    pub coverage_notes: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssessmentRun {
    pub assessment_id: u64,
    pub scan_id: u64,
    pub mode: String,
    pub started_at: String,
    pub completed_at: String,
    pub cancelled: bool,
    pub devices: Vec<DeviceAssessment>,
}

use crate::security;
use security::SecurityAssessment;

fn without_synology_security_findings(mut assessment: SecurityAssessment) -> SecurityAssessment {
    assessment
        .findings
        .retain(|finding| !finding.id.starts_with("synology-"));
    assessment
}

#[tauri::command]
pub async fn security_assessment_v141(
    ip: String,
    open_ports: Vec<u16>,
) -> Result<SecurityAssessment, String> {
    security::security_assessment(ip, open_ports)
        .await
        .map(without_synology_security_findings)
}

#[tauri::command]
pub async fn website_security_assessment_v141(
    target: String,
) -> Result<SecurityAssessment, String> {
    security::website_security_assessment(target)
        .await
        .map(without_synology_security_findings)
}

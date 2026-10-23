use crate::{gitlab_security, security, synology_security};
use security::SecurityAssessment;

#[tauri::command]
pub async fn security_assessment_v141(
    ip: String,
    open_ports: Vec<u16>,
) -> Result<SecurityAssessment, String> {
    let mut assessment = security::security_assessment(ip, open_ports).await?;
    synology_security::enrich_network(&mut assessment).await;
    gitlab_security::enrich_network(&mut assessment).await;
    Ok(assessment)
}

#[tauri::command]
pub async fn website_security_assessment_v141(
    target: String,
) -> Result<SecurityAssessment, String> {
    let original_target = target.clone();
    let mut assessment = security::website_security_assessment(target).await?;
    synology_security::enrich_website(&mut assessment, &original_target).await;
    gitlab_security::enrich_website(&mut assessment, &original_target).await;
    Ok(assessment)
}

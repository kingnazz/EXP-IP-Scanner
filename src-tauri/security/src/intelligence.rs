use crate::models::*;
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

#[derive(Debug, Deserialize)]
pub struct VersionRange {
    pub branch: String,
    pub from_inclusive: String,
    pub patched_from: String,
}
#[derive(Debug, Deserialize)]
pub struct VulnerabilityDefinition {
    pub id: String,
    pub title: String,
    pub severity: Severity,
    pub affected_product: String,
    pub affected_versions: Vec<VersionRange>,
    pub cve_ids: Vec<String>,
    pub description: String,
    pub remediation: String,
    pub references: Vec<String>,
    pub detection_type: String,
    pub verified: bool,
    pub provenance: String,
}
#[derive(Deserialize)]
struct Catalog {
    schema_version: u32,
    definitions: Vec<VulnerabilityDefinition>,
}
pub fn definitions() -> &'static [VulnerabilityDefinition] {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    &CATALOG
        .get_or_init(|| {
            let c: Catalog =
                serde_json::from_str(include_str!("../intelligence/vulnerabilities.json"))
                    .expect("bundled intelligence must be valid");
            assert_eq!(c.schema_version, 1);
            c
        })
        .definitions
}
/// Strict numeric releases only. Distribution suffixes, prereleases and ambiguous
/// banners need vendor review and must never be ordered as ordinary releases.
pub fn version(value: &str) -> Option<[u32; 3]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}
pub fn classify(def: &VulnerabilityDefinition, php: Option<&Technology>) -> ExposureStatus {
    let Some(php) = php else {
        return ExposureStatus::NotApplicable;
    };
    let Some(v) = php.version.as_deref().and_then(version) else {
        return ExposureStatus::Unknown;
    };
    let Some(range) = def
        .affected_versions
        .iter()
        .find(|r| r.branch == format!("{}.{}", v[0], v[1]))
    else {
        return ExposureStatus::Unknown;
    };
    let (Some(start), Some(patch)) = (version(&range.from_inclusive), version(&range.patched_from))
    else {
        return ExposureStatus::Unknown;
    };
    if v >= patch {
        ExposureStatus::Patched
    } else if v >= start {
        if def.verified && php.confidence == Confidence::High {
            ExposureStatus::LikelyVulnerable
        } else {
            ExposureStatus::PossiblyVulnerable
        }
    } else {
        ExposureStatus::Unknown
    }
}
pub fn evaluate(target: &DeviceTarget, service: &WebService) -> Vec<Finding> {
    definitions().iter().filter(|d| d.detection_type == "exposed_version").map(|def| {
        let product = service.technologies.iter().find(|t| t.product == def.affected_product);
        let exposure = classify(def, product);
        let affected = matches!(exposure, ExposureStatus::PossiblyVulnerable | ExposureStatus::LikelyVulnerable);
        let mut f = finding(target, service, &def.id, &def.title, if affected { def.severity } else { Severity::Informational });
        f.status = match exposure { ExposureStatus::PossiblyVulnerable => FindingStatus::Possible, ExposureStatus::LikelyVulnerable => FindingStatus::Likely, ExposureStatus::Patched | ExposureStatus::NotApplicable => FindingStatus::NotAffected, _ => FindingStatus::Informational };
        f.exposure_status = Some(exposure);
        f.product = def.affected_product.clone(); f.detected_version = product.and_then(|t| t.version.clone());
        f.cve_ids = def.cve_ids.clone(); f.confidence = if def.verified { product.map_or(Confidence::Low, |p| p.confidence) } else { Confidence::Low };
        f.evidence = product.map_or_else(|| vec!["No PHP evidence in this response; absence does not prove PHP is absent.".into()], |p| p.evidence.clone());
        f.evidence.push(def.provenance.clone());
        if exposure == ExposureStatus::Patched { f.evidence.push("At or above the supplied branch threshold; vendor patch status is not verified.".into()); }
        f.description = def.description.clone(); f.remediation = def.remediation.clone(); f.references = def.references.clone(); f
    }).collect()
}
pub fn finding(
    target: &DeviceTarget,
    service: &WebService,
    id: &str,
    title: &str,
    severity: Severity,
) -> Finding {
    Finding {
        finding_id: format!("{}:{}:{}:{}", target.ip, service.port, service.protocol, id),
        title: title.into(),
        severity,
        status: FindingStatus::Informational,
        exposure_status: None,
        device_ip: target.ip.clone(),
        hostname: target.hostname.clone(),
        port: service.port,
        protocol: service.protocol.clone(),
        product: "Web service".into(),
        detected_version: None,
        cve_ids: vec![],
        confidence: Confidence::Medium,
        evidence: vec![],
        description: String::new(),
        remediation: String::new(),
        references: vec![],
        timestamp: chrono::Utc::now().to_rfc3339(),
        score_category: None,
    }
}
pub fn score(findings: &[Finding]) -> SecurityScore {
    static WEIGHTS: OnceLock<HashMap<String, u8>> = OnceLock::new();
    let weights = WEIGHTS.get_or_init(|| {
        serde_json::from_str(include_str!("../intelligence/scoring.json"))
            .expect("bundled score weights")
    });
    let mut seen = HashSet::new();
    let factors: Vec<_> = findings
        .iter()
        .filter(|f| {
            !matches!(
                f.status,
                FindingStatus::NotAffected | FindingStatus::Informational
            ) && seen.insert(&f.finding_id)
        })
        .filter_map(|f| {
            let key = f
                .score_category
                .clone()
                .unwrap_or_else(|| format!("{:?}", f.severity));
            let deduction = *weights.get(&key).unwrap_or(&0);
            (deduction > 0).then(|| ScoreFactor {
                finding_id: f.finding_id.clone(),
                title: f.title.clone(),
                deduction,
            })
        })
        .collect();
    let total: u32 = factors.iter().map(|f| u32::from(f.deduction)).sum();
    SecurityScore {
        value: 100u32.saturating_sub(total) as u8,
        factors,
    }
}

use std::collections::HashSet;

use tokio::process::Command;

use crate::security::{SecurityAssessment, SecurityFinding, WebServiceFingerprint};

const DSM_CVES: [&str; 2] = ["CVE-2026-13684", "CVE-2026-13639"];
const PHP2SHELL_CVES: [&str; 2] = ["CVE-2026-109618", "CVE-2026-109619"];
const MAX_BODY_CHARS: usize = 32 * 1024;

type HeaderPairs = Vec<(String, String)>;
type ParsedHttpResponse = (u16, HeaderPairs, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchStatus {
    Vulnerable,
    Patched,
    Unknown,
}

#[derive(Debug)]
struct SynologyProbe {
    dsm_version: Option<String>,
    php_package_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DsmVersion {
    major: u16,
    minor: u16,
    patch: u16,
    build: Option<u32>,
    update: Option<u16>,
}

pub(crate) async fn enrich_network(assessment: &mut SecurityAssessment) {
    let target = assessment.target.clone();
    let mut findings = Vec::new();
    let mut seen = HashSet::new();

    for service in &mut assessment.web_services {
        if service.status.is_none() || !is_synology_candidate(service) {
            continue;
        }

        let url = format!("{}://{}:{}/", service.scheme, target, service.port);
        let Some(probe) = probe_synology(&url).await else {
            continue;
        };

        apply_probe(service, &probe, &mut findings, &mut seen);
    }

    merge_findings(assessment, findings);
}

pub(crate) async fn enrich_website(assessment: &mut SecurityAssessment, input: &str) {
    let mut findings = Vec::new();
    let mut seen = HashSet::new();

    for service in &mut assessment.web_services {
        if service.status.is_none() {
            continue;
        }

        let url = url_for_service(input, &service.scheme);
        let Some(probe) = probe_synology(&url).await else {
            continue;
        };

        apply_probe(service, &probe, &mut findings, &mut seen);
    }

    merge_findings(assessment, findings);
}

fn apply_probe(
    service: &mut WebServiceFingerprint,
    probe: &SynologyProbe,
    findings: &mut Vec<SecurityFinding>,
    seen: &mut HashSet<String>,
) {
    service.product = Some(
        probe
            .dsm_version
            .as_deref()
            .map(|version| format!("Synology DSM {version}"))
            .unwrap_or_else(|| "Synology DSM".into()),
    );

    for finding in findings_for_service(service, probe) {
        if seen.insert(finding.id.clone()) {
            findings.push(finding);
        }
    }
}

fn findings_for_service(
    service: &WebServiceFingerprint,
    probe: &SynologyProbe,
) -> Vec<SecurityFinding> {
    let mut findings = vec![dsm_finding(service, probe.dsm_version.as_deref())];

    if let Some(php) = synology_php_finding(
        service,
        probe.php_package_version.as_deref(),
        service.php_version.as_deref(),
    ) {
        findings.push(php);
    }

    findings
}

fn merge_findings(assessment: &mut SecurityAssessment, findings: Vec<SecurityFinding>) {
    let mut existing: HashSet<String> = assessment
        .findings
        .iter()
        .map(|finding| finding.id.clone())
        .collect();

    for finding in findings {
        if existing.insert(finding.id.clone()) {
            assessment.findings.push(finding);
        }
    }

    if assessment
        .findings
        .iter()
        .any(|finding| finding.severity == "critical")
    {
        assessment.status = "critical".into();
        assessment.summary = "Critical web or Synology security finding detected. Review the affected product/version and patch immediately.".into();
    } else if assessment
        .findings
        .iter()
        .any(|finding| finding.severity == "high")
    {
        assessment.status = "attention".into();
        assessment.summary = "A detected web runtime or Synology system needs patch verification. The passive check could not prove a safe patch level.".into();
    }
}

fn dsm_finding(service: &WebServiceFingerprint, version: Option<&str>) -> SecurityFinding {
    let endpoint = format!("{} service on port {}", service.scheme, service.port);

    let Some(version) = version else {
        return SecurityFinding {
            id: "synology-dsm-version-hidden".into(),
            severity: "high".into(),
            title: "Synology DSM detected; critical DSM patch level unknown".into(),
            summary: "This service is confirmed as Synology DSM, but the exact DSM build was not exposed. A passive scan cannot determine whether the September 2026 critical DSM fixes are installed.".into(),
            evidence: format!("{endpoint} returned Synology DSM-specific web/API indicators, but no reliable DSM build number was exposed."),
            remediation: "Open DSM Update & Restore and install the latest DSM update. For Synology-SA-26:13, the minimum fixed releases are DSM 7.4-90075, 7.3.2-86009-4, 7.2.2-72806-9, and 7.2.1-69057-12.".into(),
            cves: DSM_CVES.iter().map(|cve| (*cve).into()).collect(),
        };
    };

    match parse_dsm_version(version)
        .map(classify_dsm)
        .unwrap_or(PatchStatus::Unknown)
    {
        PatchStatus::Vulnerable => SecurityFinding {
            id: format!("synology-dsm-critical-{version}"),
            severity: "critical".into(),
            title: format!("Synology DSM {version} is below the critical DSM security fix"),
            summary: "The disclosed DSM version falls below Synology's fixed release for critical unauthenticated DSM vulnerabilities, including two CVSS 9.8 issues.".into(),
            evidence: format!("{endpoint} was confirmed as Synology DSM and disclosed version {version}."),
            remediation: "Update DSM immediately. Minimum fixed releases are DSM 7.4-90075, 7.3.2-86009-4, 7.2.2-72806-9, and 7.2.1-69057-12. Prefer the newest supported DSM update for the device.".into(),
            cves: DSM_CVES.iter().map(|cve| (*cve).into()).collect(),
        },
        PatchStatus::Patched => SecurityFinding {
            id: format!("synology-dsm-patched-{version}"),
            severity: "info".into(),
            title: format!("Synology DSM {version} includes the September critical DSM fix"),
            summary: "The disclosed DSM build is at or above Synology's fixed release for Synology-SA-26:13.".into(),
            evidence: format!("{endpoint} was confirmed as Synology DSM and disclosed version {version}."),
            remediation: "No action is indicated for Synology-SA-26:13 from the disclosed DSM build. Continue normal DSM patching and stay on the latest supported release.".into(),
            cves: DSM_CVES.iter().map(|cve| (*cve).into()).collect(),
        },
        PatchStatus::Unknown => SecurityFinding {
            id: format!("synology-dsm-review-{version}"),
            severity: "high".into(),
            title: format!("Synology DSM {version} requires manual security verification"),
            summary: "Synology DSM was identified, but the exposed version is incomplete or outside the release branches EXP IP Scanner can safely classify from Synology's advisory.".into(),
            evidence: format!("{endpoint} was confirmed as Synology DSM and disclosed version {version}."),
            remediation: "Compare the installed DSM build with Synology-SA-26:13 and update to the latest supported DSM release.".into(),
            cves: DSM_CVES.iter().map(|cve| (*cve).into()).collect(),
        },
    }
}

fn synology_php_finding(
    service: &WebServiceFingerprint,
    package_version: Option<&str>,
    exposed_php: Option<&str>,
) -> Option<SecurityFinding> {
    let version = package_version.or(exposed_php)?;
    let endpoint = format!("{} service on port {}", service.scheme, service.port);
    let parsed = parse_php_package_version(version)?;
    let status = classify_synology_php(parsed, package_version.is_some());
    let cves = PHP2SHELL_CVES.iter().map(|cve| (*cve).into()).collect();

    Some(match status {
        PatchStatus::Vulnerable => SecurityFinding {
            id: format!("synology-php2shell-critical-{version}"),
            severity: "critical".into(),
            title: format!("Synology PHP {version} is below the PHP2Shell package fix"),
            summary: "Synology's October 22 PHP2Shell advisory rates susceptible PHP packages Critical because the vulnerabilities can allow remote code execution through PHP-dependent packages.".into(),
            evidence: format!("{endpoint} on a confirmed Synology system exposed PHP version {version}."),
            remediation: "Update the PHP package immediately in Synology Package Center. Also update Synology Calendar and Mail Station if installed. PHP 7.3 has no fixed Synology package and should be retired or the dependent package disabled.".into(),
            cves,
        },
        PatchStatus::Patched => SecurityFinding {
            id: format!("synology-php2shell-patched-{version}"),
            severity: "info".into(),
            title: format!("Synology PHP {version} is at or above the PHP2Shell package fix"),
            summary: "The exposed Synology PHP package version is at or above the fixed package release listed in Synology-SA-26:14.".into(),
            evidence: format!("{endpoint} on a confirmed Synology system exposed PHP package version {version}."),
            remediation: "No action is indicated for PHP2Shell from the exposed Synology package version. Continue normal Package Center updates.".into(),
            cves,
        },
        PatchStatus::Unknown => SecurityFinding {
            id: format!("synology-php2shell-review-{version}"),
            severity: "high".into(),
            title: format!("Synology PHP {version} needs Package Center patch verification"),
            summary: "The PHP runtime is on a Synology system, but the passive response did not expose enough Synology package revision detail to prove that the PHP2Shell package update is installed.".into(),
            evidence: format!("{endpoint} exposed PHP {version}, but the Synology package revision was not reliably available."),
            remediation: "Verify the installed PHP package in Synology Package Center and update it now if an update is offered. Fixed package releases include PHP 7.4.33-0131, 8.0.30-0122, 8.1.34-0120, 8.2.35-0171, 8.3.36-0051, and 8.4.27-0051.".into(),
            cves,
        },
    })
}

async fn probe_synology(url: &str) -> Option<SynologyProbe> {
    let root = fetch(url).await?;
    let mut confirmed = looks_like_synology(&root.1, &root.2);
    let mut dsm_version = extract_dsm_version(&root.2);
    let mut php_package_version = extract_php_package_version(&root.1, &root.2);

    if let Some(origin) = origin_url(url) {
        let api_url = format!(
            "{origin}/webapi/entry.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth"
        );
        if let Some((status, headers, body)) = fetch(&api_url).await {
            if status == 200 && looks_like_synology_api(&body) {
                confirmed = true;
            }
            dsm_version = dsm_version.or_else(|| extract_dsm_version(&body));
            php_package_version = php_package_version
                .or_else(|| extract_php_package_version(&headers, &body));
        }
    }

    confirmed.then_some(SynologyProbe {
        dsm_version,
        php_package_version,
    })
}

async fn fetch(url: &str) -> Option<ParsedHttpResponse> {
    let mut command = Command::new(curl_binary());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .args([
            "--insecure",
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            "4",
            "--connect-timeout",
            "3",
            "--max-redirs",
            "2",
            "--range",
            "0-32767",
            "--max-filesize",
            "32768",
            "--include",
            "--user-agent",
            "EXP-IP-Scanner/1.4.1 passive-security-assessment",
            url,
        ])
        .output()
        .await
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_http_output(&stdout)
}

fn parse_http_output(raw: &str) -> Option<ParsedHttpResponse> {
    let normalized = raw.replace("\r\n", "\n");
    let parts: Vec<&str> = normalized.split("\n\n").collect();
    let mut last_header_index = None;
    let mut status = None;
    let mut headers = Vec::new();

    for (index, block) in parts.iter().enumerate() {
        let mut lines = block.lines();
        let Some(first) = lines.next() else {
            continue;
        };
        let first = first.trim();
        if !first.starts_with("HTTP/") {
            if last_header_index.is_some() {
                break;
            }
            continue;
        }

        status = first
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse().ok());
        headers = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect();
        last_header_index = Some(index);
    }

    let header_index = last_header_index?;
    let status = status?;
    let body = parts
        .iter()
        .skip(header_index + 1)
        .copied()
        .collect::<Vec<_>>()
        .join("\n\n");

    Some((status, headers, truncate(&body, MAX_BODY_CHARS)))
}

fn is_synology_candidate(service: &WebServiceFingerprint) -> bool {
    service.port == 5000
        || service.port == 5001
        || service
            .product
            .as_deref()
            .is_some_and(|product| product.to_ascii_lowercase().contains("synology"))
}

fn looks_like_synology(headers: &[(String, String)], body: &str) -> bool {
    if headers.iter().any(|(name, value)| {
        name.starts_with("x-syno") || value.to_ascii_lowercase().contains("synology")
    }) {
        return true;
    }

    let lower = body.to_ascii_lowercase();
    lower.contains("synology")
        && (lower.contains("webman")
            || lower.contains("diskstation")
            || lower.contains("rackstation")
            || lower.contains("dsm"))
}

fn looks_like_synology_api(body: &str) -> bool {
    let compact: String = body.chars().filter(|ch| !ch.is_whitespace()).collect();
    let lower = compact.to_ascii_lowercase();
    lower.contains("syno.api.auth") && lower.contains("\"success\":true")
}

fn extract_dsm_version(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    for marker in ["dsm version ", "dsm ", "dsm_version\"", "dsm-version\""] {
        let mut offset = 0;
        while let Some(found) = lower[offset..].find(marker) {
            let start = offset + found + marker.len();
            if let Some(candidate) = numeric_version_after(body, start) {
                if parse_dsm_version(&candidate).is_some() {
                    return Some(candidate);
                }
            }
            offset = start;
            if offset >= body.len() {
                break;
            }
        }
    }
    None
}

fn extract_php_package_version(headers: &[(String, String)], body: &str) -> Option<String> {
    for value in headers.iter().map(|(_, value)| value.as_str()) {
        if let Some(version) = extract_php_package_version_from_text(value) {
            return Some(version);
        }
    }
    extract_php_package_version_from_text(body)
}

fn extract_php_package_version_from_text(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    for marker in ["php/", "php "] {
        let mut offset = 0;
        while let Some(found) = lower[offset..].find(marker) {
            let start = offset + found + marker.len();
            if let Some(candidate) = numeric_version_after(value, start) {
                if candidate.contains('-') && parse_php_package_version(&candidate).is_some() {
                    return Some(candidate);
                }
            }
            offset = start;
            if offset >= value.len() {
                break;
            }
        }
    }
    None
}

fn numeric_version_after(value: &str, start: usize) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = start;
    while index < bytes.len() && !bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index >= bytes.len() {
        return None;
    }

    let candidate: String = value[index..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-'))
        .take(40)
        .collect();
    let candidate = candidate.trim_end_matches(|ch| ch == '.' || ch == '-');
    (!candidate.is_empty()).then(|| candidate.to_string())
}

fn parse_dsm_version(version: &str) -> Option<DsmVersion> {
    let mut dash = version.split('-');
    let core = dash.next()?;
    let build = dash.next().and_then(|value| value.parse().ok());
    let update = dash.next().and_then(|value| value.parse().ok());

    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;

    Some(DsmVersion {
        major,
        minor,
        patch,
        build,
        update,
    })
}

fn classify_dsm(version: DsmVersion) -> PatchStatus {
    if version.major != 7 {
        return PatchStatus::Unknown;
    }

    match version.minor {
        0 | 1 => PatchStatus::Vulnerable,
        2 => match version.patch {
            0 => PatchStatus::Vulnerable,
            1 => compare_build(version, 69_057, 12),
            2 => compare_build(version, 72_806, 9),
            _ => PatchStatus::Patched,
        },
        3 => {
            if version.patch < 2 {
                PatchStatus::Vulnerable
            } else if version.patch == 2 {
                compare_build(version, 86_009, 4)
            } else {
                PatchStatus::Patched
            }
        }
        4 => compare_build(version, 90_075, 0),
        _ => PatchStatus::Unknown,
    }
}

fn compare_build(version: DsmVersion, fixed_build: u32, fixed_update: u16) -> PatchStatus {
    let Some(build) = version.build else {
        return PatchStatus::Unknown;
    };

    if build < fixed_build {
        return PatchStatus::Vulnerable;
    }
    if build > fixed_build {
        return PatchStatus::Patched;
    }
    if fixed_update == 0 {
        return PatchStatus::Patched;
    }

    match version.update {
        Some(update) if update < fixed_update => PatchStatus::Vulnerable,
        Some(_) => PatchStatus::Patched,
        None => PatchStatus::Unknown,
    }
}

fn parse_php_package_version(version: &str) -> Option<(u16, u16, u16, Option<u32>)> {
    let (core, revision) = version
        .split_once('-')
        .map(|(core, revision)| (core, revision.parse().ok()))
        .unwrap_or((version, None));
    let mut parts = core.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next().unwrap_or("0").parse().ok()?,
        revision,
    ))
}

fn classify_synology_php(
    (major, minor, patch, revision): (u16, u16, u16, Option<u32>),
    exact_package_revision: bool,
) -> PatchStatus {
    let (fixed_patch, fixed_revision) = match (major, minor) {
        (7, 3) => return PatchStatus::Vulnerable,
        (7, 4) => (33, 131),
        (8, 0) => (30, 122),
        (8, 1) => (34, 120),
        (8, 2) => (35, 171),
        (8, 3) => (36, 51),
        (8, 4) => (27, 51),
        _ => return PatchStatus::Unknown,
    };

    if patch < fixed_patch {
        return PatchStatus::Vulnerable;
    }
    if patch > fixed_patch {
        return PatchStatus::Patched;
    }
    if !exact_package_revision {
        return PatchStatus::Unknown;
    }

    match revision {
        Some(value) if value >= fixed_revision => PatchStatus::Patched,
        Some(_) => PatchStatus::Vulnerable,
        None => PatchStatus::Unknown,
    }
}

fn url_for_service(input: &str, scheme: &str) -> String {
    let trimmed = input.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("{scheme}://{trimmed}")
    }
}

fn origin_url(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let authority_start = scheme_end + 3;
    let authority_end = url[authority_start..]
        .find('/')
        .map(|offset| authority_start + offset)
        .unwrap_or(url.len());
    Some(url[..authority_end].to_string())
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn curl_binary() -> &'static str {
    if cfg!(windows) {
        "curl.exe"
    } else {
        "curl"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_synology_dsm_fixed_builds() {
        assert_eq!(
            classify_dsm(parse_dsm_version("7.4-90074").unwrap()),
            PatchStatus::Vulnerable
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.4-90075").unwrap()),
            PatchStatus::Patched
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.3.2-86009-3").unwrap()),
            PatchStatus::Vulnerable
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.3.2-86009-4").unwrap()),
            PatchStatus::Patched
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.2.2-72806-8").unwrap()),
            PatchStatus::Vulnerable
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.2.2-72806-9").unwrap()),
            PatchStatus::Patched
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.2.1-69057-11").unwrap()),
            PatchStatus::Vulnerable
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.2.1-69057-12").unwrap()),
            PatchStatus::Patched
        );
    }

    #[test]
    fn incomplete_dsm_builds_are_not_called_safe() {
        assert_eq!(
            classify_dsm(parse_dsm_version("7.4").unwrap()),
            PatchStatus::Unknown
        );
        assert_eq!(
            classify_dsm(parse_dsm_version("7.3.2-86009").unwrap()),
            PatchStatus::Unknown
        );
    }

    #[test]
    fn classifies_synology_php_package_thresholds() {
        assert_eq!(
            classify_synology_php(parse_php_package_version("8.2.35-0170").unwrap(), true),
            PatchStatus::Vulnerable
        );
        assert_eq!(
            classify_synology_php(parse_php_package_version("8.2.35-0171").unwrap(), true),
            PatchStatus::Patched
        );
        assert_eq!(
            classify_synology_php(parse_php_package_version("8.2.35").unwrap(), false),
            PatchStatus::Unknown
        );
        assert_eq!(
            classify_synology_php(parse_php_package_version("8.3.37").unwrap(), false),
            PatchStatus::Patched
        );
        assert_eq!(
            classify_synology_php(parse_php_package_version("7.3.33-9999").unwrap(), true),
            PatchStatus::Vulnerable
        );
    }

    #[test]
    fn confirms_the_public_synology_api_shape() {
        assert!(looks_like_synology_api(
            r#"{"data":{"SYNO.API.Auth":{"maxVersion":7,"minVersion":1,"path":"entry.cgi"}},"success":true}"#
        ));
    }

    #[test]
    fn extracts_common_dsm_version_strings() {
        assert_eq!(
            extract_dsm_version("Synology DSM 7.2.2-72806-9"),
            Some("7.2.2-72806-9".into())
        );
        assert_eq!(
            extract_dsm_version("DSM Version 7.4-90075"),
            Some("7.4-90075".into())
        );
    }
}
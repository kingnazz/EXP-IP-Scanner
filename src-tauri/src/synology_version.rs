use tokio::process::Command;

use crate::security::{SecurityAssessment, SecurityFinding, WebServiceFingerprint};

const DSM_CVES: [&str; 2] = ["CVE-2026-13684", "CVE-2026-13639"];
const MAX_BODY_CHARS: usize = 16 * 1024;

type HeaderPairs = Vec<(String, String)>;
type ParsedHttpResponse = (u16, HeaderPairs, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchStatus {
    Vulnerable,
    Patched,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DsmDiscovery {
    major: u16,
    minor: u16,
    build: u32,
    smallfix: Option<u16>,
    product_version: Option<String>,
}

pub(crate) async fn enrich_network(assessment: &mut SecurityAssessment) {
    let target = assessment.target.clone();
    let services: Vec<(u16, String)> = assessment
        .web_services
        .iter()
        .filter(|service| confirmed_synology(service))
        .map(|service| (service.port, service.scheme.clone()))
        .collect();

    for (port, scheme) in services {
        let url = format!("{scheme}://{target}:{port}/webman/info.cgi?host=");
        let Some(discovery) = discover(&url).await else {
            continue;
        };

        apply_discovery(assessment, port, &discovery);
    }
}

pub(crate) async fn enrich_website(assessment: &mut SecurityAssessment, input: &str) {
    let services: Vec<(u16, String)> = assessment
        .web_services
        .iter()
        .filter(|service| confirmed_synology(service))
        .map(|service| (service.port, service.scheme.clone()))
        .collect();

    for (port, scheme) in services {
        let Some(origin) = origin_for_input(input, &scheme, port) else {
            continue;
        };
        let url = format!("{origin}/webman/info.cgi?host=");
        let Some(discovery) = discover(&url).await else {
            continue;
        };

        apply_discovery(assessment, port, &discovery);
    }
}

fn confirmed_synology(service: &WebServiceFingerprint) -> bool {
    service.status.is_some()
        && service
            .product
            .as_deref()
            .is_some_and(|product| product.to_ascii_lowercase().contains("synology"))
}

async fn discover(url: &str) -> Option<DsmDiscovery> {
    let (status, _, body) = fetch(url).await?;
    if status != 200 {
        return None;
    }
    parse_info_response(&body)
}

fn apply_discovery(assessment: &mut SecurityAssessment, port: u16, discovery: &DsmDiscovery) {
    let display = display_version(discovery);

    if let Some(service) = assessment
        .web_services
        .iter_mut()
        .find(|service| service.port == port)
    {
        service.product = Some(format!("Synology DSM {display}"));
        service.note = Some("DSM build discovered passively from Synology web metadata.".into());
    }

    // The initial Synology pass may only know that DSM is present, or may have
    // seen incomplete version metadata. Once info.cgi gives us a definitive
    // build, remove those stale DSM-version findings before adding the stronger
    // result. Other findings, such as PHP/package warnings, remain untouched.
    assessment.findings.retain(|finding| {
        !finding.id.starts_with("synology-dsm-version-hidden")
            && !finding.id.starts_with("synology-dsm-review-")
            && !finding.id.starts_with("synology-dsm-critical-")
            && !finding.id.starts_with("synology-dsm-patched-")
            && !finding.id.starts_with("synology-dsm-build-review-")
    });

    let finding = build_finding(discovery, port);
    if !assessment.findings.iter().any(|item| item.id == finding.id) {
        assessment.findings.push(finding);
    }

    refresh_summary(assessment);
}

fn build_finding(discovery: &DsmDiscovery, port: u16) -> SecurityFinding {
    let display = display_version(discovery);
    let endpoint = format!("Synology DSM management service on port {port}");
    let cves = DSM_CVES.iter().map(|cve| (*cve).into()).collect();

    match classify(discovery) {
        PatchStatus::Vulnerable => SecurityFinding {
            id: format!(
                "synology-dsm-critical-{}-{}",
                discovery.build,
                discovery.smallfix.unwrap_or(0)
            ),
            severity: "critical".into(),
            title: format!("Synology DSM {display} is below the critical DSM security fix"),
            summary: "The passively discovered DSM build is below Synology's fixed release for the critical DSM vulnerabilities covered by Synology-SA-26:13.".into(),
            evidence: format!("{endpoint} exposed DSM build metadata identifying {display}."),
            remediation: "Update DSM immediately from Control Panel > Update & Restore. Minimum fixed releases are DSM 7.4-90075, 7.3.2-86009-4, 7.2.2-72806-9, and 7.2.1-69057-12.".into(),
            cves,
        },
        PatchStatus::Patched => SecurityFinding {
            id: format!(
                "synology-dsm-patched-{}-{}",
                discovery.build,
                discovery.smallfix.unwrap_or(0)
            ),
            severity: "info".into(),
            title: format!("Synology DSM {display} is at or above the critical DSM fix"),
            summary: "The passively discovered DSM build is at or above the fixed release EXP IP Scanner can verify for Synology-SA-26:13.".into(),
            evidence: format!("{endpoint} exposed DSM build metadata identifying {display}."),
            remediation: "No action is indicated for Synology-SA-26:13 from the discovered build. Continue normal DSM patching and stay on the latest supported release.".into(),
            cves,
        },
        PatchStatus::Unknown => SecurityFinding {
            id: format!(
                "synology-dsm-build-review-{}-{}",
                discovery.build,
                discovery.smallfix.unwrap_or(0)
            ),
            severity: "high".into(),
            title: format!("Synology DSM {display} needs update-level verification"),
            summary: "EXP IP Scanner discovered the DSM build, but Synology did not expose enough update-level detail to prove whether this exact build contains the critical fix.".into(),
            evidence: format!("{endpoint} exposed DSM build metadata identifying {display}, but the required small-fix/update number was not available or the branch could not be classified safely."),
            remediation: "Open Control Panel > Update & Restore and compare the full DSM version with Synology-SA-26:13. Install the latest DSM update if offered.".into(),
            cves,
        },
    }
}

fn refresh_summary(assessment: &mut SecurityAssessment) {
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
    } else {
        assessment.status = "clear".into();
        assessment.summary = "No critical or high-severity finding was identified by the passive web and Synology security checks.".into();
    }
}

fn parse_info_response(body: &str) -> Option<DsmDiscovery> {
    let major = numeric_param(body, "major")?.parse().ok()?;
    let minor = numeric_param(body, "minor")?.parse().ok()?;
    let build = numeric_param(body, "build")?.parse().ok()?;
    let smallfix = numeric_param(body, "smallfixnumber").and_then(|value| value.parse().ok());
    let product_version = version_param(body, "version")
        .filter(|value| value.chars().all(|ch| ch.is_ascii_digit() || ch == '.'));

    Some(DsmDiscovery {
        major,
        minor,
        build,
        smallfix,
        product_version,
    })
}

fn numeric_param<'a>(body: &'a str, key: &str) -> Option<&'a str> {
    let marker = format!("{key}=");
    let lower = body.to_ascii_lowercase();
    let start = lower.find(&marker)? + marker.len();
    let value = &body[start..];
    let end = value
        .find(|ch: char| !ch.is_ascii_digit())
        .unwrap_or(value.len());
    (end > 0).then(|| &value[..end])
}

fn version_param(body: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=");
    let lower = body.to_ascii_lowercase();
    let start = lower.find(&marker)? + marker.len();
    let value = &body[start..];
    let end = value
        .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .unwrap_or(value.len());
    (end > 0).then(|| value[..end].to_string())
}

fn display_version(discovery: &DsmDiscovery) -> String {
    let core = discovery
        .product_version
        .clone()
        .unwrap_or_else(|| format!("{}.{}", discovery.major, discovery.minor));
    match discovery.smallfix {
        Some(update) if update > 0 => format!("{core}-{}-{update}", discovery.build),
        _ => format!("{core}-{}", discovery.build),
    }
}

fn classify(discovery: &DsmDiscovery) -> PatchStatus {
    if discovery.major != 7 {
        return PatchStatus::Unknown;
    }

    let patch = discovery
        .product_version
        .as_deref()
        .and_then(|version| version.split('.').nth(2))
        .and_then(|value| value.parse::<u16>().ok());

    match discovery.minor {
        0 | 1 => PatchStatus::Vulnerable,
        2 => match patch {
            Some(0) => PatchStatus::Vulnerable,
            Some(1) => compare_build(discovery, 69_057, 12),
            Some(2) => compare_build(discovery, 72_806, 9),
            Some(_) => PatchStatus::Patched,
            None => {
                if discovery.build < 69_057 {
                    PatchStatus::Vulnerable
                } else if discovery.build == 69_057 {
                    compare_build(discovery, 69_057, 12)
                } else if discovery.build < 72_806 {
                    PatchStatus::Unknown
                } else if discovery.build == 72_806 {
                    compare_build(discovery, 72_806, 9)
                } else {
                    PatchStatus::Patched
                }
            }
        },
        3 => match patch {
            Some(value) if value < 2 => PatchStatus::Vulnerable,
            Some(2) => compare_build(discovery, 86_009, 4),
            Some(_) => PatchStatus::Patched,
            None => compare_build(discovery, 86_009, 4),
        },
        4 => compare_build(discovery, 90_075, 0),
        _ => PatchStatus::Unknown,
    }
}

fn compare_build(discovery: &DsmDiscovery, fixed_build: u32, fixed_update: u16) -> PatchStatus {
    if discovery.build < fixed_build {
        return PatchStatus::Vulnerable;
    }
    if discovery.build > fixed_build || fixed_update == 0 {
        return PatchStatus::Patched;
    }

    match discovery.smallfix {
        Some(update) if update < fixed_update => PatchStatus::Vulnerable,
        Some(_) => PatchStatus::Patched,
        None => PatchStatus::Unknown,
    }
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
            "--max-time",
            "3",
            "--connect-timeout",
            "2",
            "--max-redirs",
            "0",
            "--range",
            "0-16383",
            "--max-filesize",
            "16384",
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
    let (headers_raw, body) = normalized.split_once("\n\n")?;
    let mut lines = headers_raw.lines();
    let status = lines
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    let body: String = body.chars().take(MAX_BODY_CHARS).collect();
    Some((status, headers, body))
}

fn origin_for_input(input: &str, fallback_scheme: &str, fallback_port: u16) -> Option<String> {
    let trimmed = input.trim();
    let with_scheme = if trimmed.to_ascii_lowercase().starts_with("http://")
        || trimmed.to_ascii_lowercase().starts_with("https://")
    {
        trimmed.to_string()
    } else {
        format!("{fallback_scheme}://{trimmed}")
    };

    let (scheme, rest) = with_scheme.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?.trim();
    if authority.is_empty() {
        return None;
    }

    let has_explicit_port = authority
        .rsplit_once(':')
        .is_some_and(|(_, value)| value.parse::<u16>().is_ok());
    if has_explicit_port
        || (scheme == "https" && fallback_port == 443)
        || (scheme == "http" && fallback_port == 80)
    {
        Some(format!("{scheme}://{authority}"))
    } else {
        Some(format!("{scheme}://{authority}:{fallback_port}"))
    }
}

#[cfg(windows)]
fn curl_binary() -> &'static str {
    "curl.exe"
}

#[cfg(not(windows))]
fn curl_binary() -> &'static str {
    "curl"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_classic_info_cgi_metadata() {
        let result = parse_info_response("major=7&minor=2&build=72806&junior=0&unique=synology_x86_123&smallfixnumber=9&version=7.2.2").unwrap();
        assert_eq!(result.major, 7);
        assert_eq!(result.minor, 2);
        assert_eq!(result.build, 72_806);
        assert_eq!(result.smallfix, Some(9));
        assert_eq!(result.product_version.as_deref(), Some("7.2.2"));
        assert_eq!(classify(&result), PatchStatus::Patched);
    }

    #[test]
    fn exact_fixed_build_without_update_stays_unknown() {
        let result = parse_info_response("major=7&minor=2&build=72806&junior=0").unwrap();
        assert_eq!(classify(&result), PatchStatus::Unknown);
    }

    #[test]
    fn older_discovered_build_is_critical() {
        let result = parse_info_response("major=7&minor=2&build=69000&junior=0").unwrap();
        assert_eq!(classify(&result), PatchStatus::Vulnerable);
    }

    #[test]
    fn dsm_74_fixed_build_is_patched_without_smallfix() {
        let result = parse_info_response("major=7&minor=4&build=90075&junior=0").unwrap();
        assert_eq!(classify(&result), PatchStatus::Patched);
    }

    #[test]
    fn discovered_patched_build_clears_stale_version_warning() {
        let mut assessment = SecurityAssessment {
            target: "192.0.2.10".into(),
            checked_at: "test".into(),
            status: "attention".into(),
            summary: "Needs review".into(),
            web_services: vec![WebServiceFingerprint {
                port: 5001,
                scheme: "https".into(),
                status: Some(200),
                server: Some("nginx".into()),
                powered_by: None,
                php_version: None,
                product: Some("Synology DSM".into()),
                title: None,
                note: None,
            }],
            findings: vec![SecurityFinding {
                id: "synology-dsm-version-hidden".into(),
                severity: "high".into(),
                title: "Hidden DSM version".into(),
                summary: "Needs review".into(),
                evidence: "Synology detected".into(),
                remediation: "Check DSM".into(),
                cves: DSM_CVES.iter().map(|cve| (*cve).into()).collect(),
            }],
        };
        let discovery = parse_info_response("major=7&minor=4&build=90080&junior=0&version=7.4").unwrap();

        apply_discovery(&mut assessment, 5001, &discovery);

        assert_eq!(assessment.status, "clear");
        assert!(assessment
            .findings
            .iter()
            .all(|finding| finding.severity != "high"));
        assert!(assessment
            .findings
            .iter()
            .any(|finding| finding.id.starts_with("synology-dsm-patched-")));
    }
}

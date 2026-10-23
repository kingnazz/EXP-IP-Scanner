use std::collections::HashSet;

use tokio::process::Command;

use crate::security::{SecurityAssessment, SecurityFinding, WebServiceFingerprint};

const CVE: &str = "CVE-2026-110264";
const MAX_BODY_CHARS: usize = 32 * 1024;

type HeaderPairs = Vec<(String, String)>;
type HttpResponse = (u16, HeaderPairs, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchStatus {
    Vulnerable,
    Patched,
    Unknown,
}

#[derive(Debug)]
struct GitLabProbe {
    version: Option<String>,
}

pub(crate) async fn enrich_network(assessment: &mut SecurityAssessment) {
    let target = assessment.target.clone();
    let mut findings = Vec::new();
    let mut seen = HashSet::new();
    let mut disclosed_version = false;

    for service in &mut assessment.web_services {
        if service.status.is_none() {
            continue;
        }

        let url = format!("{}://{}:{}/", service.scheme, target, service.port);
        if let Some(probe) = probe_gitlab(&url).await {
            let product = product_label(probe.version.as_deref());
            service.product = Some(product.clone());
            disclosed_version |= probe.version.is_some();

            let finding = finding(&product, service, false);
            if seen.insert(finding.id.clone()) {
                findings.push(finding);
            }
        }
    }

    merge_findings(assessment, findings, disclosed_version);
}

pub(crate) async fn enrich_website(assessment: &mut SecurityAssessment, input: &str) {
    let managed_gitlab_com = host_from_input(input).as_deref() == Some("gitlab.com");
    let mut findings = Vec::new();
    let mut seen = HashSet::new();
    let mut disclosed_version = false;

    for service in &mut assessment.web_services {
        if service.status.is_none() {
            continue;
        }

        let url = url_for_service(input, &service.scheme);
        if let Some(probe) = probe_gitlab(&url).await {
            let product = product_label(probe.version.as_deref());
            service.product = Some(product.clone());
            disclosed_version |= probe.version.is_some();

            let finding = finding(&product, service, managed_gitlab_com);
            if seen.insert(finding.id.clone()) {
                findings.push(finding);
            }
        }
    }

    merge_findings(assessment, findings, disclosed_version);
}

fn merge_findings(
    assessment: &mut SecurityAssessment,
    mut findings: Vec<SecurityFinding>,
    disclosed_version: bool,
) {
    if disclosed_version {
        findings.retain(|finding| finding.id != "gitlab-rce-version-hidden");
    }

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

    refresh_summary(assessment);
}

fn refresh_summary(assessment: &mut SecurityAssessment) {
    if assessment
        .findings
        .iter()
        .any(|finding| finding.severity == "critical")
    {
        assessment.status = "critical".into();
        assessment.summary =
            "Critical web exposure indicator found. Review the affected product/version and patch immediately."
                .into();
        return;
    }

    if assessment
        .findings
        .iter()
        .any(|finding| finding.severity == "high")
    {
        assessment.status = "attention".into();
        assessment.summary = "A detected web runtime or product needs patch verification. The passive check could not prove a safe patch level.".into();
        return;
    }

    if assessment.status == "clear"
        && assessment
            .findings
            .iter()
            .any(|finding| !finding.cves.is_empty())
    {
        assessment.summary = "No affected version was identified in the disclosed versions covered by the current PHP and GitLab security rules.".into();
    }
}

async fn probe_gitlab(url: &str) -> Option<GitLabProbe> {
    let response = fetch(url).await?;
    if !looks_like_gitlab(&response.1, &response.2) {
        return None;
    }

    let mut version = extract_version(&response.2);
    if version.is_none() {
        if let Some(origin) = origin_url(url) {
            let version_url = format!("{origin}/api/v4/version");
            if let Some((status, _, body)) = fetch(&version_url).await {
                if status == 200 {
                    version = extract_version(&body);
                }
            }
        }
    }

    Some(GitLabProbe { version })
}

async fn fetch(url: &str) -> Option<HttpResponse> {
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

fn parse_http_output(raw: &str) -> Option<HttpResponse> {
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

fn looks_like_gitlab(headers: &[(String, String)], body: &str) -> bool {
    if headers.iter().any(|(name, value)| {
        name == "x-gitlab-meta"
            || name.starts_with("x-gitlab-")
            || (name == "set-cookie" && value.to_ascii_lowercase().contains("_gitlab_session"))
    }) {
        return true;
    }

    let lower = body.to_ascii_lowercase();
    if !lower.contains("gitlab") {
        return false;
    }

    lower.contains("gitlab-logo")
        || lower.contains("/users/sign_in")
        || lower.contains("/assets/gitlab")
        || lower.contains("gon.gitlab")
        || lower.contains("gitlab community edition")
        || lower.contains("gitlab enterprise edition")
        || lower.contains("· gitlab</title>")
        || lower.contains(">gitlab</title>")
}

fn extract_version(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();

    if lower.contains("\"revision\"") || lower.contains("\"enterprise\"") {
        if let Some(value) = value_after_marker(body, &lower, "\"version\"") {
            return Some(value);
        }
    }

    for marker in [
        "gitlab version ",
        "gitlab community edition ",
        "gitlab enterprise edition ",
        "gitlab ce ",
        "gitlab ee ",
    ] {
        if let Some(value) = value_after_marker(body, &lower, marker) {
            return Some(value);
        }
    }

    None
}

fn value_after_marker(original: &str, lower: &str, marker: &str) -> Option<String> {
    let start = lower.find(marker)? + marker.len();
    let bytes = original.as_bytes();
    let mut index = start;

    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t' | b':' | b'=' | b'\"' | b'\'')
    {
        index += 1;
    }

    let candidate: String = original[index..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .take(20)
        .collect();
    let candidate = candidate.trim_end_matches('.');
    parse_version(candidate).map(|_| candidate.to_string())
}

fn product_label(version: Option<&str>) -> String {
    version
        .map(|version| format!("GitLab {version}"))
        .unwrap_or_else(|| "GitLab".into())
}

fn finding(
    product: &str,
    service: &WebServiceFingerprint,
    managed_gitlab_com: bool,
) -> SecurityFinding {
    let endpoint = format!("{} service on port {}", service.scheme, service.port);

    if managed_gitlab_com {
        return SecurityFinding {
            id: "gitlab-com-managed-patched".into(),
            severity: "info".into(),
            title: "GitLab.com is vendor-managed and reported patched".into(),
            summary: "GitLab's October 21, 2026 advisory states that GitLab.com is already running the patched version for CVE-2026-110264.".into(),
            evidence: format!("{endpoint} was identified as GitLab.com."),
            remediation: "No self-managed GitLab patch action is indicated for GitLab.com. Continue normal account and access-security practices.".into(),
            cves: vec![CVE.into()],
        };
    }

    let version = product
        .strip_prefix("GitLab ")
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let Some(version) = version else {
        return SecurityFinding {
            id: "gitlab-rce-version-hidden".into(),
            severity: "high".into(),
            title: "GitLab detected; critical RCE patch level unknown".into(),
            summary: "This service appears to be GitLab, but it does not disclose a product version. A passive scan cannot determine whether the CVSS 10.0 GitLab RCE fix is installed.".into(),
            evidence: format!("{endpoint} returned GitLab-specific response indicators, but no reliable GitLab product version was exposed."),
            remediation: "Verify the GitLab version directly on the server and patch immediately if it is below the fixed release for its branch. Prefer the latest supported GitLab patch release.".into(),
            cves: vec![CVE.into()],
        };
    };

    match parse_version(version).map(classify).unwrap_or(PatchStatus::Unknown) {
        PatchStatus::Vulnerable => SecurityFinding {
            id: format!("gitlab-rce-{CVE}-{version}"),
            severity: "critical".into(),
            title: format!("GitLab {version} is affected by {CVE}"),
            summary: "The disclosed GitLab version falls in the affected range for a CVSS 10.0 unauthenticated remote-code-execution vulnerability in GitLab CE/EE.".into(),
            evidence: format!(
                "{endpoint} was identified as GitLab and disclosed version {version}."
            ),
            remediation: "Patch immediately to the latest supported GitLab patch release. Minimum fixed releases are 18.11.13, 19.0.10, 19.1.9, 19.2.9, 19.3.6, 19.4.3, and 19.5.1 for their respective branches.".into(),
            cves: vec![CVE.into()],
        },
        PatchStatus::Patched => SecurityFinding {
            id: format!("gitlab-rce-patched-{version}"),
            severity: "info".into(),
            title: format!("GitLab {version} includes the {CVE} fix"),
            summary: "The disclosed GitLab version is at or above the fixed patch level for its release branch.".into(),
            evidence: format!(
                "{endpoint} was identified as GitLab and disclosed version {version}."
            ),
            remediation: "No action is indicated for this CVE from the disclosed version. Continue normal GitLab patching and stay on the latest supported patch release.".into(),
            cves: vec![CVE.into()],
        },
        PatchStatus::Unknown => SecurityFinding {
            id: format!("gitlab-rce-unknown-{version}"),
            severity: "high".into(),
            title: format!("GitLab {version} requires manual {CVE} verification"),
            summary: "GitLab was identified, but the disclosed version is outside the release ranges EXP IP Scanner can safely classify from GitLab's published patch matrix.".into(),
            evidence: format!(
                "{endpoint} was identified as GitLab and disclosed version {version}."
            ),
            remediation: "Compare the installed version with GitLab's October 21, 2026 critical patch advisory and upgrade to a currently supported patch release.".into(),
            cves: vec![CVE.into()],
        },
    }
}

fn parse_version(version: &str) -> Option<(u16, u16, u16)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn classify((major, minor, patch): (u16, u16, u16)) -> PatchStatus {
    match major {
        0..=6 => PatchStatus::Unknown,
        7..=17 => PatchStatus::Vulnerable,
        18 => {
            if minor < 11 || (minor == 11 && patch < 13) {
                PatchStatus::Vulnerable
            } else {
                PatchStatus::Patched
            }
        }
        19 => {
            let fixed_patch = match minor {
                0 => 10,
                1 => 9,
                2 => 9,
                3 => 6,
                4 => 3,
                5 => 1,
                _ => return PatchStatus::Patched,
            };
            if patch < fixed_patch {
                PatchStatus::Vulnerable
            } else {
                PatchStatus::Patched
            }
        }
        _ => PatchStatus::Patched,
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
    let scheme_end = url.find("://")? + 3;
    let rest = &url[scheme_end..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(format!("{}{}", &url[..scheme_end], &rest[..authority_end]))
}

fn host_from_input(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let with_scheme = if trimmed.to_ascii_lowercase().starts_with("http://")
        || trimmed.to_ascii_lowercase().starts_with("https://")
    {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let origin = origin_url(&with_scheme)?;
    let authority = origin.split("://").nth(1)?;
    Some(authority.split(':').next()?.to_ascii_lowercase())
}

fn curl_binary() -> &'static str {
    if cfg!(windows) {
        "curl.exe"
    } else {
        "curl"
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_gitlab_header_and_login_page() {
        assert!(looks_like_gitlab(
            &[("x-gitlab-meta".into(), "{\"version\":\"1\"}".into())],
            ""
        ));
        assert!(looks_like_gitlab(
            &[],
            "<title>Sign in · GitLab</title><a href=\"/users/sign_in\">Sign in</a>"
        ));
        assert!(!looks_like_gitlab(
            &[],
            "<p>Our source code is mirrored on GitLab.</p>"
        ));
    }

    #[test]
    fn extracts_gitlab_version_json() {
        assert_eq!(
            extract_version("{\"version\":\"19.4.2-ee\",\"revision\":\"abc\",\"enterprise\":true}")
                .as_deref(),
            Some("19.4.2")
        );
    }

    #[test]
    fn classifies_published_patch_thresholds() {
        for (version, expected) in [
            ((18, 11, 12), PatchStatus::Vulnerable),
            ((18, 11, 13), PatchStatus::Patched),
            ((19, 0, 9), PatchStatus::Vulnerable),
            ((19, 0, 10), PatchStatus::Patched),
            ((19, 1, 8), PatchStatus::Vulnerable),
            ((19, 1, 9), PatchStatus::Patched),
            ((19, 2, 8), PatchStatus::Vulnerable),
            ((19, 2, 9), PatchStatus::Patched),
            ((19, 3, 5), PatchStatus::Vulnerable),
            ((19, 3, 6), PatchStatus::Patched),
            ((19, 4, 2), PatchStatus::Vulnerable),
            ((19, 4, 3), PatchStatus::Patched),
            ((19, 5, 0), PatchStatus::Vulnerable),
            ((19, 5, 1), PatchStatus::Patched),
        ] {
            assert_eq!(classify(version), expected);
        }
    }

    #[test]
    fn builds_website_urls_without_losing_hostname_or_path() {
        assert_eq!(
            url_for_service("portal.example.com/gitlab", "https"),
            "https://portal.example.com/gitlab"
        );
        assert_eq!(
            url_for_service("https://portal.example.com/login", "https"),
            "https://portal.example.com/login"
        );
    }
}

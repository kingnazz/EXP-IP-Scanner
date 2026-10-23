use super::{HeaderPairs, SecurityFinding, WebServiceFingerprint};

const CVE: &str = "CVE-2026-110264";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchStatus {
    Vulnerable,
    Patched,
    Unknown,
}

pub(super) fn product_label(headers: &HeaderPairs, body: &str) -> Option<String> {
    if !looks_like_gitlab(headers, body) {
        return None;
    }

    Some(match extract_version(body) {
        Some(version) => format!("GitLab {version}"),
        None => "GitLab".to_string(),
    })
}

pub(super) fn is_gitlab_product(product: &str) -> bool {
    product == "GitLab" || product.starts_with("GitLab ")
}

pub(super) fn finding(product: &str, service: &WebServiceFingerprint) -> SecurityFinding {
    let version = product.strip_prefix("GitLab ").map(str::trim).filter(|value| !value.is_empty());
    let endpoint = format!("{} service on port {}", service.scheme, service.port);

    match version.and_then(parse_version) {
        Some(parsed) if classify(parsed) == PatchStatus::Vulnerable => SecurityFinding {
            id: format!("gitlab-rce-{CVE}-{version}"),
            severity: "critical".into(),
            title: format!("GitLab {version} is affected by {CVE}"),
            summary: "The disclosed GitLab version falls in the affected range for a CVSS 10.0 unauthenticated remote-code-execution vulnerability in GitLab CE/EE.".into(),
            evidence: format!("{endpoint} was identified as GitLab and disclosed version {version}."),
            remediation: "Patch immediately to the latest supported GitLab patch release. Minimum fixed releases are 18.11.13, 19.0.10, 19.1.9, 19.2.9, 19.3.6, 19.4.3, and 19.5.1 for their respective branches.".into(),
            cves: vec![CVE.into()],
        },
        Some(parsed) if classify(parsed) == PatchStatus::Patched => SecurityFinding {
            id: format!("gitlab-rce-patched-{version}"),
            severity: "info".into(),
            title: format!("GitLab {version} includes the {CVE} fix"),
            summary: "The disclosed GitLab version is at or above the fixed patch level for its release branch.".into(),
            evidence: format!("{endpoint} was identified as GitLab and disclosed version {version}."),
            remediation: "No action is indicated for this CVE from the disclosed version. Continue normal GitLab patching and stay on the latest supported patch release.".into(),
            cves: vec![CVE.into()],
        },
        Some(_) => SecurityFinding {
            id: format!("gitlab-rce-unknown-{version}"),
            severity: "high".into(),
            title: format!("GitLab {version} requires manual {CVE} verification"),
            summary: "GitLab was identified, but the disclosed version is outside the release ranges EXP IP Scanner can safely classify from GitLab's published patch matrix.".into(),
            evidence: format!("{endpoint} was identified as GitLab and disclosed version {version}."),
            remediation: "Compare the installed version with GitLab's October 21, 2026 critical patch advisory and upgrade to a currently supported patch release.".into(),
            cves: vec![CVE.into()],
        },
        None => SecurityFinding {
            id: "gitlab-rce-version-hidden".into(),
            severity: "high".into(),
            title: "GitLab detected; critical RCE patch level unknown".into(),
            summary: "This service appears to be GitLab, but it does not disclose a product version. A passive scan cannot determine whether the CVSS 10.0 GitLab RCE fix is installed.".into(),
            evidence: format!("{endpoint} returned GitLab-specific response indicators, but no reliable GitLab product version was exposed."),
            remediation: "Verify the GitLab version directly on the server and patch immediately if it is below the fixed release for its branch. Prefer the latest supported GitLab patch release.".into(),
            cves: vec![CVE.into()],
        },
    }
}

fn looks_like_gitlab(headers: &HeaderPairs, body: &str) -> bool {
    let header_match = headers.iter().any(|(name, value)| {
        name == "x-gitlab-meta"
            || name.starts_with("x-gitlab-")
            || (name == "set-cookie" && value.to_ascii_lowercase().contains("_gitlab_session"))
    });
    if header_match {
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

    // The metadata/version API returns a compact JSON object containing both
    // `version` and `revision`. Only trust the generic JSON key when that
    // GitLab-specific shape is present.
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

    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t' | b':' | b'=' | b'\"' | b'\'') {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(values: &[(&str, &str)]) -> HeaderPairs {
        values
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn detects_gitlab_from_response_header() {
        let result = product_label(
            &headers(&[("x-gitlab-meta", "{\"correlation_id\":\"abc\",\"version\":\"1\"}")]),
            "<html></html>",
        );
        assert_eq!(result.as_deref(), Some("GitLab"));
    }

    #[test]
    fn detects_gitlab_login_page_without_false_positive_article_text() {
        assert_eq!(
            product_label(&Vec::new(), "<title>Sign in · GitLab</title><a href=\"/users/sign_in\">Sign in</a>")
                .as_deref(),
            Some("GitLab")
        );
        assert_eq!(
            product_label(&Vec::new(), "<p>Our source code is mirrored on GitLab.</p>"),
            None
        );
    }

    #[test]
    fn extracts_version_from_gitlab_metadata_json() {
        assert_eq!(
            product_label(
                &headers(&[("x-gitlab-meta", "{\"version\":\"1\"}")]),
                "{\"version\":\"19.4.2-ee\",\"revision\":\"abc\",\"enterprise\":true}",
            )
            .as_deref(),
            Some("GitLab 19.4.2")
        );
    }

    #[test]
    fn classifies_gitlab_patch_thresholds() {
        for (version, expected) in [
            ((18, 11, 12), PatchStatus::Vulnerable),
            ((18, 11, 13), PatchStatus::Patched),
            ((19, 0, 9), PatchStatus::Vulnerable),
            ((19, 0, 10), PatchStatus::Patched),
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
}
